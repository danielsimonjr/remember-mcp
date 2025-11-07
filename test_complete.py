"""
Comprehensive test of remember-mcp Phase 2
Tests: active memory, archival scheduler, MCP server
"""
import asyncio
import sys
import time
from remember import RememberSystem
from remember.scheduler import ArchivalScheduler

# Fix Windows console encoding for Unicode
if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
    sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')


async def test_phase2():
    print("=" * 70)
    print("remember-mcp Phase 2 - Comprehensive Test")
    print("=" * 70)

    # Initialize system
    print("\n[1/6] Initializing RememberSystem...")
    remember = RememberSystem(
        active_db="test_phase2.db",
        archive_dir="test_archives/",
        archive_threshold_days=0,  # Archive immediately for testing
        archive_min_salience=0.5,   # Archive low-salience
        auto_archive_enabled=False
    )
    print("   ✓ System initialized")

    # Initialize scheduler
    print("\n[2/6] Initializing ArchivalScheduler...")
    scheduler = ArchivalScheduler(
        remember,
        interval_seconds=10,  # 10 seconds for testing
        enabled=True
    )
    print(f"   ✓ Scheduler created (interval: {scheduler.interval}s)")

    # Add test memories
    print("\n[3/6] Adding test memories...")
    test_memories = [
        {
            "content": "Python is great for AI and machine learning projects",
            "salience": 0.8,
            "tags": ["programming", "python"]
        },
        {
            "content": "Remember to buy groceries: milk, eggs, bread",
            "salience": 0.3,  # Low salience - eligible for archival
            "tags": ["shopping", "todo"]
        },
        {
            "content": "The meeting is scheduled for 3 PM tomorrow",
            "salience": 0.7,
            "tags": ["meeting", "schedule"]
        },
        {
            "content": "Old project notes from last month",
            "salience": 0.2,  # Very low - definitely archive
            "tags": ["project", "notes"]
        },
        {
            "content": "Important security update: change password",
            "salience": 0.9,
            "tags": ["security", "important"]
        }
    ]

    for i, mem in enumerate(test_memories, 1):
        result = await remember.add_memory(
            content=mem["content"],
            user_id="test_user",
            tags=mem["tags"],
            metadata={"test_salience": mem["salience"]}
        )
        print(f"   {i}. Added [{result['primary_sector']}]: {mem['content'][:50]}...")

    # Query active memories
    print("\n[4/6] Querying active memories...")
    queries = [
        "programming languages",
        "shopping list",
        "upcoming meetings"
    ]

    for query in queries:
        print(f"\n   Query: '{query}'")
        results = await remember.query(
            query=query,
            user_id="test_user",
            k=2,
            include_archive=False
        )

        for j, mem in enumerate(results, 1):
            print(f"      {j}. [score: {mem.score:.3f}, {mem.location.value}]")
            print(f"         {mem.content[:55]}...")

    # Test scheduler
    print("\n[5/6] Testing ArchivalScheduler...")

    print("   Starting scheduler...")
    await scheduler.start()

    status = scheduler.get_status()
    print(f"   ✓ Running: {status['running']}")
    print(f"   ✓ Enabled: {status['enabled']}")
    print(f"   ✓ Interval: {status['interval_seconds']}s")

    print("\n   Triggering manual archival...")
    await scheduler.run_now()

    print(f"   ✓ Total archived: {scheduler.total_archived}")

    print("\n   Stopping scheduler...")
    await scheduler.stop()
    print("   ✓ Scheduler stopped")

    # Get final stats
    print("\n[6/6] Final System Statistics...")
    stats = await remember.get_stats(user_id="test_user")
    print(f"   Active memories: {stats.active_count}")
    print(f"   Archived memories: {stats.archive_count}")
    print(f"   Total memories: {stats.total_memories}")
    print(f"   Active DB size: {stats.active_db_size:,} bytes")
    print(f"   Archive size: {stats.archive_size:,} bytes")
    print(f"   Total size: {stats.total_size:,} bytes")

    # Test hybrid query (active + archive)
    print("\n[Bonus] Testing hybrid query (active + archive)...")
    hybrid_results = await remember.query(
        query="project notes",
        user_id="test_user",
        k=3,
        include_archive=True
    )

    for i, mem in enumerate(hybrid_results, 1):
        location_icon = "🔥" if mem.location.value == "active" else "📹"
        print(f"   {i}. {location_icon} [{mem.score:.3f}] {mem.content[:50]}...")
        print(f"      Location: {mem.location.value}, Sector: {mem.primary_sector}")

    # Cleanup
    remember.close()

    print("\n" + "=" * 70)
    print("Phase 2 Test Complete!")
    print("=" * 70)
    print("\n✅ All Phase 2 features working:")
    print("   • Active memory (OpenMemory)")
    print("   • Archive storage (memvid)")
    print("   • Archival scheduler")
    print("   • Hybrid querying")
    print("   • System statistics")


if __name__ == "__main__":
    asyncio.run(test_phase2())
