"""
Example usage of remember-mcp hybrid memory system
"""
import asyncio
from remember import RememberSystem


async def main():
    print("=" * 60)
    print("remember-mcp: Hybrid Memory System Demo")
    print("=" * 60)

    # Initialize system
    print("\n1. Initializing RememberSystem...")
    remember = RememberSystem(
        active_db="demo.db",
        archive_dir="demo_archives/",
        archive_threshold_days=30,
        archive_min_salience=0.3
    )
    print("   ✓ Active memory (OpenMemory) initialized")
    print("   ✓ Archive directory created")

    # Add some memories
    print("\n2. Adding memories to active storage...")

    memories = [
        {
            "content": "The user prefers Python over JavaScript for backend development",
            "tags": ["preference", "programming"],
            "type": "semantic"
        },
        {
            "content": "Yesterday we discussed the new AI project roadmap in the team meeting",
            "tags": ["work", "meeting"],
            "type": "episodic"
        },
        {
            "content": "To deploy the app, run: docker build -t myapp . && docker push myapp",
            "tags": ["devops", "deployment"],
            "type": "procedural"
        },
        {
            "content": "I'm really excited about the progress we're making on this project!",
            "tags": ["emotion", "project"],
            "type": "emotional"
        },
        {
            "content": "The key insight is that simplicity beats complexity in system design",
            "tags": ["wisdom", "design"],
            "type": "reflective"
        }
    ]

    for i, mem in enumerate(memories, 1):
        result = await remember.add_memory(
            content=mem["content"],
            user_id="demo_user",
            tags=mem["tags"]
        )
        print(f"   {i}. Added [{result['primary_sector']}] {mem['content'][:50]}...")

    # Query active memories
    print("\n3. Querying active memories...")

    queries = [
        "What are the user's programming preferences?",
        "Tell me about recent meetings",
        "How do I deploy the application?"
    ]

    for query in queries:
        print(f"\n   Query: '{query}'")
        results = await remember.query(
            query=query,
            user_id="demo_user",
            k=2,
            include_archive=False  # Only search active for now
        )

        for j, mem in enumerate(results, 1):
            print(f"      {j}. [score: {mem.score:.3f}, {mem.location.value}]")
            print(f"         {mem.content[:60]}...")
            print(f"         Sector: {mem.primary_sector}, Salience: {mem.salience:.3f}")

    # Get system stats
    print("\n4. System Statistics...")
    stats = await remember.get_stats(user_id="demo_user")
    print(f"   Active memories: {stats.active_count}")
    print(f"   Archived memories: {stats.archive_count}")
    print(f"   Total size: {stats.total_size:,} bytes")
    print(f"   Active DB: {stats.active_db_size:,} bytes")
    print(f"   Archives: {stats.archive_size:,} bytes")

    # Demonstrate archival (commented out - requires old memories)
    print("\n5. Archival System...")
    print("   Note: Archival requires memories older than threshold")
    print(f"   Current threshold: {remember.archive_threshold_days} days")
    print(f"   Min salience: {remember.archive_min_salience}")
    print("   (Demo skipped - no old memories to archive)")

    # Cleanup
    print("\n6. Cleanup...")
    remember.close()
    print("   ✓ System closed")

    print("\n" + "=" * 60)
    print("Demo complete!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
