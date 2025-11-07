"""
MCP Server for remember-mcp using FastMCP

Exposes hybrid memory system via Model Context Protocol.
"""
from fastmcp import FastMCP
from typing import Optional, List, Dict, Any
from ..system import RememberSystem
from ..scheduler import ArchivalScheduler

# Create FastMCP app
remember_mcp = FastMCP(
    name="remember_mcp",
    instructions="""
    This MCP server provides hybrid memory management combining:
    - Active memory (OpenMemory with 5 sectors: episodic, semantic, procedural, emotional, reflective)
    - Archive memory (memvid video-encoded long-term storage)

    Features:
    - Dual-process decay simulation
    - Automatic archival of old/decayed memories
    - Hybrid search across active and archived memories
    - Memory lifecycle management
    """,
)

# Initialize system
remember_system: Optional[RememberSystem] = None
scheduler: Optional[ArchivalScheduler] = None


def get_system() -> RememberSystem:
    """Get or create remember system"""
    global remember_system, scheduler
    if remember_system is None:
        remember_system = RememberSystem(
            active_db="remember_mcp.db",
            archive_dir="mcp_archives/",
            archive_threshold_days=60,
            archive_min_salience=0.2,
            auto_archive_enabled=False  # Manual control via MCP
        )
        scheduler = ArchivalScheduler(
            remember_system,
            interval_seconds=86400,  # 24 hours
            enabled=False  # Start disabled
        )
    return remember_system


@remember_mcp.tool()
async def add_memory(
    content: str,
    user_id: Optional[str] = None,
    tags: Optional[List[str]] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Add a new memory to active storage

    Args:
        content: Memory content
        user_id: Optional user ID for isolation
        tags: Optional tags
        metadata: Optional metadata

    Returns:
        Dictionary with memory ID and metadata
    """
    system = get_system()
    result = await system.add_memory(
        content=content,
        user_id=user_id,
        tags=tags,
        metadata=metadata
    )
    return result


@remember_mcp.tool()
async def query_memory(
    query: str,
    k: int = 10,
    user_id: Optional[str] = None,
    include_archive: bool = True,
    sectors: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Query memories with hybrid search (active + archive)

    Args:
        query: Query string
        k: Number of results (default: 10)
        user_id: Optional user ID filter
        include_archive: Search archives (default: true)
        sectors: Optional sector filter (episodic, semantic, procedural, emotional, reflective)

    Returns:
        List of matching memories with scores
    """
    system = get_system()
    results = await system.query(
        query=query,
        k=k,
        user_id=user_id,
        include_archive=include_archive,
        sectors=sectors
    )

    # Convert to dict
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


@remember_mcp.tool()
async def archive_memories(
    age_days: Optional[float] = None,
    min_salience: Optional[float] = None,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Archive old/decayed memories to video format

    Args:
        age_days: Minimum age in days
        min_salience: Maximum salience to archive
        user_id: Optional user filter

    Returns:
        Statistics about archived memories
    """
    system = get_system()
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


@remember_mcp.tool()
async def recall_memory(
    archive_file: str,
    content: str,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Recall archived memory back to active storage

    Args:
        archive_file: Archive filename
        content: Memory content to recall
        user_id: Optional user ID

    Returns:
        Result of recall operation
    """
    system = get_system()
    result = await system.recall_from_archive(
        archive_file=archive_file,
        content=content,
        user_id=user_id
    )
    return result


@remember_mcp.tool()
async def get_stats(user_id: Optional[str] = None) -> Dict[str, Any]:
    """Get system statistics

    Args:
        user_id: Optional user filter

    Returns:
        System statistics including memory counts and sizes
    """
    system = get_system()
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


@remember_mcp.tool()
async def scheduler_status() -> Dict[str, Any]:
    """Get archival scheduler status

    Returns:
        Scheduler status information
    """
    global scheduler
    if scheduler is None:
        return {"error": "Scheduler not initialized"}
    return scheduler.get_status()


@remember_mcp.tool()
async def scheduler_control(action: str) -> Dict[str, str]:
    """Control archival scheduler (start/stop/run_now)

    Args:
        action: Scheduler action (start, stop, or run_now)

    Returns:
        Status message
    """
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
