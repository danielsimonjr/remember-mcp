# Test Coverage

**29 collected tests across 10 test modules.** Both figures come from
running the suite (`uv run pytest -q` → 29 passed), not from a graph metric.

The suite was rebuilt in v1.1.1. Before that it was **4 collected tests carrying 2
assertions between them** — and that is not incidental history, it is the reason two real
bugs shipped. Read the gaps section with that in mind.

## What runs

| File | Tests | What it actually proves |
|---|---:|---|
| `test_archival.py` | 7 | Archive selection, default-user registration, stats conservation, `age_days=0`, hybrid query, empty content |
| `test_recall.py` | 3 | Archive → recall round trip; unknown archive / path traversal do not invent memories |
| `test_tool_contract.py` | 2 | All 13 MCP tools registered, each with a description |
| `test_handshake_timing.py` | 1 | Real server spawn + `initialize` under a 10 s budget |
| `test_complete.py` | 2 | Scheduler start/stop/`run_now`; rejects nonpositive interval |
| `test_file_indexing.py` | 10 | Allow-list, dotfiles, glob confinement, binary/size, metadata, round trip |
| `test_video.py` | 3 | `search_with_scores` does not unpack strings; sidecar chunk counts |
| `test_version.py` | 1 | `__version__` matches `pyproject.toml` |
| `list_tools.py` | — | Manual inspection script (not a test) |
| `__init__.py` | — | Package marker |

## The tests that are load-bearing

**`test_tool_contract.py`** pins the MCP surface as a set. Nothing else in the suite goes
through the MCP layer — every other test drives `RememberSystem`/`FileIndexer` directly —
so without it, a tool silently failing to register would be invisible.
**Mutation-verified:** removing one `@app.tool()` decorator fails it and names the missing
tool.

**`test_archival.py::test_default_user_archive_is_recorded_not_orphaned`** guards the
`user_id=None` path that once wrote a video, deleted the memories, and recorded nothing.
**Mutation-verified:** restoring the old `if user_id:` guard fails it with
*"archive_index is empty — the archive was orphaned"*.

**`test_handshake_timing.py`** is the only test that exercises the real process boundary.
It catches the regression class — heavy imports creeping back to module scope — that once
made the server unusable while every unit test stayed green.

## Gaps that matter

### `test_file_indexing.py` covers FileIndexer

Allow-list, dotfiles, glob confinement, binary/size rejection, atomic metadata
quarantine, and a real index+search round trip. The previous body sat under
`__main__` and collected nothing.

### `test_complete.py` covers ArchivalScheduler

start / `run_now` / stop, isolated to `tmp_path`. The previous `test_phase2`
asserted nothing and wrote `test_phase2.db` into the working directory.

### Gaps that remain

| Area | State |
|---|---|
| MCP tool *invocation* (not just registration) | Not driven through FastMCP in-process |
| `query_memory` MCP wrapper serialization | Covered at the Python layer by `test_query_reaches_archived_memories` |

## What the rebuild fixed

| Before (≤1.1.0) | After (1.1.1) |
|---|---|
| 4 collected tests, **2 assertions total** | 10 collected tests, 23 assertions |
| `test_archival.py` ran against the **real** `remember_mcp.db` and archived live data | Isolated to `tmp_path` |
| `test_recall.py` hardcoded `user_default_1762577738` — an archive from one machine | Builds its own archive |
| `test_tools.py` + `test_tools_async.py`: duplicates, 0 asserts, uncollectable, calling the removed fastmcp 2.x `get_tools()` | Deleted; replaced by a mutation-verified contract test |

## Running it

```bash
uv sync              # from uv.lock — same as CI
uv run pytest -q     # the gate CI runs
```

CI runs `python -m compileall`, then `uv sync --frozen`, then `pytest`, on
**ubuntu-latest and windows-latest**. Windows is the production platform.

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| testOnlyFiles | 1 | dependency-graph.json |
| totalTypeScriptFiles | 18 | dependency-graph.json |

> Collected-test count (29) is **not** a graph metric — it comes from
> running `pytest`. Stated here with its basis so a reader can tell a
> gate-enforced number from a hand-verified one.
