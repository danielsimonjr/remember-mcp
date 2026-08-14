# Test Coverage

**10 collected tests across 8 files, carrying 23 assertions.** Both figures come from
running the suite and parsing it, not from a graph metric.

The suite was rebuilt in v1.1.1. Before that it was **4 collected tests carrying 2
assertions between them** — and that is not incidental history, it is the reason two real
bugs shipped. Read the gaps section with that in mind.

## What runs

| File | Tests | Asserts | What it actually proves |
|---|---:|---:|---|
| `test_archival.py` | 4 | 12 | Archive selection, no-op safety, **default-user archives are registered**, and confinement to `tmp_path` |
| `test_recall.py` | 2 | 6 | Archive → recall round trip restores to active; unknown archive does not inflate active |
| `test_tool_contract.py` | 2 | 2 | All 13 MCP tools registered, each with a description |
| `test_handshake_timing.py` | 1 | 2 | Real server spawn + `initialize` under a 10 s budget |
| `test_complete.py` | 1 | **0** | ⚠ Nothing — see gaps |
| `test_file_indexing.py` | **0** | 0 | ⚠ Not collected — see gaps |
| `list_tools.py` | — | 0 | Manual inspection script (not a test) |
| `__init__.py` | — | 0 | Package marker |

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

### `test_file_indexing.py` collects zero tests

79 lines defining `async def main()` under `if __name__ == "__main__"`. pytest collects
nothing from it, so `FileIndexer` — 555 lines, the largest module in the repo — has **no
automated coverage at all**. It is exercised only by running the file by hand.

This is the same shape as the two files deleted in v1.1.1: named `test_*`, sitting in
`tests/`, enforcing nothing.

### `test_complete.py` asserts nothing

162 lines, one collected test, zero assertions. It prints a six-stage walkthrough and
passes as long as nothing raises. It does exercise real paths (`RememberSystem` +
`ArchivalScheduler`), so it has smoke value — but it cannot distinguish correct output
from wrong output.

It also writes `test_phase2.db` and `test_archives/` into the **current working
directory** rather than a temp dir.

### Untested surface

| Area | State |
|---|---|
| `FileIndexer` (all 6 file-index tools) | No collected tests |
| `ArchivalScheduler` start/stop/run_now | No direct tests |
| `query_memory` archive-merge path | Not directly asserted |
| `get_stats` unit semantics | Not asserted — and the `archive_count` field is known to mix units |

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
| totalTypeScriptFiles | 15 | dependency-graph.json |

> Collected-test and assertion counts (10 / 23) are **not** graph metrics — they come from
> running `pytest` and parsing the test modules with `ast`. Stated here with their basis so
> a reader can tell a gate-enforced number from a hand-verified one.
