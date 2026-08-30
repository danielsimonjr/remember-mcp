"""
MCP 2026-07-28 (informally "MCP 2.0") protocol compliance for remember-mcp.

The stateless revision replaces the ``initialize`` / ``initialized`` handshake
with per-request ``_meta`` and optional ``server/discover`` capability discovery.
FastMCP 4 (MCP Python SDK v2) implements the wire protocol; these tests pin the
behaviour this server must preserve for modern clients.
"""
from __future__ import annotations

import time

import pytest

from tests.mcp_stdio import (
    MCP2_PROTOCOL_VERSION,
    exchange,
    mcp2_meta,
    send_jsonrpc,
    spawn_server,
)

EXPECTED_TOOL_NAMES = {
    "add_memory",
    "query_memory",
    "archive_memories",
    "recall_memory",
    "get_stats",
    "scheduler_status",
    "scheduler_control",
    "index_file",
    "index_directory",
    "search_files",
    "list_indexed_files",
    "get_file_info",
    "get_file_stats",
}


def test_server_discover_advertises_mcp2():
    """``server/discover`` must list 2026-07-28 and return serverInfo in _meta."""
    response = exchange(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "server/discover",
                "params": {"_meta": mcp2_meta()},
            }
        ]
    )[0]

    assert response is not None
    assert "error" not in response, response.get("error")
    result = response["result"]
    assert MCP2_PROTOCOL_VERSION in result["supportedVersions"]
    server_info = result["_meta"]["io.modelcontextprotocol/serverInfo"]
    assert server_info["name"] == "remember"
    assert "tools" in result["capabilities"]


def test_tools_list_without_initialize():
    """Stateless clients may call ``tools/list`` with only per-request _meta."""
    response = exchange(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {"_meta": mcp2_meta()},
            }
        ]
    )[0]

    assert response is not None
    assert "error" not in response, response.get("error")
    tool_names = {tool["name"] for tool in response["result"]["tools"]}
    assert tool_names == EXPECTED_TOOL_NAMES


def test_discover_completes_within_startup_budget():
    """First ``server/discover`` must stay within Claude Code's startup window."""
    budget_sec = 10.0
    proc = spawn_server()
    try:
        t0 = time.monotonic()
        _, response = send_jsonrpc(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "server/discover",
                "params": {"_meta": mcp2_meta()},
            },
        )
        elapsed = time.monotonic() - t0
    finally:
        proc.terminate()
        proc.wait(timeout=5)

    assert response is not None
    assert elapsed < budget_sec, (
        f"server/discover took {elapsed:.2f}s; heavy imports may not be deferred"
    )


@pytest.mark.parametrize(
    "protocol_version",
    ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"],
)
def test_legacy_initialize_still_supported(protocol_version: str):
    """Handshake-era clients remain supported during the one-year grace period."""
    response = exchange(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": protocol_version,
                    "capabilities": {},
                    "clientInfo": {"name": "legacy-test", "version": "0.0.1"},
                },
            }
        ]
    )[0]

    assert response is not None
    assert "error" not in response, response.get("error")
    assert response["result"]["protocolVersion"] == protocol_version
    assert response["result"]["serverInfo"]["name"] == "remember"
