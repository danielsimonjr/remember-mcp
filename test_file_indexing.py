#!/usr/bin/env python3
"""
Test file indexing functionality
"""
import asyncio
from remember.file_indexer import FileIndexer

async def main():
    print("=" * 60)
    print("Testing remember-mcp File Indexing")
    print("=" * 60)

    # Create indexer
    indexer = FileIndexer(index_dir="test_file_index/")

    # Test 1: Index this test file
    print("\n[Test 1] Indexing test_file_indexing.py...")
    result = indexer.index_file(
        __file__,
        chunk_size=512,
        overlap=64,
        preserve_lines=True
    )
    print(f"  Status: {result['status']}")
    print(f"  Chunks: {result.get('chunk_count', 0)}")
    print(f"  Video size: {result.get('video_size', 0)} bytes")
    print(f"  Compression: {result.get('compression_ratio', 0):.1f}x")

    # Test 2: Index the file_indexer.py module
    print("\n[Test 2] Indexing file_indexer.py...")
    result2 = indexer.index_file(
        "C:/mcp-servers/remember-mcp/remember/file_indexer.py",
        chunk_size=1024,
        overlap=128,
        preserve_lines=True
    )
    print(f"  Status: {result2['status']}")
    print(f"  Chunks: {result2.get('chunk_count', 0)}")

    # Test 3: List indexed files
    print("\n[Test 3] Listing indexed files...")
    files = indexer.list_indexed_files()
    print(f"  Total indexed files: {len(files)}")
    for f in files:
        print(f"    - {f['file_name']} ({f['file_type']}, {f['chunk_count']} chunks)")

    # Test 4: Search
    print("\n[Test 4] Searching for 'index file'...")
    results = indexer.search("index file", top_k=3)
    print(f"  Found {len(results)} results:")
    for i, r in enumerate(results, 1):
        print(f"    {i}. {r['file_name']} (score: {r['score']:.3f})")
        print(f"       {r.get('line_info', 'N/A')}")
        preview = r['content'][:100].replace('\n', ' ')
        print(f"       Preview: {preview}...")

    # Test 5: Get stats
    print("\n[Test 5] File index statistics...")
    stats = indexer.get_stats()
    print(f"  Total files: {stats['total_files']}")
    print(f"  Total chunks: {stats['total_chunks']}")
    print(f"  Source size: {stats['total_source_size']:,} bytes")
    print(f"  Video size: {stats['total_video_size']:,} bytes")
    print(f"  Compression: {stats['compression_ratio']:.1f}x")
    print(f"  File types: {stats['file_types']}")

    print("\n" + "=" * 60)
    print("All tests completed!")
    print("=" * 60)

if __name__ == "__main__":
    asyncio.run(main())
