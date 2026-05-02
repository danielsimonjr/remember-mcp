"""
Timing test: MCP handshake must complete well within Claude Code's startup
window.

Heavy imports (sentence-transformers, FAISS, memvid, scipy) and the FAISS
index load were running at module-import / setup() time, blocking the stdio
handshake for ~80-220s. Claude Code's default MCP startup window is ~30s,
so the server appeared broken on every fresh launch. After deferring those
imports, the floor is set by ``fastmcp`` itself (~6s on this box per
``python -X importtime``); we budget 10s to leave headroom for a slightly
slower box without losing regression-detection power — the original bug was
8-20x over this threshold.

Run:
    .venv/Scripts/python.exe -m pytest tests/test_handshake_timing.py -v -s
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server.py"
PYTHON = REPO / ".venv" / "Scripts" / "python.exe"
HANDSHAKE_BUDGET_SEC = 10.0


def _spawn_and_handshake():
    """Spawn server.py, send initialize, return seconds until first response."""
    if not PYTHON.exists():
        # Fall back to current interpreter when running outside the local venv.
        py = sys.executable
    else:
        py = str(PYTHON)

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    proc = subprocess.Popen(
        [py, "-X", "utf8", str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO),
        env=env,
    )

    init_msg = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "timing-test", "version": "0.0.1"},
        },
    }
    payload = (json.dumps(init_msg) + "\n").encode("utf-8")

    t0 = time.monotonic()
    try:
        proc.stdin.write(payload)
        proc.stdin.flush()
        # Read one line of stdout (the initialize response).
        line = proc.stdout.readline()
        elapsed = time.monotonic() - t0
        return elapsed, line
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def test_handshake_under_budget():
    elapsed, line = _spawn_and_handshake()
    print(f"\nHandshake time: {elapsed:.2f}s")
    print(f"Response: {line[:200]!r}")
    assert line, "Server returned no response to initialize"
    assert elapsed < HANDSHAKE_BUDGET_SEC, (
        f"Handshake took {elapsed:.2f}s, exceeds {HANDSHAKE_BUDGET_SEC}s budget. "
        "Heavy imports / index loads are not deferred."
    )


if __name__ == "__main__":
    elapsed, line = _spawn_and_handshake()
    print(f"Handshake: {elapsed:.2f}s")
    print(f"Response: {line[:300]!r}")
    sys.exit(0 if elapsed < HANDSHAKE_BUDGET_SEC else 1)
