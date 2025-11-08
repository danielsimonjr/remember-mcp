"""
File Indexer for remember-mcp
Extends memvid to support file indexing with metadata tracking
"""
import os
import json
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime

try:
    from memvid import MemvidEncoder, MemvidRetriever
except ImportError:
    raise ImportError("memvid not found. Install with: pip install memvid")


class FileIndexer:
    """
    File indexing system using memvid for QR-encoded video storage.

    Features:
    - Index individual files (text, PDF, EPUB, markdown)
    - Bulk directory indexing with glob patterns
    - File metadata tracking (path, hash, timestamps, chunk positions)
    - Line number preservation for code files
    - Semantic search across indexed files
    """

    def __init__(self, index_dir: str = "file_index/"):
        """
        Initialize FileIndexer

        Args:
            index_dir: Directory for file index storage
        """
        self.index_dir = Path(index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)

        # File metadata database: maps file_hash -> metadata
        self.metadata_file = self.index_dir / "file_metadata.json"
        self.metadata: Dict[str, Dict[str, Any]] = self._load_metadata()

        # Master index for all files
        self.master_video = self.index_dir / "master_index.mp4"
        self.master_index = self.index_dir / "master_index.json"

    def _load_metadata(self) -> Dict[str, Dict[str, Any]]:
        """Load file metadata from disk"""
        if self.metadata_file.exists():
            with open(self.metadata_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}

    def _save_metadata(self) -> None:
        """Save file metadata to disk"""
        with open(self.metadata_file, 'w', encoding='utf-8') as f:
            json.dump(self.metadata, f, indent=2)

    def _compute_file_hash(self, file_path: str) -> str:
        """Compute SHA256 hash of file"""
        sha256 = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha256.update(chunk)
        return sha256.hexdigest()

    def _get_file_type(self, file_path: str) -> str:
        """Determine file type from extension"""
        ext = Path(file_path).suffix.lower()
        type_map = {
            '.py': 'python',
            '.js': 'javascript',
            '.ts': 'typescript',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'header',
            '.md': 'markdown',
            '.txt': 'text',
            '.pdf': 'pdf',
            '.epub': 'epub',
            '.html': 'html',
            '.css': 'css',
            '.json': 'json',
            '.xml': 'xml',
            '.yaml': 'yaml',
            '.yml': 'yaml',
        }
        return type_map.get(ext, 'unknown')

    def index_file(
        self,
        file_path: str,
        chunk_size: int = 1024,
        overlap: int = 128,
        preserve_lines: bool = True
    ) -> Dict[str, Any]:
        """
        Index a single file into the video-encoded archive

        Args:
            file_path: Path to file to index
            chunk_size: Size of text chunks
            overlap: Overlap between chunks
            preserve_lines: Preserve line numbers for code files

        Returns:
            Dictionary with indexing stats and metadata
        """
        file_path = os.path.abspath(file_path)

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        # Compute file hash
        file_hash = self._compute_file_hash(file_path)
        file_type = self._get_file_type(file_path)
        file_size = os.path.getsize(file_path)

        # Check if already indexed
        if file_hash in self.metadata:
            existing = self.metadata[file_hash]
            if existing['file_path'] == file_path:
                return {
                    "status": "already_indexed",
                    "file_path": file_path,
                    "file_hash": file_hash,
                    "indexed_at": existing['indexed_at']
                }

        # Create encoder
        encoder = MemvidEncoder()

        # Add file content based on type
        chunks_meta = []

        if file_type == 'pdf':
            encoder.add_pdf(file_path, chunk_size=chunk_size, overlap=overlap)
            # For PDFs, chunks are created by memvid
            chunk_count = len(encoder.chunks)

        elif file_type == 'epub':
            encoder.add_epub(file_path, chunk_size=chunk_size, overlap=overlap)
            chunk_count = len(encoder.chunks)

        else:
            # Text-based files: read and optionally preserve line numbers
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()

            if preserve_lines and file_type in ['python', 'javascript', 'typescript', 'java', 'cpp', 'c']:
                # Add line numbers to chunks for code files
                lines = content.split('\n')
                chunks_with_lines = []

                for i in range(0, len(lines), chunk_size // 50):  # Approx 50 chars per line
                    chunk_lines = lines[i:i + (chunk_size // 50)]
                    start_line = i + 1
                    end_line = min(i + len(chunk_lines), len(lines))

                    # Format: [file:start-end]\n<content>
                    chunk_text = f"[{Path(file_path).name}:{start_line}-{end_line}]\n"
                    chunk_text += '\n'.join(chunk_lines)

                    chunks_with_lines.append(chunk_text)
                    chunks_meta.append({
                        "start_line": start_line,
                        "end_line": end_line,
                        "char_start": sum(len(l) + 1 for l in lines[:i]),
                        "char_end": sum(len(l) + 1 for l in lines[:end_line])
                    })

                encoder.add_chunks(chunks_with_lines)
                chunk_count = len(chunks_with_lines)
            else:
                # Regular text chunking
                encoder.add_text(content, chunk_size=chunk_size, overlap=overlap)
                chunk_count = len(encoder.chunks)

        # Build video for this file
        video_path = self.index_dir / f"{file_hash}.mp4"
        index_path = self.index_dir / f"{file_hash}.json"

        stats = encoder.build_video(
            output_file=str(video_path),
            index_file=str(index_path),
            show_progress=False
        )

        # Store metadata
        metadata = {
            "file_path": file_path,
            "file_name": os.path.basename(file_path),
            "file_hash": file_hash,
            "file_type": file_type,
            "file_size": file_size,
            "chunk_count": chunk_count,
            "chunk_size": chunk_size,
            "overlap": overlap,
            "video_path": str(video_path),
            "index_path": str(index_path),
            "chunks_meta": chunks_meta if chunks_meta else None,
            "indexed_at": datetime.now().isoformat(),
            "stats": stats
        }

        self.metadata[file_hash] = metadata
        self._save_metadata()

        return {
            "status": "indexed",
            "file_path": file_path,
            "file_hash": file_hash,
            "chunk_count": chunk_count,
            "video_size": stats.get('video_size', 0),
            "compression_ratio": stats.get('compression_ratio', 0)
        }

    def index_directory(
        self,
        dir_path: str,
        pattern: str = "**/*",
        exclude: Optional[List[str]] = None,
        chunk_size: int = 1024,
        overlap: int = 128
    ) -> Dict[str, Any]:
        """
        Index all files in a directory matching a pattern

        Args:
            dir_path: Directory to index
            pattern: Glob pattern (e.g., "**/*.py")
            exclude: List of patterns to exclude
            chunk_size: Chunk size for text
            overlap: Overlap between chunks

        Returns:
            Summary of indexing operation
        """
        dir_path = Path(dir_path)
        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {dir_path}")

        exclude = exclude or []
        exclude_patterns = ['.git', '__pycache__', 'node_modules', '.pyc', '.mp4', '.mp3']
        exclude.extend(exclude_patterns)

        indexed = []
        skipped = []
        errors = []

        for file_path in dir_path.glob(pattern):
            if not file_path.is_file():
                continue

            # Check exclusions
            if any(excl in str(file_path) for excl in exclude):
                skipped.append(str(file_path))
                continue

            try:
                result = self.index_file(
                    str(file_path),
                    chunk_size=chunk_size,
                    overlap=overlap
                )
                indexed.append(result)
            except Exception as e:
                errors.append({"file": str(file_path), "error": str(e)})

        return {
            "indexed_count": len(indexed),
            "skipped_count": len(skipped),
            "error_count": len(errors),
            "indexed_files": indexed,
            "errors": errors
        }

    def search(
        self,
        query: str,
        top_k: int = 10,
        file_filter: Optional[str] = None,
        file_type_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Search across all indexed files

        Args:
            query: Search query
            top_k: Number of results to return
            file_filter: Filter by file path pattern
            file_type_filter: Filter by file type (e.g., 'python', 'pdf')

        Returns:
            List of search results with file metadata
        """
        results = []

        # Search each indexed file
        for file_hash, meta in self.metadata.items():
            # Apply filters
            if file_filter and file_filter not in meta['file_path']:
                continue
            if file_type_filter and meta['file_type'] != file_type_filter:
                continue

            video_path = meta['video_path']
            index_path = meta['index_path']

            if not os.path.exists(video_path) or not os.path.exists(index_path):
                continue

            try:
                # Search this file's archive
                retriever = MemvidRetriever(
                    video_file=video_path,
                    index_file=index_path
                )

                hits = retriever.search(query, top_k=top_k)

                # Add file metadata to results
                # Note: memvid search returns List[str], not List[Tuple[str, float]]
                for idx, chunk in enumerate(hits):
                    # Estimate score based on ranking (higher rank = higher score)
                    estimated_score = 1.0 - (idx * 0.1)

                    result = {
                        "content": chunk,
                        "score": estimated_score,
                        "file_path": meta['file_path'],
                        "file_name": meta['file_name'],
                        "file_type": meta['file_type'],
                        "file_hash": file_hash,
                        "indexed_at": meta['indexed_at']
                    }

                    # Add line number if available (from chunk header)
                    if chunk.startswith('[') and ']:' in chunk:
                        header = chunk.split(']')[0] + ']'
                        result["line_info"] = header

                    results.append(result)

            except Exception as e:
                print(f"Error searching {meta['file_path']}: {e}")
                continue

        # Sort by score and return top_k
        results.sort(key=lambda x: x['score'], reverse=True)
        return results[:top_k]

    def get_file_info(self, file_path: str) -> Optional[Dict[str, Any]]:
        """Get metadata for an indexed file"""
        file_path = os.path.abspath(file_path)
        file_hash = self._compute_file_hash(file_path) if os.path.exists(file_path) else None

        if file_hash and file_hash in self.metadata:
            return self.metadata[file_hash]

        # Search by path
        for meta in self.metadata.values():
            if meta['file_path'] == file_path:
                return meta

        return None

    def list_indexed_files(self) -> List[Dict[str, Any]]:
        """List all indexed files"""
        return [
            {
                "file_path": meta['file_path'],
                "file_name": meta['file_name'],
                "file_type": meta['file_type'],
                "file_size": meta['file_size'],
                "chunk_count": meta['chunk_count'],
                "indexed_at": meta['indexed_at']
            }
            for meta in self.metadata.values()
        ]

    def get_stats(self) -> Dict[str, Any]:
        """Get indexing statistics"""
        total_files = len(self.metadata)
        total_chunks = sum(m['chunk_count'] for m in self.metadata.values())
        total_size = sum(m['file_size'] for m in self.metadata.values())

        # Video storage size
        video_size = sum(
            os.path.getsize(m['video_path'])
            for m in self.metadata.values()
            if os.path.exists(m['video_path'])
        )

        file_types = {}
        for meta in self.metadata.values():
            ft = meta['file_type']
            file_types[ft] = file_types.get(ft, 0) + 1

        return {
            "total_files": total_files,
            "total_chunks": total_chunks,
            "total_source_size": total_size,
            "total_video_size": video_size,
            "compression_ratio": total_size / video_size if video_size > 0 else 0,
            "file_types": file_types
        }
