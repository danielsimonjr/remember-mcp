"""Test recall from archive"""
import asyncio
import sys
sys.path.insert(0, 'C:/mcp-servers/remember-mcp')

from remember.system import RememberSystem

async def test_recall():
    # Create system instance
    system = RememberSystem(
        active_db="remember_mcp.db",
        archive_dir="mcp_archives/",
        archive_threshold_days=60,
        archive_min_salience=0.2,
        auto_archive_enabled=False
    )

    # Get stats before recall
    stats_before = await system.get_stats()
    print(f"Before recall:")
    print(f"  Active: {stats_before.active_count}")
    print(f"  Archived: {stats_before.archive_count}")

    # Recall a specific memory
    archive_file = "user_default_1762577738"
    content_to_recall = "Very old memory from 90 days ago"

    print(f"\nRecalling memory from archive...")
    print(f"  Archive: {archive_file}")
    print(f"  Content: {content_to_recall}")

    result = await system.recall_from_archive(
        archive_file=archive_file,
        content=content_to_recall,
        user_id=None
    )

    print(f"\nRecall result: {result}")

    # Get stats after recall
    stats_after = await system.get_stats()
    print(f"\nAfter recall:")
    print(f"  Active: {stats_after.active_count}")
    print(f"  Archived: {stats_after.archive_count}")

    # Query to verify the recalled memory
    results = await system.query(query="90 days ago", k=3)
    print(f"\nQuery results for '90 days ago':")
    for i, mem in enumerate(results):
        print(f"  {i+1}. [{mem.location}] {mem.content[:80]}...")

if __name__ == "__main__":
    asyncio.run(test_recall())
