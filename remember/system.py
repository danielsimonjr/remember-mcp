"""
Main RememberSystem - Hybrid memory manager
Integrates OpenMemory (active) with memvid (archive)
"""
import os
import time
import asyncio
from pathlib import Path
from typing import List, Optional, Dict, Any
from .types import (
    HybridMemoryResult,
    MemoryLocation,
    ArchiveStats,
    SystemStats
)

# Import OpenMemory (will be installed separately)
try:
    from openmemory import MemorySystem as OpenMemory
    from openmemory.types import MemoryResult
except ImportError:
    raise ImportError(
        "OpenMemory not found. Install with: pip install -e ../openmemory-python"
    )

# Import memvid
try:
    from memvid import MemvidEncoder, MemvidRetriever
except ImportError:
    raise ImportError(
        "Memvid not found. Install with: pip install memvid"
    )


class RememberSystem:
    """
    Hybrid memory system combining active (OpenMemory) and archive (memvid).

    Memory Lifecycle:
    1. New memories → Active storage (OpenMemory)
    2. Decay tracking → Salience decreases over time
    3. Archival → Low-salience memories → Video storage (memvid)
    4. Recall → Archived memories return to active when accessed
    """

    def __init__(
        self,
        active_db: str = "remember_active.db",
        archive_dir: str = "archives/",
        archive_threshold_days: int = 60,
        archive_min_salience: float = 0.2,
        auto_archive_enabled: bool = False
    ):
        """
        Initialize RememberSystem.

        Args:
            active_db: Path to active memory database
            archive_dir: Directory for archive videos
            archive_threshold_days: Days before memory eligible for archival
            archive_min_salience: Minimum salience to keep in active
            auto_archive_enabled: Enable automatic archival scheduler
        """
        self.active_db = active_db
        self.archive_dir = Path(archive_dir)
        self.archive_threshold_days = archive_threshold_days
        self.archive_min_salience = archive_min_salience
        self.auto_archive_enabled = auto_archive_enabled

        # Create archive directory
        self.archive_dir.mkdir(parents=True, exist_ok=True)

        # Initialize active memory (OpenMemory)
        self.active = OpenMemory(db_path=active_db)

        # Archive index: maps user_id → archive file info
        self.archive_index: Dict[str, Dict[str, Any]] = {}

        # Load existing archives
        self._load_archive_index()

    def _load_archive_index(self) -> None:
        """Load existing archive files"""
        for archive_file in self.archive_dir.glob("*.mp4"):
            # Parse filename: user_{user_id}_{timestamp}.mp4
            stem = archive_file.stem
            if stem.startswith("user_"):
                parts = stem.split("_")
                if len(parts) >= 3:
                    user_id = parts[1]
                    timestamp = parts[2]

                    if user_id not in self.archive_index:
                        self.archive_index[user_id] = {}

                    self.archive_index[user_id][timestamp] = {
                        "file": str(archive_file),
                        "index": str(archive_file.with_suffix(".json")),
                        "created_at": int(timestamp)
                    }

    async def add_memory(
        self,
        content: str,
        user_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Add a new memory to active storage.

        Args:
            content: Memory content
            user_id: Optional user ID
            tags: Optional tags
            metadata: Optional metadata

        Returns:
            Dict with memory ID and sector info
        """
        result = await self.active.add_memory(
            content=content,
            user_id=user_id,
            tags=tags,
            metadata=metadata
        )

        result["location"] = MemoryLocation.ACTIVE
        return result

    async def query(
        self,
        query: str,
        k: int = 10,
        user_id: Optional[str] = None,
        include_archive: bool = True,
        sectors: Optional[List[str]] = None
    ) -> List[HybridMemoryResult]:
        """
        Query memories across active and archive storage.

        Args:
            query: Query string
            k: Number of results
            user_id: Optional user filter
            include_archive: Whether to search archives
            sectors: Optional sector filter

        Returns:
            List of hybrid memory results
        """
        results: List[HybridMemoryResult] = []

        # Query active memories
        active_results = await self.active.query(
            query=query,
            k=k,
            user_id=user_id,
            sectors=sectors
        )

        # Convert to hybrid results
        for mem in active_results:
            results.append(HybridMemoryResult(
                id=mem.id,
                content=mem.content,
                score=mem.score,
                location=MemoryLocation.ACTIVE,
                sectors=mem.sectors,
                primary_sector=mem.primary_sector,
                salience=mem.salience,
                last_seen_at=mem.last_seen_at
            ))

        # Query archives if enabled
        if include_archive and user_id in self.archive_index:
            archive_results = await self._query_archives(
                query=query,
                user_id=user_id,
                k=k
            )
            results.extend(archive_results)

        # Sort by score
        results.sort(key=lambda x: x.score, reverse=True)

        # Return top K
        return results[:k]

    async def _query_archives(
        self,
        query: str,
        user_id: str,
        k: int
    ) -> List[HybridMemoryResult]:
        """Query archived memories for a user"""
        results = []

        # Get user's archives
        user_archives = self.archive_index.get(user_id, {})

        for timestamp, archive_info in user_archives.items():
            try:
                # Create retriever for this archive
                retriever = MemvidRetriever(
                    video_path=archive_info["file"],
                    index_path=archive_info["index"]
                )

                # Search archive
                archive_hits = retriever.search(query, top_k=k)

                # Convert to hybrid results
                for chunk, score in archive_hits:
                    results.append(HybridMemoryResult(
                        id=f"archive_{timestamp}_{hash(chunk)}",
                        content=chunk,
                        score=score * 0.8,  # Slight penalty for archived
                        location=MemoryLocation.ARCHIVE,
                        sectors=["semantic"],  # Archives don't preserve sectors
                        primary_sector="semantic",
                        salience=0.0,
                        last_seen_at=archive_info["created_at"],
                        archived_at=archive_info["created_at"],
                        archive_file=archive_info["file"]
                    ))

            except Exception as e:
                print(f"Error querying archive {archive_info['file']}: {e}")
                continue

        return results

    async def archive_old_memories(
        self,
        age_days: Optional[int] = None,
        min_salience: Optional[float] = None,
        user_id: Optional[str] = None
    ) -> ArchiveStats:
        """
        Archive old/decayed memories to video format.

        Args:
            age_days: Minimum age in days (default: system threshold)
            min_salience: Maximum salience to archive (default: system threshold)
            user_id: Optional user filter

        Returns:
            Archive statistics
        """
        age_days = age_days or self.archive_threshold_days
        min_salience = min_salience or self.archive_min_salience

        # Calculate age threshold in milliseconds (database uses ms timestamps)
        age_threshold_ms = int(time.time() * 1000) - (age_days * 24 * 60 * 60 * 1000)

        # Query for eligible memories
        if user_id:
            query = """
                SELECT * FROM memories
                WHERE user_id = ? AND created_at <= ? AND salience < ?
                ORDER BY salience ASC, created_at ASC
            """
            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute,
                query,
                (user_id, age_threshold_ms, min_salience)
            )
        else:
            query = """
                SELECT * FROM memories
                WHERE created_at <= ? AND salience < ?
                ORDER BY salience ASC, created_at ASC
            """
            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute,
                query,
                (age_threshold_ms, min_salience)
            )

        rows = await asyncio.to_thread(cursor.fetchall)
        eligible_memories = [dict(row) for row in rows]

        if not eligible_memories:
            # Count active memories even when nothing to archive
            if user_id:
                cursor = await asyncio.to_thread(
                    self.active.storage.conn.execute,
                    "SELECT COUNT(*) as count FROM memories WHERE user_id = ?",
                    (user_id,)
                )
            else:
                cursor = await asyncio.to_thread(
                    self.active.storage.conn.execute,
                    "SELECT COUNT(*) as count FROM memories"
                )
            row = await asyncio.to_thread(cursor.fetchone)
            active_remaining = row['count'] if row else 0
            
            return ArchiveStats(
                archived_count=0,
                active_remaining=active_remaining,
                archive_size_bytes=0,
                compression_ratio=1.0
            )

        # Create archive video
        timestamp = int(time.time())
        archive_filename = f"user_{user_id or 'default'}_{timestamp}"
        video_path = self.archive_dir / f"{archive_filename}.mp4"
        index_path = self.archive_dir / f"{archive_filename}.json"

        # Encode to video using memvid
        try:
            encoder = MemvidEncoder()
            encoder.add_chunks([mem['content'] for mem in eligible_memories])
            encoder.build_video(str(video_path), str(index_path))
        except Exception as e:
            print(f"ERROR: Memvid encoding failed: {e}")
            import traceback
            traceback.print_exc()
            # Return early if encoding fails
            if user_id:
                cursor = await asyncio.to_thread(
                    self.active.storage.conn.execute,
                    "SELECT COUNT(*) as count FROM memories WHERE user_id = ?",
                    (user_id,)
                )
            else:
                cursor = await asyncio.to_thread(
                    self.active.storage.conn.execute,
                    "SELECT COUNT(*) as count FROM memories"
                )
            row = await asyncio.to_thread(cursor.fetchone)
            active_remaining = row['count'] if row else 0
            
            return ArchiveStats(
                archived_count=0,
                active_remaining=active_remaining,
                archive_size_bytes=0,
                compression_ratio=1.0
            )

        # Update archive index
        if user_id:
            if user_id not in self.archive_index:
                self.archive_index[user_id] = {}

            self.archive_index[user_id][str(timestamp)] = {
                "file": str(video_path),
                "index": str(index_path),
                "created_at": timestamp
            }

        # Remove from active storage
        memory_ids = [mem['id'] for mem in eligible_memories]
        placeholders = ','.join('?' * len(memory_ids))
        delete_query = f"DELETE FROM memories WHERE id IN ({placeholders})"
        await asyncio.to_thread(
            self.active.storage.conn.execute,
            delete_query,
            memory_ids
        )
        await asyncio.to_thread(self.active.storage.conn.commit)

        archive_size = video_path.stat().st_size
        original_size = sum(len(mem['content']) for mem in eligible_memories)
        compression_ratio = original_size / archive_size if archive_size > 0 else 1.0

        # Count remaining active memories
        if user_id:
            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute,
                "SELECT COUNT(*) as count FROM memories WHERE user_id = ?",
                (user_id,)
            )
        else:
            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute,
                "SELECT COUNT(*) as count FROM memories"
            )
        row = await asyncio.to_thread(cursor.fetchone)
        active_remaining = row['count'] if row else 0

        return ArchiveStats(
            archived_count=len(eligible_memories),
            active_remaining=active_remaining,
            archive_size_bytes=archive_size,
            compression_ratio=compression_ratio
        )

    async def recall_from_archive(
        self,
        archive_file: str,
        content: str,
        user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Recall a memory from archive back to active storage.

        Args:
            archive_file: Archive filename
            content: Memory content to recall
            user_id: Optional user ID

        Returns:
            New memory info in active storage
        """
        # Add back to active memory
        result = await self.add_memory(
            content=content,
            user_id=user_id,
            metadata={"recalled_from": archive_file}
        )

        return result

    async def get_stats(self, user_id: Optional[str] = None) -> SystemStats:
        """
        Get system statistics.

        Args:
            user_id: Optional user filter

        Returns:
            System statistics
        """
        # Count active memories from database
        if user_id:
            count_query = "SELECT COUNT(*) as count FROM memories WHERE user_id = ?"
            avg_query = "SELECT AVG(salience) as avg FROM memories WHERE user_id = ?"
            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute, count_query, (user_id,)
            )
            row = await asyncio.to_thread(cursor.fetchone)
            active_count = row['count'] if row else 0

            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute, avg_query, (user_id,)
            )
            row = await asyncio.to_thread(cursor.fetchone)
            avg_salience = row['avg'] if row and row['avg'] is not None else 0.0
        else:
            count_query = "SELECT COUNT(*) as count FROM memories"
            avg_query = "SELECT AVG(salience) as avg FROM memories"
            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute, count_query
            )
            row = await asyncio.to_thread(cursor.fetchone)
            active_count = row['count'] if row else 0

            cursor = await asyncio.to_thread(
                self.active.storage.conn.execute, avg_query
            )
            row = await asyncio.to_thread(cursor.fetchone)
            avg_salience = row['avg'] if row and row['avg'] is not None else 0.0

        # Count archived memories
        archive_count = 0
        archive_size = 0

        if user_id:
            user_archives = self.archive_index.get(user_id, {})
            archive_count = len(user_archives)
            for archive_info in user_archives.values():
                try:
                    archive_size += Path(archive_info["file"]).stat().st_size
                except:
                    pass
        else:
            for user_archives in self.archive_index.values():
                archive_count += len(user_archives)
                for archive_info in user_archives.values():
                    try:
                        archive_size += Path(archive_info["file"]).stat().st_size
                    except:
                        pass

        # Get active DB size
        active_db_size = 0
        if Path(self.active_db).exists():
            active_db_size = Path(self.active_db).stat().st_size

        total_size = active_db_size + archive_size
        compression_ratio = total_size / active_db_size if active_db_size > 0 else 1.0

        return SystemStats(
            active_count=active_count,
            archive_count=archive_count,
            total_memories=active_count + archive_count,
            active_db_size=active_db_size,
            archive_size=archive_size,
            total_size=total_size,
            compression_ratio=compression_ratio,
            avg_salience=avg_salience
        )

    def close(self) -> None:
        """Close system and cleanup"""
        self.active.close()
