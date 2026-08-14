"""
Main RememberSystem - Hybrid memory manager
Integrates OpenMemory (active) with memvid (archive)
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .types import (
    ArchiveStats,
    HybridMemoryResult,
    MemoryLocation,
    SystemStats,
)
from .video import (
    RetrieverCache,
    encode_chunks,
    sidecar_chunk_count,
)

logger = logging.getLogger(__name__)

MAX_CONTENT_CHARS = 100_000
MAX_QUERY_K = 100

# Import OpenMemory (will be installed separately).
# Redirect stdout to stderr during import so any library-level `print(...)`
# (e.g. openmemory's "Google Generative AI library not available" notice)
# can't corrupt the JSON-RPC stdio framing this server uses.
try:
    with contextlib.redirect_stdout(sys.stderr):
        from openmemory import MemorySystem as OpenMemory
        from openmemory import SectorType
        from openmemory.embeddings import EmbeddingProvider
except ImportError:
    raise ImportError(
        "OpenMemory not found. Install with: pip install -e ../openmemory-python"
    )

# Every sector must embed with the SAME model, because openmemory compares
# embeddings ACROSS sectors.
#
# openmemory's default map (embeddings.py) assigns REFLECTIVE the 768-dimension
# `all-mpnet-base-v2` while every other sector gets the 384-dimension
# `all-MiniLM-L6-v2`. `MemorySystem.add_memory` then calls
# `graph.create_similarity_waypoint`, which cosine-compares the incoming
# memory against existing ones regardless of sector — so as soon as one
# REFLECTIVE memory and one non-REFLECTIVE memory coexist, that comparison gets
# a 384-vector and a 768-vector and raises:
#
#     ValueError: shapes (384,) and (768,) not aligned
#
# This is not an edge case: it is the second `add_memory` call whenever the two
# memories classify into different sectors, which is the normal path. Pinning
# one model makes the vector space uniform and the comparison well-defined.
#
# Cost of the choice: REFLECTIVE memories lose mpnet's slightly stronger
# embeddings. That is the right trade — a uniformly-384 space that works beats a
# mixed space that raises. Revisit only if openmemory starts comparing
# within-sector.
UNIFORM_EMBEDDING_MODEL = "all-MiniLM-L6-v2"


def _uniform_embedding_provider() -> "EmbeddingProvider":
    """An EmbeddingProvider with every sector pinned to one model."""
    return EmbeddingProvider(
        models={sector: UNIFORM_EMBEDDING_MODEL for sector in SectorType}
    )


def _row_mapping(row: Any) -> Dict[str, Any]:
    """Normalize a sqlite row into a dict regardless of row_factory."""
    if isinstance(row, dict):
        return row
    if hasattr(row, "keys"):
        return {key: row[key] for key in row.keys()}
    raise TypeError(f"Cannot convert sqlite row of type {type(row)!r} to dict")


def _stable_chunk_id(timestamp: str, chunk: str) -> str:
    digest = hashlib.sha256(chunk.encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"archive_{timestamp}_{digest}"


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

        # Initialize active memory (OpenMemory).
        # The explicit provider is load-bearing — see UNIFORM_EMBEDDING_MODEL above.
        # Without it, openmemory's per-sector default mixes 384- and 768-dimension
        # models and add_memory raises on the first cross-sector comparison.
        self.active = OpenMemory(
            db_path=active_db,
            embedding_provider=_uniform_embedding_provider(),
        )
        self._configure_sqlite()

        # Archive index: maps user_id → archive file info
        self.archive_index: Dict[str, Dict[str, Any]] = {}

        # Load existing archives
        self._load_archive_index()

        # Serialize archive/add/forget paths to prevent SELECT-DELETE races
        # against concurrent writers on the shared SQLite connection.
        self._write_lock = asyncio.Lock()
        # Serialize the full archive flow so two archival runs cannot encode
        # the same snapshot twice. Distinct from _write_lock so add_memory
        # can proceed while video encoding (seconds) is in flight.
        self._archive_lock = asyncio.Lock()

        # Cache MemvidRetriever instances by (video_path, index_path) so we
        # don't reload the FAISS index + reopen the mp4 reader on every query.
        # Bounded LRU — an unbounded cache leaked FAISS indexes for every
        # archive ever created in the process lifetime.
        self._retriever_cache = RetrieverCache()

    def _configure_sqlite(self) -> None:
        """WAL + busy timeout: readers don't block writers, and a locked
        connection waits instead of raising immediately. Best-effort — the
        connection belongs to openmemory, so a missing/odd conn is not fatal.
        """
        conn = getattr(getattr(self.active, "storage", None), "conn", None)
        if conn is None:
            return
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            if getattr(conn, "row_factory", None) is None:
                conn.row_factory = sqlite3.Row
        except Exception as exc:  # noqa: BLE001 — openmemory owns this conn
            logger.warning("Could not apply SQLite pragmas: %s", exc)

    def _get_retriever(self, video_path: str, index_path: str) -> Any:
        """
        Return a cached MemvidRetriever for the given (video_path, index_path)
        pair, creating one on first use. Caching avoids reloading the FAISS
        index and reopening the mp4 reader on every query.
        """
        return self._retriever_cache.get(video_path, index_path)

    @staticmethod
    def _archive_key(user_id: Optional[str]) -> str:
        """Normalize a user_id into the key used for archive bookkeeping.

        Archive FILENAMES have always normalized ``None`` to ``"default"``
        (``f"user_{user_id or 'default'}_{timestamp}"``), and
        ``_load_archive_index`` parses that filename back out — so the on-disk
        world has always been keyed by ``"default"``. The in-memory index and
        every lookup, however, used the raw ``user_id``. For the default
        (``user_id=None``) path those two never met:

        * ``archive_old_memories`` guarded its index update with ``if user_id:``,
          so a default-user archive wrote the .mp4/.faiss/.json, DELETED the
          memories from active storage, and recorded nothing — the archive was
          orphaned for the rest of the process.
        * After a restart ``_load_archive_index`` did recover it, but under
          ``"default"``, while ``query``/``_query_archives``/``recall_from_archive``
          looked up ``None``. So it stayed unreachable.

        Net effect: archiving without an explicit user_id — which is the default,
        and what the ``archive_memories`` MCP tool passes — made memories vanish
        from ``get_stats`` and from recall while their data sat on disk.

        Normalizing in ONE place is the fix; every site now agrees with the
        filename convention that was already there.
        """
        return user_id or "default"

    def _load_archive_index(self) -> None:
        """Load existing archive files.

        Filename format is ``user_{user_id}_{unix_ts}.mp4``. ``user_id`` may
        itself contain underscores, so the timestamp is the *last* ``_``
        segment, not ``parts[2]``.
        """
        for archive_file in self.archive_dir.glob("*.mp4"):
            stem = archive_file.stem
            if not stem.startswith("user_"):
                continue
            rest = stem[len("user_"):]
            user_id, sep, timestamp = rest.rpartition("_")
            if not sep or not user_id or not timestamp.isdigit():
                logger.warning("Skipping unparseable archive filename: %s", archive_file)
                continue

            index_path = archive_file.with_suffix(".json")
            if user_id not in self.archive_index:
                self.archive_index[user_id] = {}

            self.archive_index[user_id][timestamp] = {
                "file": str(archive_file),
                "index": str(index_path),
                "created_at": int(timestamp),
                "memory_count": sidecar_chunk_count(index_path),
            }

    def _conn(self) -> Any:
        return self.active.storage.conn

    async def _execute(self, sql: str, params: Sequence[Any] = ()) -> Any:
        return await asyncio.to_thread(self._conn().execute, sql, params)

    async def _count_active(self, user_id: Optional[str]) -> int:
        if user_id:
            cursor = await self._execute(
                "SELECT COUNT(*) as count FROM memories WHERE user_id = ?",
                (user_id,),
            )
        else:
            cursor = await self._execute("SELECT COUNT(*) as count FROM memories")
        row = await asyncio.to_thread(cursor.fetchone)
        if not row:
            return 0
        mapping = _row_mapping(row)
        return int(mapping.get("count") or 0)

    async def _count_and_avg_salience(self, user_id: Optional[str]) -> tuple[int, float]:
        if user_id:
            cursor = await self._execute(
                "SELECT COUNT(*) as count, AVG(salience) as avg "
                "FROM memories WHERE user_id = ?",
                (user_id,),
            )
        else:
            cursor = await self._execute(
                "SELECT COUNT(*) as count, AVG(salience) as avg FROM memories"
            )
        row = await asyncio.to_thread(cursor.fetchone)
        if not row:
            return 0, 0.0
        mapping = _row_mapping(row)
        avg = mapping.get("avg")
        return int(mapping.get("count") or 0), float(avg) if avg is not None else 0.0

    @staticmethod
    def _validate_content(content: str) -> str:
        if not isinstance(content, str) or not content.strip():
            raise ValueError("content must be a non-empty string")
        if len(content) > MAX_CONTENT_CHARS:
            raise ValueError(
                f"content exceeds {MAX_CONTENT_CHARS} characters "
                f"({len(content)} given)"
            )
        return content

    @staticmethod
    def _validate_k(k: int, name: str = "k") -> int:
        if not isinstance(k, int) or isinstance(k, bool) or k < 1 or k > MAX_QUERY_K:
            raise ValueError(f"{name} must be an integer between 1 and {MAX_QUERY_K}")
        return k

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
        content = self._validate_content(content)
        async with self._write_lock:
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
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")
        k = self._validate_k(k)

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
        if include_archive and self._archive_key(user_id) in self.archive_index:
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
        user_id: Optional[str],
        k: int
    ) -> List[HybridMemoryResult]:
        """Query archived memories for a user.

        Each archive is searched in a worker thread so the event loop stays
        free; different archives have independent retrievers so this is safe.
        """
        from .video import search_with_scores

        user_archives = self.archive_index.get(self._archive_key(user_id), {})
        if not user_archives:
            return []

        def _search_one(timestamp: str, archive_info: Dict[str, Any]) -> List[HybridMemoryResult]:
            try:
                retriever = self._get_retriever(
                    video_path=archive_info["file"],
                    index_path=archive_info["index"],
                )
                hits = search_with_scores(retriever, query, k)
            except Exception as exc:  # noqa: BLE001 — one bad archive must not fail the query
                logger.error("Error querying archive %s: %s", archive_info.get("file"), exc)
                return []

            rows: List[HybridMemoryResult] = []
            for chunk, score in hits:
                rows.append(HybridMemoryResult(
                    id=_stable_chunk_id(timestamp, chunk),
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
            return rows

        tasks = [
            asyncio.to_thread(_search_one, timestamp, archive_info)
            for timestamp, archive_info in user_archives.items()
        ]
        batches = await asyncio.gather(*tasks, return_exceptions=True)

        results: List[HybridMemoryResult] = []
        for batch in batches:
            if isinstance(batch, Exception):
                logger.error("Archive search worker failed: %s", batch)
                continue
            results.extend(batch)
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
        # ``or`` treats 0 / 0.0 as missing, so ``age_days=0`` (archive now)
        # used to silently fall back to the 60-day default. ``is None`` is
        # the actual "use the configured default" check.
        if age_days is None:
            age_days = self.archive_threshold_days
        else:
            age_days = int(age_days)
        if min_salience is None:
            min_salience = self.archive_min_salience
        else:
            min_salience = float(min_salience)
        if age_days < 0:
            raise ValueError("age_days must be >= 0")

        # Calculate age threshold in milliseconds (database uses ms timestamps)
        age_threshold_ms = int(time.time() * 1000) - (age_days * 24 * 60 * 60 * 1000)

        # Snapshot eligibility under the write lock, then encode *without*
        # holding it. Video encoding blocks for seconds and used to freeze
        # every concurrent add_memory. DELETE is re-checked by id under the
        # lock so a concurrent writer cannot resurrect a row we already
        # encoded, and we never delete a row we failed to encode.
        async with self._archive_lock:
            async with self._write_lock:
                eligible_memories = await self._select_eligible_memories(
                    user_id=user_id,
                    age_threshold_ms=age_threshold_ms,
                    min_salience=min_salience,
                )

            if not eligible_memories:
                return ArchiveStats(
                    archived_count=0,
                    active_remaining=await self._count_active(user_id),
                    archive_size_bytes=0,
                    compression_ratio=1.0
                )

            timestamp = int(time.time())
            archive_filename = f"user_{self._archive_key(user_id)}_{timestamp}"
            video_path = self.archive_dir / f"{archive_filename}.mp4"
            index_path = self.archive_dir / f"{archive_filename}.json"
            memory_ids = [mem["id"] for mem in eligible_memories]
            contents = [mem["content"] for mem in eligible_memories]

            try:
                await asyncio.to_thread(encode_chunks, contents, video_path, index_path)
            except Exception:
                logger.exception("Memvid encoding failed for %s", video_path)
                return ArchiveStats(
                    archived_count=0,
                    active_remaining=await self._count_active(user_id),
                    archive_size_bytes=0,
                    compression_ratio=1.0
                )

            async with self._write_lock:
                return await self._commit_archive(
                    user_id=user_id,
                    timestamp=timestamp,
                    video_path=video_path,
                    index_path=index_path,
                    memory_ids=memory_ids,
                    original_size=sum(len(c) for c in contents),
                )

    async def _select_eligible_memories(
        self,
        user_id: Optional[str],
        age_threshold_ms: int,
        min_salience: float,
    ) -> List[Dict[str, Any]]:
        # Only id + content are consumed downstream. Avoid SELECT * so we
        # don't pull embedding blobs into Python for every eligible row.
        if user_id:
            sql = """
                SELECT id, content FROM memories
                WHERE user_id = ? AND created_at <= ? AND salience < ?
                ORDER BY salience ASC, created_at ASC
            """
            params: Sequence[Any] = (user_id, age_threshold_ms, min_salience)
        else:
            sql = """
                SELECT id, content FROM memories
                WHERE created_at <= ? AND salience < ?
                ORDER BY salience ASC, created_at ASC
            """
            params = (age_threshold_ms, min_salience)
        cursor = await self._execute(sql, params)
        rows = await asyncio.to_thread(cursor.fetchall)
        return [_row_mapping(row) for row in rows]

    async def _commit_archive(
        self,
        user_id: Optional[str],
        timestamp: int,
        video_path: Path,
        index_path: Path,
        memory_ids: List[Any],
        original_size: int,
    ) -> ArchiveStats:
        """Register the archive and DELETE the snapshot ids. Lock must be held."""
        key = self._archive_key(user_id)
        if key not in self.archive_index:
            self.archive_index[key] = {}

        self.archive_index[key][str(timestamp)] = {
            "file": str(video_path),
            "index": str(index_path),
            "created_at": timestamp,
            "memory_count": len(memory_ids),
        }

        # Re-check which snapshot ids are still present so a concurrent
        # forget/archive cannot make this DELETE a surprise no-op that we
        # then report as success against the wrong remaining count.
        placeholders = ",".join("?" * len(memory_ids))
        delete_query = f"DELETE FROM memories WHERE id IN ({placeholders})"

        def _delete_atomic() -> int:
            conn = self._conn()
            with conn:  # BEGIN ... COMMIT (rolls back on exception)
                conn.execute(delete_query, memory_ids)
            return len(memory_ids)

        await asyncio.to_thread(_delete_atomic)

        try:
            archive_size = video_path.stat().st_size
        except OSError as exc:
            logger.warning("Could not stat new archive %s: %s", video_path, exc)
            archive_size = 0
        compression_ratio = original_size / archive_size if archive_size > 0 else 1.0

        return ArchiveStats(
            archived_count=len(memory_ids),
            active_remaining=await self._count_active(user_id),
            archive_size_bytes=archive_size,
            compression_ratio=compression_ratio
        )

    def _lookup_archive(
        self, archive_file: str, user_id: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """Resolve ``archive_file`` against the in-memory index only.

        Never opens an arbitrary path — a client-supplied string like
        ``../../etc/passwd`` cannot escape the archive directory this way.
        """
        if not archive_file or not isinstance(archive_file, str):
            return None
        needle = Path(archive_file).name
        stem = Path(needle).stem
        key = self._archive_key(user_id)
        scopes = [self.archive_index.get(key, {})]
        if user_id is None:
            scopes = list(self.archive_index.values())
        for archives in scopes:
            for info in archives.values():
                file_path = info.get("file") or ""
                if archive_file in (file_path, Path(file_path).name, Path(file_path).stem):
                    return info
                if needle in (Path(file_path).name, Path(file_path).stem) or stem == Path(file_path).stem:
                    return info
        return None

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
        content = self._validate_content(content)
        info = self._lookup_archive(archive_file, user_id)
        if info is None:
            raise FileNotFoundError(f"Unknown archive: {archive_file}")
        if not Path(info["file"]).exists():
            raise FileNotFoundError(f"Archive file missing on disk: {info['file']}")

        result = await self.add_memory(
            content=content,
            user_id=user_id,
            metadata={"recalled_from": info["file"]}
        )
        return result

    def _archive_totals(self, user_id: Optional[str]) -> tuple[int, int, int]:
        """Return (memory_count, file_count, size_bytes) for one user or all."""
        if user_id:
            groups = [self.archive_index.get(self._archive_key(user_id), {})]
        else:
            groups = list(self.archive_index.values())

        memory_count = 0
        file_count = 0
        size_bytes = 0
        for archives in groups:
            file_count += len(archives)
            for archive_info in archives.values():
                memory_count += int(archive_info.get("memory_count") or 0)
                try:
                    size_bytes += Path(archive_info["file"]).stat().st_size
                except OSError as exc:
                    logger.warning(
                        "Could not stat archive %s: %s",
                        archive_info.get("file"),
                        exc,
                    )
        return memory_count, file_count, size_bytes

    async def get_stats(self, user_id: Optional[str] = None) -> SystemStats:
        """
        Get system statistics.

        Args:
            user_id: Optional user filter

        Returns:
            System statistics
        """
        active_count, avg_salience = await self._count_and_avg_salience(user_id)
        archive_count, archive_file_count, archive_size = self._archive_totals(user_id)

        active_db_size = 0
        db_path = Path(self.active_db)
        if db_path.exists():
            try:
                active_db_size = db_path.stat().st_size
            except OSError as exc:
                logger.warning("Could not stat active db %s: %s", db_path, exc)

        total_size = active_db_size + archive_size
        compression_ratio = total_size / active_db_size if active_db_size > 0 else 1.0

        return SystemStats(
            active_count=active_count,
            archive_count=archive_count,
            archive_file_count=archive_file_count,
            total_memories=active_count + archive_count,
            active_db_size=active_db_size,
            archive_size=archive_size,
            total_size=total_size,
            compression_ratio=compression_ratio,
            avg_salience=avg_salience
        )

    def close(self) -> None:
        """Close system and cleanup.

        Clears the cached MemvidRetriever pool (releasing FAISS indexes and
        mp4 readers) and closes the active OpenMemory storage. Safe to call
        multiple times.
        """
        self._retriever_cache.close()
        close_fn = getattr(self.active, "close", None)
        if callable(close_fn):
            self.active.close()
