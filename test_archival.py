"""Test archival system directly"""
import asyncio
import sys
sys.path.insert(0, 'C:/mcp-servers/remember-mcp')

from remember.system import RememberSystem

async def test_archival():
    # Create system instance
    system = RememberSystem(
        active_db="remember_mcp.db",
        archive_dir="mcp_archives/",
        archive_threshold_days=60,
        archive_min_salience=0.2,
        auto_archive_enabled=False
    )

    # Get stats before archival
    stats_before = await system.get_stats()
    print(f"Before archival:")
    print(f"  Active: {stats_before.active_count}")
    print(f"  Archived: {stats_before.archive_count}")
    print(f"  Avg salience: {stats_before.avg_salience}")

    # Trigger archival
    print(f"\nTriggering archival (age_days=60, min_salience=0.2)...")
    archive_stats = await system.archive_old_memories()

    print(f"\nArchival results:")
    print(f"  Archived count: {archive_stats.archived_count}")
    print(f"  Active remaining: {archive_stats.active_remaining}")
    print(f"  Archive size: {archive_stats.archive_size_bytes} bytes")
    print(f"  Compression ratio: {archive_stats.compression_ratio}")

    # Get stats after archival
    stats_after = await system.get_stats()
    print(f"\nAfter archival:")
    print(f"  Active: {stats_after.active_count}")
    print(f"  Archived: {stats_after.archive_count}")
    print(f"  Avg salience: {stats_after.avg_salience}")

if __name__ == "__main__":
    asyncio.run(test_archival())
