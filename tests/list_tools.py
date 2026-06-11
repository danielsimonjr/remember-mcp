#!/usr/bin/env python3
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import asyncio
from server import app

async def main():
    # fastmcp 3.x renamed get_tools() -> list_tools()
    tools = await app.list_tools()
    print(f"Found {len(tools)} tools:")
    for tool in tools:
        print(f"  - {tool.name}")
        if hasattr(tool, 'description') and tool.description:
            print(f"    Description: {tool.description[:60]}...")

asyncio.run(main())
