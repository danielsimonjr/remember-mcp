"""
Main MCP Server entry point for remember-mcp

Uses FastMCP to expose the hybrid memory system.
"""
import asyncio
from fastmcp import FastMCP
from remember.mcp.server_fastmcp import remember_mcp, get_system

__all__ = ["app", "setup"]

# The main app is the remember_mcp instance
app = remember_mcp


async def setup():
    """Initialize the remember system"""
    # Initialize the system before accepting requests
    get_system()


def main():
    """Main entry point"""
    # Initialize system first
    asyncio.run(setup())

    # Run the MCP server
    app.run(transport="stdio")


if __name__ == "__main__":
    main()
