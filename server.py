"""
Main MCP Server entry point for remember-mcp

Uses FastMCP to expose the hybrid memory system.
"""
from fastmcp import FastMCP
from remember.mcp.server_fastmcp import remember_mcp

__all__ = ["app"]

# The main app is the remember_mcp instance
app = remember_mcp


def main():
    """Main entry point"""
    app.run(transport="stdio")


if __name__ == "__main__":
    main()
