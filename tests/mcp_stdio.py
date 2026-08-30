"""Shared helpers for driving ``server.py`` over stdio in integration tests."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server.py"
PYTHON = REPO / ".venv" / "Scripts" / "python.exe"

MCP2_PROTOCOL_VERSION = "2026-07-28"


def python_executable() -> str:
    if PYTHON.exists():
        return str(PYTHON)
    return sys.executable


def mcp2_meta(
    *,
    protocol_version: str = MCP2_PROTOCOL_VERSION,
    client_name: str = "remember-mcp-test",
    client_version: str = "0.0.1",
) -> Dict[str, Any]:
    """Build the per-request ``_meta`` block required by MCP 2026-07-28."""
    return {
        "io.modelcontextprotocol/protocolVersion": protocol_version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
            "name": client_name,
            "version": client_version,
        },
    }


def spawn_server() -> subprocess.Popen:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.Popen(
        [python_executable(), "-X", "utf8", str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO),
        env=env,
    )


def send_jsonrpc(
    proc: subprocess.Popen,
    message: Dict[str, Any],
) -> Tuple[bytes, Optional[Dict[str, Any]]]:
    """Write one JSON-RPC message and read one response line."""
    payload = (json.dumps(message) + "\n").encode("utf-8")
    assert proc.stdin is not None
    assert proc.stdout is not None
    proc.stdin.write(payload)
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line.strip():
        return line, None
    return line, json.loads(line)


def exchange(
    messages: List[Dict[str, Any]],
) -> List[Optional[Dict[str, Any]]]:
    """Spawn the server, send messages in order, return parsed responses."""
    proc = spawn_server()
    responses: List[Optional[Dict[str, Any]]] = []
    try:
        for message in messages:
            _, parsed = send_jsonrpc(proc, message)
            responses.append(parsed)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    return responses
