"""
File Indexer for remember-mcp
Extends memvid to support file indexing with metadata tracking
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .video import RetrieverCache, encode_chunks, make_encoder, search_with_scores

logger = logging.getLogger(__name__)

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_DIRECTORY_FILES = 500
MAX_QUERY_K = 100
MIN_CHUNK_SIZE = 32
MAX_CHUNK_SIZE = 1_000_000
_DEFAULT_EXCLUDES = (".git", "__pycache__", "node_modules", ".pyc", ".mp4", ".mp3")
_CODE_TYPES = frozenset({"python", "javascript", "typescript", "java", "cpp", "c"})
_TYPE_MAP = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "header",
    ".md": "markdown",
    ".txt": "text",
    ".pdf": "pdf",
    ".epub": "epub",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
}


def _get_allowed_index_roots() -> List[Path]:
    """
    Resolve the list of allowed root directories for file indexing.

    Read from env var ``REMEMBER_INDEX_ROOTS`` (comma-separated absolute
    paths). If unset, default to ``~/Documents`` only. This is a security
    boundary: an MCP client cannot index files outside these roots, which
    prevents prompt-injected requests for ``~/.ssh/id_rsa``, ``.env`` files,
    OAuth caches, etc. from being embedded into the queryable QR-video index.
    """
    raw = os.environ.get("REMEMBER_INDEX_ROOTS", "")
    if raw.strip():
        roots = [Path(p.strip()).expanduser().resolve() for p in raw.split(",") if p.strip()]
    else:
        roots = [(Path.home() / "Documents").resolve()]
    return roots


def _is_within_allowed_roots(abs_path: Path, allowed_roots: List[Path]) -> bool:
    """Return True if ``abs_path`` is the same as, or a descendant of, any allowed root."""
    resolved = abs_path.resolve()
    for root in allowed_roots:
        try:
            if resolved == root or resolved.is_relative_to(root):
                return True
        except (ValueError, OSError):
            continue
    return False


def _is_dotfile_path(path: Path) -> bool:
    """
    Return True if any component of ``path`` (file name or any parent dir)
    starts with ``.`` (e.g. ``.env``, ``.ssh/id_rsa``, ``.aws/credentials``).
    The drive letter / root anchor is excluded.
    """
    for part in path.parts:
        # Skip Windows drive ("C:\\") and POSIX root ("/")
        if part in ("/", "\\") or (len(part) >= 2 and part[1] == ":"):
            continue
        if part.startswith("."):
            return True
    return False


def _looks_binary(sample: bytes) -> bool:
    return b"\x00" in sample


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

    def __init__(
        self,
        index_dir: str = "file_index/",
        allowed_roots: Optional[List[str]] = None,
        max_file_bytes: int = MAX_FILE_BYTES,
        max_directory_files: int = MAX_DIRECTORY_FILES,
    ):
        """
        Initialize FileIndexer

        Args:
            index_dir: Directory for file index storage
            allowed_roots: Optional list of absolute paths that constrain
                which files/dirs may be indexed. If ``None``, falls back to
                the ``REMEMBER_INDEX_ROOTS`` env var (comma-separated), and
                ultimately to ``~/Documents``.
            max_file_bytes: Refuse to index a single file larger than this.
            max_directory_files: Cap on files processed per ``index_directory``.
        """
        self.index_dir = Path(index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self.max_file_bytes = max_file_bytes
        self.max_directory_files = max_directory_files

        if allowed_roots is not None:
            self.allowed_roots = [Path(p).expanduser().resolve() for p in allowed_roots]
        else:
            self.allowed_roots = _get_allowed_index_roots()

        # File metadata database: maps file_hash -> metadata
        self.metadata_file = self.index_dir / "file_metadata.json"
        self.metadata: Dict[str, Dict[str, Any]] = self._load_metadata()
        self._lock = threading.RLock()

        # Master index for all files
        self.master_video = self.index_dir / "master_index.mp4"
        self.master_index = self.index_dir / "master_index.json"

        # Cache MemvidRetriever instances by (video_path, index_path) so we
        # don't reload the FAISS index + reopen the mp4 reader on every search.
        self._retriever_cache = RetrieverCache()

    def _get_retriever(self, video_path: str, index_path: str) -> Any:
        """
        Return a cached MemvidRetriever for the given (video_path, index_path)
        pair. Caching avoids reloading the FAISS index and reopening the mp4
        reader on every search call.
        """
        return self._retriever_cache.get(video_path, index_path)

    def close(self) -> None:
        """Release cached MemvidRetriever instances (FAISS indexes + mp4
        readers). Safe to call multiple times.
        """
        self._retriever_cache.close()

    def _load_metadata(self) -> Dict[str, Dict[str, Any]]:
        """Load file metadata from disk. A corrupt file is quarantined rather
        than crashing indexer construction — the MCP server must still boot.
        """
        if not self.metadata_file.exists():
            return {}
        try:
            with open(self.metadata_file, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            backup = self.metadata_file.with_suffix(".json.corrupt")
            try:
                os.replace(self.metadata_file, backup)
                logger.error(
                    "Corrupt file metadata at %s (%s); moved to %s",
                    self.metadata_file,
                    exc,
                    backup,
                )
            except OSError:
                logger.error("Corrupt file metadata at %s: %s", self.metadata_file, exc)
            return {}
        if not isinstance(data, dict):
            logger.error("File metadata is not an object; starting empty")
            return {}
        return data

    def _save_metadata(self) -> None:
        """Atomic replace so a crash mid-write cannot leave a half JSON file."""
        tmp = self.metadata_file.with_suffix(".json.tmp")
        payload = json.dumps(self.metadata, separators=(",", ":"), ensure_ascii=False)
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self.metadata_file)

    def _compute_file_hash(self, file_path: str) -> str:
        """Compute SHA256 hash of file"""
        sha256 = hashlib.sha256()
        with open(file_path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                sha256.update(chunk)
        return sha256.hexdigest()

    def _get_file_type(self, file_path: str) -> str:
        """Determine file type from extension"""
        ext = Path(file_path).suffix.lower()
        return _TYPE_MAP.get(ext, "unknown")

    @staticmethod
    def _validate_chunking(chunk_size: int, overlap: int) -> tuple[int, int]:
        if not isinstance(chunk_size, int) or isinstance(chunk_size, bool):
            raise ValueError("chunk_size must be an integer")
        if chunk_size < MIN_CHUNK_SIZE or chunk_size > MAX_CHUNK_SIZE:
            raise ValueError(
                f"chunk_size must be between {MIN_CHUNK_SIZE} and {MAX_CHUNK_SIZE}"
            )
        if not isinstance(overlap, int) or isinstance(overlap, bool) or overlap < 0:
            raise ValueError("overlap must be a non-negative integer")
        if overlap >= chunk_size:
            raise ValueError("overlap must be smaller than chunk_size")
        return chunk_size, overlap

    def _enforce_path_policy(
        self,
        resolved: Path,
        index_dotfiles: bool,
        must_exist_as: Optional[str] = None,
    ) -> None:
        if not _is_within_allowed_roots(resolved, self.allowed_roots):
            raise PermissionError(
                f"Refusing to index path outside allowed roots: {resolved}. "
                f"Allowed roots: {[str(r) for r in self.allowed_roots]}. "
                f"Configure via REMEMBER_INDEX_ROOTS env var."
            )
        if not index_dotfiles and _is_dotfile_path(resolved):
            raise PermissionError(
                f"Refusing to index dotfile: {resolved}. "
                f"Pass index_dotfiles=True to override."
            )
        if must_exist_as == "file" and not resolved.is_file():
            raise FileNotFoundError(f"File not found: {resolved}")
        if must_exist_as == "dir" and not resolved.is_dir():
            raise FileNotFoundError(f"Directory not found: {resolved}")

    def index_file(
        self,
        file_path: str,
        chunk_size: int = 1024,
        overlap: int = 128,
        preserve_lines: bool = True,
        index_dotfiles: bool = False,
    ) -> Dict[str, Any]:
        """
        Index a single file into the video-encoded archive

        Args:
            file_path: Path to file to index
            chunk_size: Size of text chunks
            overlap: Overlap between chunks
            preserve_lines: Preserve line numbers for code files
            index_dotfiles: If False (default), reject files whose name or
                any parent directory starts with '.' (e.g. ``.env``,
                ``.ssh/id_rsa``). Pass True to opt in.

        Returns:
            Dictionary with indexing stats and metadata

        Raises:
            PermissionError: If ``file_path`` resolves outside the configured
                allow-list, or is a dotfile and ``index_dotfiles`` is False.
        """
        chunk_size, overlap = self._validate_chunking(chunk_size, overlap)
        resolved = Path(file_path).expanduser().resolve()
        self._enforce_path_policy(resolved, index_dotfiles, must_exist_as="file")

        file_size = resolved.stat().st_size
        if file_size > self.max_file_bytes:
            raise PermissionError(
                f"Refusing to index file larger than {self.max_file_bytes} bytes: "
                f"{resolved} ({file_size} bytes)"
            )

        file_hash = self._compute_file_hash(str(resolved))
        file_type = self._get_file_type(str(resolved))

        with self._lock:
            existing = self.metadata.get(file_hash)
            if existing:
                # Same bytes, whatever the path: do not overwrite the original
                # entry (that used to drop the first path when two files
                # hashed identically).
                return {
                    "status": "already_indexed",
                    "file_path": existing.get("file_path", str(resolved)),
                    "file_hash": file_hash,
                    "indexed_at": existing.get("indexed_at"),
                }

        chunks_meta: List[Dict[str, Any]] = []
        encoder = None
        chunk_count = 0

        if file_type == "pdf":
            encoder = make_encoder()
            encoder.add_pdf(str(resolved), chunk_size=chunk_size, overlap=overlap)
            chunk_count = len(encoder.chunks)
        elif file_type == "epub":
            encoder = make_encoder()
            encoder.add_epub(str(resolved), chunk_size=chunk_size, overlap=overlap)
            chunk_count = len(encoder.chunks)
        else:
            with open(resolved, "rb") as handle:
                data = handle.read()
            if _looks_binary(data[:8192]):
                raise PermissionError(
                    f"Refusing to index binary file as text: {resolved}"
                )
            try:
                content = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise PermissionError(
                    f"Refusing to index non-UTF-8 file: {resolved}"
                ) from exc

            if preserve_lines and file_type in _CODE_TYPES:
                chunks_with_lines, chunks_meta = _chunk_code_with_lines(
                    content, Path(resolved).name, chunk_size
                )
                chunk_count = len(chunks_with_lines)
                video_path = self.index_dir / f"{file_hash}.mp4"
                index_path = self.index_dir / f"{file_hash}.json"
                stats = encode_chunks(chunks_with_lines, video_path, index_path)
                return self._record_index(
                    resolved=resolved,
                    file_hash=file_hash,
                    file_type=file_type,
                    file_size=file_size,
                    chunk_count=chunk_count,
                    chunk_size=chunk_size,
                    overlap=overlap,
                    video_path=video_path,
                    index_path=index_path,
                    chunks_meta=chunks_meta,
                    stats=stats,
                )
            encoder = make_encoder()
            encoder.add_text(content, chunk_size=chunk_size, overlap=overlap)
            chunk_count = len(encoder.chunks)

        if chunk_count == 0:
            raise ValueError(f"No indexable content in {resolved}")

        video_path = self.index_dir / f"{file_hash}.mp4"
        index_path = self.index_dir / f"{file_hash}.json"

        with contextlib.redirect_stdout(sys.stderr):
            stats = encoder.build_video(
                output_file=str(video_path),
                index_file=str(index_path),
                show_progress=False,
            )

        return self._record_index(
            resolved=resolved,
            file_hash=file_hash,
            file_type=file_type,
            file_size=file_size,
            chunk_count=chunk_count,
            chunk_size=chunk_size,
            overlap=overlap,
            video_path=video_path,
            index_path=index_path,
            chunks_meta=chunks_meta,
            stats=stats,
        )

    def _record_index(
        self,
        *,
        resolved: Path,
        file_hash: str,
        file_type: str,
        file_size: int,
        chunk_count: int,
        chunk_size: int,
        overlap: int,
        video_path: Path,
        index_path: Path,
        chunks_meta: List[Dict[str, Any]],
        stats: Any,
    ) -> Dict[str, Any]:
        if not isinstance(stats, dict):
            stats = {}
        metadata = {
            "file_path": str(resolved),
            "file_name": resolved.name,
            "file_hash": file_hash,
            "file_type": file_type,
            "file_size": file_size,
            "chunk_count": chunk_count,
            "chunk_size": chunk_size,
            "overlap": overlap,
            "video_path": str(video_path),
            "index_path": str(index_path),
            "chunks_meta": chunks_meta or None,
            "indexed_at": datetime.now(timezone.utc).isoformat(),
            "stats": stats,
        }
        with self._lock:
            self.metadata[file_hash] = metadata
            self._save_metadata()
        return {
            "status": "indexed",
            "file_path": str(resolved),
            "file_hash": file_hash,
            "chunk_count": chunk_count,
            "video_size": stats.get("video_size", 0) or int(
                stats.get("video_size_mb", 0) * 1024 * 1024
            ),
            "compression_ratio": stats.get("compression_ratio", 0),
        }

    def index_directory(
        self,
        dir_path: str,
        pattern: str = "**/*",
        exclude: Optional[List[str]] = None,
        chunk_size: int = 1024,
        overlap: int = 128,
        index_dotfiles: bool = False,
    ) -> Dict[str, Any]:
        """
        Index all files in a directory matching a pattern

        Args:
            dir_path: Directory to index
            pattern: Glob pattern (e.g., "**/*.py")
            exclude: List of patterns to exclude
            chunk_size: Chunk size for text
            overlap: Overlap between chunks
            index_dotfiles: If False (default), skip dotfiles and dot-dirs.

        Returns:
            Summary of indexing operation

        Raises:
            PermissionError: If ``dir_path`` resolves outside the configured
                allow-list.
        """
        chunk_size, overlap = self._validate_chunking(chunk_size, overlap)
        resolved_dir = Path(dir_path).expanduser().resolve()
        self._enforce_path_policy(resolved_dir, index_dotfiles, must_exist_as="dir")

        # Copy so a caller-supplied list is not mutated (the previous
        # ``exclude.extend(defaults)`` modified the MCP argument in place).
        exclude_patterns = list(_DEFAULT_EXCLUDES)
        if exclude:
            exclude_patterns.extend(exclude)

        indexed: List[Dict[str, Any]] = []
        skipped: List[str] = []
        errors: List[Dict[str, str]] = []
        considered = 0

        for file_path in resolved_dir.glob(pattern):
            if not file_path.is_file():
                continue
            try:
                resolved_file = file_path.resolve()
            except OSError as exc:
                errors.append({"file": str(file_path), "error": str(exc)})
                continue

            # Confine glob results to the requested directory. pathlib glob
            # of ``../**`` can otherwise walk *out* of dir_path.
            try:
                if not resolved_file.is_relative_to(resolved_dir):
                    skipped.append(str(file_path))
                    continue
            except (ValueError, OSError):
                skipped.append(str(file_path))
                continue

            if any(excl in str(resolved_file) for excl in exclude_patterns):
                skipped.append(str(file_path))
                continue

            if not index_dotfiles and _is_dotfile_path(resolved_file):
                skipped.append(str(file_path))
                continue

            considered += 1
            if considered > self.max_directory_files:
                errors.append({
                    "file": str(resolved_dir),
                    "error": (
                        f"Stopped after {self.max_directory_files} files "
                        f"(max_directory_files). Narrow the glob or raise the cap."
                    ),
                })
                break

            try:
                result = self.index_file(
                    str(resolved_file),
                    chunk_size=chunk_size,
                    overlap=overlap,
                    index_dotfiles=index_dotfiles,
                )
                indexed.append(result)
            except Exception as exc:  # noqa: BLE001 — per-file isolation
                errors.append({"file": str(file_path), "error": str(exc)})

        return {
            "indexed_count": len(indexed),
            "skipped_count": len(skipped),
            "error_count": len(errors),
            "indexed_files": indexed,
            "errors": errors,
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
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")
        if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1 or top_k > MAX_QUERY_K:
            raise ValueError(f"top_k must be an integer between 1 and {MAX_QUERY_K}")

        with self._lock:
            snapshot = list(self.metadata.items())

        results: List[Dict[str, Any]] = []

        for file_hash, meta in snapshot:
            if file_filter and file_filter not in meta["file_path"]:
                continue
            if file_type_filter and meta["file_type"] != file_type_filter:
                continue

            video_path = meta["video_path"]
            index_path = meta["index_path"]

            if not os.path.exists(video_path) or not os.path.exists(index_path):
                continue

            try:
                retriever = self._get_retriever(
                    video_path=video_path,
                    index_path=index_path,
                )
                hits = search_with_scores(retriever, query, top_k)
            except Exception as exc:  # noqa: BLE001 — one file must not fail the search
                logger.error("Error searching %s: %s", meta.get("file_path"), exc)
                continue

            for chunk, score in hits:
                result = {
                    "content": chunk,
                    "score": score,
                    "file_path": meta["file_path"],
                    "file_name": meta["file_name"],
                    "file_type": meta["file_type"],
                    "file_hash": file_hash,
                    "indexed_at": meta["indexed_at"],
                }
                if isinstance(chunk, str) and chunk.startswith("[") and "]:" in chunk[:80]:
                    header = chunk.split("]", 1)[0] + "]"
                    result["line_info"] = header
                results.append(result)

        results.sort(key=lambda item: item["score"], reverse=True)
        return results[:top_k]

    def get_file_info(self, file_path: str) -> Optional[Dict[str, Any]]:
        """Get metadata for an indexed file.

        Path lookup is tried first so a missing-on-disk (but previously
        indexed) file still resolves, and so we don't hash a huge file just
        to answer a metadata query.
        """
        resolved = str(Path(file_path).expanduser().resolve()) if file_path else ""
        with self._lock:
            for meta in self.metadata.values():
                if meta.get("file_path") in (file_path, resolved):
                    return meta
            if resolved and os.path.isfile(resolved):
                file_hash = self._compute_file_hash(resolved)
                if file_hash in self.metadata:
                    return self.metadata[file_hash]
        return None

    def list_indexed_files(self) -> List[Dict[str, Any]]:
        """List all indexed files"""
        with self._lock:
            snapshot = list(self.metadata.values())
        return [
            {
                "file_path": meta["file_path"],
                "file_name": meta["file_name"],
                "file_type": meta["file_type"],
                "file_size": meta["file_size"],
                "chunk_count": meta["chunk_count"],
                "indexed_at": meta["indexed_at"],
            }
            for meta in snapshot
        ]

    def get_stats(self) -> Dict[str, Any]:
        """Get indexing statistics"""
        with self._lock:
            snapshot = list(self.metadata.values())
        total_files = len(snapshot)
        total_chunks = sum(m.get("chunk_count") or 0 for m in snapshot)
        total_size = sum(m.get("file_size") or 0 for m in snapshot)

        video_size = 0
        for meta in snapshot:
            video_path = meta.get("video_path")
            if video_path and os.path.exists(video_path):
                try:
                    video_size += os.path.getsize(video_path)
                except OSError as exc:
                    logger.warning("Could not stat video %s: %s", video_path, exc)

        file_types: Dict[str, int] = {}
        for meta in snapshot:
            ft = meta.get("file_type") or "unknown"
            file_types[ft] = file_types.get(ft, 0) + 1

        return {
            "total_files": total_files,
            "total_chunks": total_chunks,
            "total_source_size": total_size,
            "total_video_size": video_size,
            "compression_ratio": total_size / video_size if video_size > 0 else 0,
            "file_types": file_types,
        }


def _chunk_code_with_lines(
    content: str, filename: str, chunk_size: int
) -> tuple[List[str], List[Dict[str, int]]]:
    """Split code into line-preserving chunks in O(n), not O(n²).

    The previous implementation recomputed ``sum(len(l)+1 for l in lines[:i])``
    on every iteration.
    """
    lines = content.split("\n")
    n_lines = len(lines)
    step = max(1, chunk_size // 50)
    offsets = [0] * (n_lines + 1)
    for i, line in enumerate(lines):
        offsets[i + 1] = offsets[i] + len(line) + 1

    chunks: List[str] = []
    meta: List[Dict[str, int]] = []
    for start in range(0, n_lines, step):
        end = min(start + step, n_lines)
        start_line = start + 1
        end_line = end
        chunk_text = f"[{filename}:{start_line}-{end_line}]\n" + "\n".join(lines[start:end])
        chunks.append(chunk_text)
        meta.append({
            "start_line": start_line,
            "end_line": end_line,
            "char_start": offsets[start],
            "char_end": offsets[end],
        })
    return chunks, meta
