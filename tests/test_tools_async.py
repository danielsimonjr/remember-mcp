#!/usr/bin/env python3
"""Test if tools are registered on FastMCP app instance (async version)"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import asyncio
from server import app

async def main():
    print("FastMCP App Name:", app.name)
    print("\nRegistered Tools:")

    # Use get_tools() method (it's async)
    try:
        tools = await app.get_tools()
        print(f"Found {len(tools)} tools:")
        for tool in tools:
            print(f"  - {tool.name}")
            if hasattr(tool, 'description') and tool.description:
                desc = str(tool.description)[:80]
                print(f"    Description: {desc}...")
    except Exception as e:
        print(f"Error getting tools: {e}")
        print(f"Error type: {type(e).__name__}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
