"""
Main MCP Server entry point for remember-mcp
Direct tool registration without import_server

Heavy dependencies (sentence-transformers, FAISS, memvid, scipy) are imported
lazily inside ``get_system()`` / ``get_file_indexer()`` rather than at module
top level. With eager imports + an eager ``setup()`` the server took ~82s to
respond to its first ``initialize`` JSON-RPC message — well past Claude
Code's ~30s MCP startup timeout, so the server appeared broken on every
fresh launch. With lazy init the stdio handshake completes in <1s and the
heavy work runs on the first ``tools/call`` that actually needs it.
"""
import asyncio
import sys
from fastmcp import FastMCP
from typing import Optional, List, Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    # Type-only imports — never executed at runtime, so they cost nothing
    # at startup. Keep these in sync with the lazy imports below.
    from remember.system import RememberSystem
    from remember.scheduler import ArchivalScheduler
    from remember.file_indexer import FileIndexer

__all__ = ["app", "setup"]

# Create the main FastMCP app
app = FastMCP(
    name="remember",
    instructions="""
    Hybrid memory system with active (OpenMemory) and archive (memvid) storage.
    Provides memory management, search, archival capabilities, and file indexing.

    Features:
    - Memory management with 5 cognitive sectors
    - Automatic archival to video-encoded storage
    - File indexing (text, PDF, EPUB, code) with QR-encoded video
    - Semantic search across memories and files
    """
)

# Initialize globals — typed as Any to avoid forcing the heavy imports at
# module load. Concrete classes are imported inside the get_*() helpers.
remember_system: Optional[Any] = None
scheduler: Optional[Any] = None
file_indexer: Optional[Any] = None

# Serialize lazy construction so two concurrent tool calls cannot both run
# the multi-second FAISS-load path. Created on first use to avoid binding
# the lock to a specific event loop at import time.
_init_lock: Optional[asyncio.Lock] = None


def _get_init_lock() -> asyncio.Lock:
    global _init_lock
    if _init_lock is None:
        _init_lock = asyncio.Lock()
    return _init_lock


def get_system() -> "RememberSystem":
    """
    Get or create remember system. Imports ``RememberSystem`` /
    ``ArchivalScheduler`` lazily — these pull in openmemory, memvid,
    sentence-transformers, FAISS, and scipy, which together cost ~80s on a
    cold start. Deferring keeps the MCP handshake sub-second.
    """
    global remember_system, scheduler
    if remember_system is None:
        # Lazy heavy imports — see module docstring for rationale.
        from remember.system import RememberSystem
        from remember.scheduler import ArchivalScheduler

        remember_system = RememberSystem(
            active_db="remember_mcp.db",
            archive_dir="mcp_archives/",
            archive_threshold_days=60,
            archive_min_salience=0.2,
            auto_archive_enabled=False
        )
        scheduler = ArchivalScheduler(
            remember_system,
            interval_seconds=86400,
            enabled=False
        )
    return remember_system


def get_file_indexer() -> "FileIndexer":
    """
    Get or create file indexer. Imports ``FileIndexer`` lazily — it pulls
    in memvid + FAISS, which cost several seconds on cold start.
    """
    global file_indexer
    if file_indexer is None:
        # Lazy heavy import.
        from remember.file_indexer import FileIndexer

        file_indexer = FileIndexer(index_dir="file_index/")
    return file_indexer


async def _aget_system() -> "RememberSystem":
    """Async-safe wrapper around ``get_system`` — guards concurrent first-use."""
    async with _get_init_lock():
        return get_system()


async def _aget_file_indexer() -> "FileIndexer":
    """Async-safe wrapper around ``get_file_indexer``."""
    async with _get_init_lock():
        return get_file_indexer()


# Memory Management Tools

@app.tool()
async def add_memory(
    content: str,
    user_id: Optional[str] = None,
    tags: Optional[List[str]] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Add a new memory to active storage"""
    system = await _aget_system()
    result = await system.add_memory(
        content=content,
        user_id=user_id,
        tags=tags,
        metadata=metadata
    )
    return result


@app.tool()
async def query_memory(
    query: str,
    k: int = 10,
    user_id: Optional[str] = None,
    include_archive: bool = True,
    sectors: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Query memories with hybrid search"""
    system = await _aget_system()
    results = await system.query(
        query=query,
        k=k,
        user_id=user_id,
        include_archive=include_archive,
        sectors=sectors
    )
    return [
        {
            "id": r.id,
            "content": r.content,
            "score": r.score,
            "location": r.location.value,
            "primary_sector": r.primary_sector,
            "sectors": r.sectors,
            "salience": r.salience,
            "archived_at": r.archived_at,
            "archive_file": r.archive_file
        }
        for r in results
    ]


@app.tool()
async def archive_memories(
    age_days: Optional[float] = None,
    min_salience: Optional[float] = None,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Archive old/decayed memories to video"""
    system = await _aget_system()
    stats = await system.archive_old_memories(
        age_days=age_days,
        min_salience=min_salience,
        user_id=user_id
    )
    return {
        "archived_count": stats.archived_count,
        "active_remaining": stats.active_remaining,
        "archive_size_bytes": stats.archive_size_bytes,
        "compression_ratio": stats.compression_ratio
    }


@app.tool()
async def recall_memory(
    archive_file: str,
    content: str,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Recall archived memory back to active storage"""
    system = await _aget_system()
    result = await system.recall_from_archive(
        archive_file=archive_file,
        content=content,
        user_id=user_id
    )
    return result


@app.tool()
async def get_stats(user_id: Optional[str] = None) -> Dict[str, Any]:
    """Get system statistics"""
    system = await _aget_system()
    stats = await system.get_stats(user_id=user_id)
    return {
        "active_count": stats.active_count,
        "archive_count": stats.archive_count,
        "total_memories": stats.total_memories,
        "active_db_size": stats.active_db_size,
        "archive_size": stats.archive_size,
        "total_size": stats.total_size,
        "compression_ratio": stats.compression_ratio,
        "avg_salience": stats.avg_salience
    }


@app.tool()
async def scheduler_status() -> Dict[str, Any]:
    """Get archival scheduler status"""
    global scheduler
    if scheduler is None:
        return {"error": "Scheduler not initialized"}
    return scheduler.get_status()


@app.tool()
async def scheduler_control(action: str) -> Dict[str, str]:
    """Control archival scheduler (start/stop/run_now)"""
    global scheduler
    if scheduler is None:
        return {"error": "Scheduler not initialized"}

    if action == "start":
        await scheduler.start()
        message = "Scheduler started"
    elif action == "stop":
        await scheduler.stop()
        message = "Scheduler stopped"
    elif action == "run_now":
        await scheduler.run_now()
        message = "Archival triggered"
    else:
        message = f"Unknown action: {action}"

    return {"status": message}


# File Indexing Tools

@app.tool()
async def index_file(
    file_path: str,
    chunk_size: int = 1024,
    overlap: int = 128,
    preserve_lines: bool = True,
    index_dotfiles: bool = False,
) -> Dict[str, Any]:
    """
    Index a file into video-encoded storage using QR codes

    Supports: text, Python, JavaScript, PDF, EPUB, markdown, and more.
    Automatically preserves line numbers for code files.

    Security: file_path must resolve inside one of the allowed index roots
    (env var ``REMEMBER_INDEX_ROOTS``, comma-separated absolute paths;
    default ``~/Documents``). Dotfiles (``.env``, ``.ssh/...``, etc.) are
    rejected by default — pass ``index_dotfiles=True`` to opt in.

    Args:
        file_path: Path to file to index
        chunk_size: Size of text chunks (default: 1024)
        overlap: Overlap between chunks (default: 128)
        preserve_lines: Preserve line numbers for code (default: true)
        index_dotfiles: Allow dotfiles to be indexed (default: false)

    Returns:
        Indexing statistics and metadata, or ``{"error": "..."}`` on
        permission/not-found errors.
    """
    indexer = await _aget_file_indexer()
    try:
        result = await asyncio.to_thread(
            indexer.index_file,
            file_path=file_path,
            chunk_size=chunk_size,
            overlap=overlap,
            preserve_lines=preserve_lines,
            index_dotfiles=index_dotfiles,
        )
        return result
    except PermissionError as e:
        return {"error": "permission_denied", "message": str(e)}
    except FileNotFoundError as e:
        return {"error": "not_found", "message": str(e)}


@app.tool()
async def index_directory(
    dir_path: str,
    pattern: str = "**/*",
    exclude: Optional[List[str]] = None,
    chunk_size: int = 1024,
    overlap: int = 128,
    index_dotfiles: bool = False,
) -> Dict[str, Any]:
    """
    Index all files in a directory matching a pattern

    Security: dir_path must resolve inside one of the allowed index roots
    (env var ``REMEMBER_INDEX_ROOTS``, comma-separated absolute paths;
    default ``~/Documents``). Dotfiles and dot-dirs are skipped unless
    ``index_dotfiles=True``.

    Args:
        dir_path: Directory path to index
        pattern: Glob pattern (e.g., "**/*.py" for all Python files)
        exclude: List of patterns to exclude
        chunk_size: Chunk size for text
        overlap: Overlap between chunks
        index_dotfiles: Allow dotfiles/dot-dirs to be indexed (default: false)

    Returns:
        Summary of indexing operation, or ``{"error": "..."}`` on permission
        / not-found errors.
    """
    indexer = await _aget_file_indexer()
    try:
        result = await asyncio.to_thread(
            indexer.index_directory,
            dir_path=dir_path,
            pattern=pattern,
            exclude=exclude,
            chunk_size=chunk_size,
            overlap=overlap,
            index_dotfiles=index_dotfiles,
        )
        return result
    except PermissionError as e:
        return {"error": "permission_denied", "message": str(e)}
    except FileNotFoundError as e:
        return {"error": "not_found", "message": str(e)}


@app.tool()
async def search_files(
    query: str,
    top_k: int = 10,
    file_filter: Optional[str] = None,
    file_type_filter: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Search across all indexed files using semantic search

    Args:
        query: Search query
        top_k: Number of results to return (default: 10)
        file_filter: Filter by file path pattern (e.g., "src/")
        file_type_filter: Filter by file type (e.g., "python", "pdf")

    Returns:
        List of search results with file metadata and line numbers
    """
    indexer = await _aget_file_indexer()
    results = await asyncio.to_thread(
        indexer.search,
        query=query,
        top_k=top_k,
        file_filter=file_filter,
        file_type_filter=file_type_filter
    )
    return results


@app.tool()
async def list_indexed_files() -> List[Dict[str, Any]]:
    """
    List all files that have been indexed

    Returns:
        List of indexed files with metadata
    """
    indexer = await _aget_file_indexer()
    files = await asyncio.to_thread(indexer.list_indexed_files)
    return files


@app.tool()
async def get_file_info(file_path: str) -> Optional[Dict[str, Any]]:
    """
    Get detailed information about an indexed file

    Args:
        file_path: Path to file

    Returns:
        File metadata or None if not indexed
    """
    indexer = await _aget_file_indexer()
    info = await asyncio.to_thread(indexer.get_file_info, file_path)
    return info


@app.tool()
async def get_file_stats() -> Dict[str, Any]:
    """
    Get statistics about the file index

    Returns:
        Statistics including total files, chunks, compression ratio
    """
    indexer = await _aget_file_indexer()
    stats = await asyncio.to_thread(indexer.get_stats)
    return stats


async def setup():
    """
    Eagerly initialize the remember system.

    .. deprecated::
        This is no longer called from ``main()`` — kept for callers that want
        to force-warm the heavy dependencies (e.g. tests, benchmarks). The
        stdio server now defers initialization to the first ``tools/call``
        that needs it so the MCP handshake completes in <1s instead of ~80s.
    """
    get_system()
    get_file_indexer()


def shutdown() -> None:
    """Release cached resources (MemvidRetriever pool, OpenMemory storage).

    Called from ``main()`` after ``app.run`` returns so FAISS indexes and
    mp4 readers don't leak on server exit.
    """
    global remember_system, file_indexer
    if remember_system is not None:
        try:
            remember_system.close()
        except Exception as e:  # noqa: BLE001 — defensive cleanup on exit
            print(f"Error closing remember_system: {e}", file=sys.stderr)
    if file_indexer is not None:
        try:
            file_indexer.close()
        except Exception as e:  # noqa: BLE001 — defensive cleanup on exit
            print(f"Error closing file_indexer: {e}", file=sys.stderr)


def main():
    """
    Main entry point.

    Note: we intentionally do NOT call ``setup()`` here. ``setup()`` constructs
    ``RememberSystem`` and ``FileIndexer``, which transitively import
    sentence-transformers, FAISS, memvid, and scipy and load any existing
    FAISS index from disk — collectively ~80s on a cold start. That blocks
    the stdio handshake past Claude Code's ~30s MCP startup window.
    Construction now happens lazily on the first tool invocation that needs
    it (``add_memory``, ``query_memory``, ``index_file``, etc.); tools that
    don't touch heavy state (``scheduler_status``, ``scheduler_control``)
    return without forcing init.
    """
    try:
        app.run(transport="stdio")
    finally:
        shutdown()


if __name__ == "__main__":
    main()
