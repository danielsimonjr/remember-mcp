"""
Timing test: MCP startup must complete well within Claude Code's startup window.

Heavy imports (sentence-transformers, FAISS, memvid, scipy) and the FAISS index
load were running at module-import / setup() time, blocking the first protocol
response for ~80-220s. Claude Code's default MCP startup window is ~30s, so the
server appeared broken on every fresh launch. After deferring those imports, the
floor is set by FastMCP itself; we budget 10s to leave headroom for a slightly
slower box without losing regression-detection power.

MCP 2026-07-28 uses ``server/discover`` instead of ``initialize``; this test
exercises that stateless path.

Run:
    uv run pytest tests/test_handshake_timing.py -v -s
"""
import time

from tests.mcp_stdio import MCP2_PROTOCOL_VERSION, mcp2_meta, send_jsonrpc, spawn_server

HANDSHAKE_BUDGET_SEC = 10.0


def _spawn_and_discover():
    """Spawn server.py, send server/discover, return seconds until first response."""
    proc = spawn_server()
    discover_msg = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "server/discover",
        "params": {"_meta": mcp2_meta()},
    }

    t0 = time.monotonic()
    try:
        line, response = send_jsonrpc(proc, discover_msg)
        elapsed = time.monotonic() - t0
        return elapsed, line, response
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def test_handshake_under_budget():
    elapsed, line, response = _spawn_and_discover()
    print(f"\nserver/discover time: {elapsed:.2f}s")
    print(f"Response: {line[:200]!r}")
    assert line, "Server returned no response to server/discover"
    assert response is not None
    assert MCP2_PROTOCOL_VERSION in response["result"]["supportedVersions"]
    assert elapsed < HANDSHAKE_BUDGET_SEC, (
        f"server/discover took {elapsed:.2f}s, exceeds {HANDSHAKE_BUDGET_SEC}s budget. "
        "Heavy imports / index loads are not deferred."
    )


if __name__ == "__main__":
    import sys

    elapsed, line, _ = _spawn_and_discover()
    print(f"server/discover: {elapsed:.2f}s")
    print(f"Response: {line[:300]!r}")
    sys.exit(0 if elapsed < HANDSHAKE_BUDGET_SEC else 1)
