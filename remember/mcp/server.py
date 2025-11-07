"""
MCP Server for remember-mcp

Exposes hybrid memory system via Model Context Protocol.
"""
import asyncio
import json
import sys
from typing import Any, Dict
from mcp.server.models import InitializationOptions
from mcp.server import Server
from mcp.types import Tool, TextContent

from ..system import RememberSystem
from ..scheduler import ArchivalScheduler


# Initialize system
remember_system = None
scheduler = None


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


# Create MCP server
server = Server("remember-mcp")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available MCP tools"""
    return [
        Tool(
            name="add_memory",
            description="Add a new memory to active storage",
            inputSchema={
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "Memory content"
                    },
                    "user_id": {
                        "type": "string",
                        "description": "Optional user ID for isolation"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional tags"
                    },
                    "metadata": {
                        "type": "object",
                        "description": "Optional metadata"
                    }
                },
                "required": ["content"]
            }
        ),
        Tool(
            name="query_memory",
            description="Query memories with hybrid search (active + archive)",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Query string"
                    },
                    "k": {
                        "type": "number",
                        "description": "Number of results (default: 10)"
                    },
                    "user_id": {
                        "type": "string",
                        "description": "Optional user ID filter"
                    },
                    "include_archive": {
                        "type": "boolean",
                        "description": "Search archives (default: true)"
                    },
                    "sectors": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional sector filter"
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="archive_memories",
            description="Archive old/decayed memories to video format",
            inputSchema={
                "type": "object",
                "properties": {
                    "age_days": {
                        "type": "number",
                        "description": "Minimum age in days"
                    },
                    "min_salience": {
                        "type": "number",
                        "description": "Maximum salience to archive"
                    },
                    "user_id": {
                        "type": "string",
                        "description": "Optional user filter"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="recall_memory",
            description="Recall archived memory back to active storage",
            inputSchema={
                "type": "object",
                "properties": {
                    "archive_file": {
                        "type": "string",
                        "description": "Archive filename"
                    },
                    "content": {
                        "type": "string",
                        "description": "Memory content to recall"
                    },
                    "user_id": {
                        "type": "string",
                        "description": "Optional user ID"
                    }
                },
                "required": ["archive_file", "content"]
            }
        ),
        Tool(
            name="get_stats",
            description="Get system statistics",
            inputSchema={
                "type": "object",
                "properties": {
                    "user_id": {
                        "type": "string",
                        "description": "Optional user filter"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="scheduler_status",
            description="Get archival scheduler status",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="scheduler_control",
            description="Control archival scheduler (start/stop/run)",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "stop", "run_now"],
                        "description": "Scheduler action"
                    }
                },
                "required": ["action"]
            }
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> list[TextContent]:
    """Handle tool calls"""
    system = get_system()

    try:
        if name == "add_memory":
            result = await system.add_memory(
                content=arguments["content"],
                user_id=arguments.get("user_id"),
                tags=arguments.get("tags"),
                metadata=arguments.get("metadata")
            )
            return [TextContent(
                type="text",
                text=json.dumps(result, indent=2)
            )]

        elif name == "query_memory":
            results = await system.query(
                query=arguments["query"],
                k=arguments.get("k", 10),
                user_id=arguments.get("user_id"),
                include_archive=arguments.get("include_archive", True),
                sectors=arguments.get("sectors")
            )

            # Convert to dict
            results_dict = [
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

            return [TextContent(
                type="text",
                text=json.dumps(results_dict, indent=2)
            )]

        elif name == "archive_memories":
            stats = await system.archive_old_memories(
                age_days=arguments.get("age_days"),
                min_salience=arguments.get("min_salience"),
                user_id=arguments.get("user_id")
            )

            stats_dict = {
                "archived_count": stats.archived_count,
                "active_remaining": stats.active_remaining,
                "archive_size_bytes": stats.archive_size_bytes,
                "compression_ratio": stats.compression_ratio
            }

            return [TextContent(
                type="text",
                text=json.dumps(stats_dict, indent=2)
            )]

        elif name == "recall_memory":
            result = await system.recall_from_archive(
                archive_file=arguments["archive_file"],
                content=arguments["content"],
                user_id=arguments.get("user_id")
            )

            return [TextContent(
                type="text",
                text=json.dumps(result, indent=2)
            )]

        elif name == "get_stats":
            stats = await system.get_stats(
                user_id=arguments.get("user_id")
            )

            stats_dict = {
                "active_count": stats.active_count,
                "archive_count": stats.archive_count,
                "total_memories": stats.total_memories,
                "active_db_size": stats.active_db_size,
                "archive_size": stats.archive_size,
                "total_size": stats.total_size,
                "compression_ratio": stats.compression_ratio,
                "avg_salience": stats.avg_salience
            }

            return [TextContent(
                type="text",
                text=json.dumps(stats_dict, indent=2)
            )]

        elif name == "scheduler_status":
            global scheduler
            status = scheduler.get_status() if scheduler else {"error": "Scheduler not initialized"}

            return [TextContent(
                type="text",
                text=json.dumps(status, indent=2)
            )]

        elif name == "scheduler_control":
            global scheduler
            action = arguments["action"]

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

            return [TextContent(
                type="text",
                text=json.dumps({"status": message})
            )]

        else:
            raise ValueError(f"Unknown tool: {name}")

    except Exception as e:
        return [TextContent(
            type="text",
            text=json.dumps({"error": str(e)})
        )]


async def main():
    """Main entry point for MCP server"""
    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="remember-mcp",
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=None,
                    experimental_capabilities={}
                )
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
