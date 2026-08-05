# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security — setuptools and torch (2026-08-04)

Both open alerts cleared via `uv lock --upgrade-package`; `pyproject.toml`
unchanged.

- `setuptools` 81.0.0 -> 83.0.0 (medium)
- `torch` 2.12.1 -> 2.13.0 (low), pulled in transitively by
  `sentence-transformers` — it is neither declared in `pyproject.toml` nor
  imported anywhere in `src/`

The torch bump also carried `cuda-toolkit` 13.0.2 -> 13.0.3.0 and
`nvidia-cublas` 13.1.0.3 -> 13.1.1.3, which are torch's own pinned CUDA stack.

Verification is deliberately left to CI rather than done locally: syncing this
lock means a multi-GB torch/CUDA download, and CI already runs
`uv sync --frozen` followed by `uv run pytest -q` across the OS matrix on
Python 3.13 — which exercises the resolved lock more thoroughly than a single
local machine would.


### Security

- **11 high-severity Dependabot alerts closed with one targeted lock refresh.** Ten of the
  eleven were the *same package* under different advisories: `pillow < 12.3.0` (→ 12.3.0),
  plus `mcp < 1.28.1` (→ 1.29.0). Upgraded with
  `uv lock --upgrade-package pillow --upgrade-package mcp` rather than a blanket re-lock,
  so the blast radius stays reviewable.
- **Lockfile had drifted from its own manifest.** `pyproject.toml` pins
  `pydantic==2.13.4`, but `uv.lock` was resolving **2.11.7**. The refresh corrected it
  (and `pydantic-core` 2.33.2 → 2.46.4). Worth noting because a lock that disagrees with
  its manifest means *nobody was running the versions the manifest claims*.

### Fixed

- **CI could not have caught a dependency regression — now it can.** The `test` job ran
  `python -m compileall -q .` and nothing else: a **syntax gate**, guarding a repo with
  seven `test_*.py` files. The comment justifying this cited `faiss-cpu==1.7.4` /
  `numpy==1.26.4` having no cp313 wheels and `memvid` being an archived PyPI package
  capped at 0.1.3.
  **All three premises had expired.** `memvid` now resolves to `danielsimonjr/memvid`
  @ v0.2.0 over **git** (not PyPI), which pulls `faiss-cpu 1.13.2` and `numpy 2.4.4` —
  both shipping cp313 wheels. Proven before changing CI: `uv sync` completed on
  3.13.14 and `pytest` ran green. CI now installs with `uv sync --frozen` and runs
  `pytest`, with `compileall` retained as a fast pre-check.
  *The gate was honest when written and quietly went obsolete when the blocker was
  fixed elsewhere — nothing re-checked it.*

### Known gaps

- **Only 4 of the 7 `test_*.py` files contain any tests.** `test_file_indexing.py`,
  `test_tools.py` and `test_tools_async.py` are manual demo scripts (`async def main()`
  + `print()` + `if __name__ == "__main__"`); pytest collects **0** from them. They
  assert nothing and the `test_` prefix is cosmetic. The four real tests now run in CI;
  converting or renaming the other three is tracked separately.

### Added

- **Windows CI leg.** CI ran on `ubuntu-latest` only — but Windows is the *production*
  platform for this MCP server (it runs on Daniel's Windows box), so CI had never once
  tested the OS the server actually ships on. The `test` job now runs a
  `[ubuntu-latest, windows-latest]` matrix.

### Security
- **Patched transitive dependency vulnerabilities** in `uv.lock`: `cryptography` 47.0.0 → 49.0.0 (HIGH), `starlette` 1.2.1 → 1.3.1 (HIGH), `pydantic-settings` 2.14.0 → 2.14.2, `python-multipart` 0.0.27 → 0.0.32. All are indirect (pulled via the MCP/fastmcp stack). Two advisories have no upstream fix and are left as-is: `PyPDF2` (unmaintained — the maintained successor is `pypdf`) and a low-severity `torch` advisory.

### Fixed
- **Stdout pollution at runtime.** Routed the remaining `print()` calls that run during normal operation to stderr so they cannot corrupt the JSON-RPC stdio framing this server uses: the archival scheduler's status/error lines (`remember/scheduler.py`, via a new `_log` stderr helper), the archive-query error in `remember/system.py`, the memvid-encoding error in `remember/system.py`, and the file-search error in `remember/file_indexer.py` (now `logger.error`). Complements the v1.0.3 import-time stdout fix. (Verified via `py_compile` + a stdout-print sweep; full pytest suite not run locally — `memvid`/`openmemory` runtime deps absent in the dev shell.)

## [1.0.3] - 2026-05-01

### Documentation
- Add CycloneDX SBOM (sbom.json).

### Fixed

- **Stdout pollution at import (`remember/system.py`).** OpenMemory and
  memvid both `print(...)` at import time (e.g. "Warning: Google Generative
  AI library not available"). Stdio MCP servers reserve stdout for
  JSON-RPC framing — any stray byte breaks the protocol. The two
  vendor imports are now wrapped in `contextlib.redirect_stdout(sys.stderr)`
  so library notices land in the conventional log channel without
  corrupting the wire. Verified: `STDOUT_LEAK_LEN: 0` after import on
  the venv that produces the warnings.

### Performance

- **Defer heavy imports for sub-handshake-window MCP startup** (`server.py`).
  `RememberSystem`, `ArchivalScheduler`, and `FileIndexer` were imported at
  module top, transitively pulling in OpenMemory, memvid,
  sentence-transformers, FAISS, and scipy; on top of that, `main()` ran an
  eager `asyncio.run(setup())` that constructed both objects and loaded
  their FAISS indexes from disk before `app.run("stdio")` could process the
  `initialize` JSON-RPC message. Cold-start handshake measured 220.88s on a
  Windows/Dropbox box — Claude Code's MCP startup window is ~30s, so the
  server appeared broken on every fresh launch and Wave 4 round-trip
  testing only succeeded after lifting the harness cap to 150s. Heavy
  imports now live inside `get_system()` / `get_file_indexer()`, the eager
  `setup()` call is removed from `main()`, and concurrent first-use is
  serialized through an `asyncio.Lock`. Cold handshake now ~6-8s
  (floor set by `fastmcp` itself per `python -X importtime`); the heavy
  work runs on the first tool call that needs it (~60-90s, acceptable
  because the client is no longer racing the handshake timeout).
  Regression guard: `tests/test_handshake_timing.py` (10s budget).
  Tools that don't touch heavy state (`scheduler_status`,
  `scheduler_control`) continue to return without forcing init.

## [1.0.2] - 2026-04-30

### Fixed

- **SQLite concurrency race in archive flow** (`remember/system.py`).
  `archive_old_memories` previously ran SELECT, the (slow) memvid encode,
  and DELETE/COMMIT across separate `asyncio.to_thread` calls on the
  shared SQLite connection, allowing concurrent `add_memory` to interleave
  and corrupt state. The DELETE + COMMIT now run inside a `with conn:`
  transaction block, and an `asyncio.Lock` on the system instance
  serializes archive/add paths.
- **MemvidRetriever per-query reinstantiation leak**
  (`remember/system.py`, `remember/file_indexer.py`). Retrievers were
  constructed fresh inside every search loop, reloading the FAISS index
  and reopening the mp4 reader on every call (file-handle leak + slow).
  Retrievers are now cached keyed by `(video_path, index_path)` on the
  system / indexer instance. Both classes expose a `close()` that drops
  the pool; `server.main()` now calls them in a `finally:` block on exit.
- **Bare `except: pass` in `RememberSystem.get_stats`**. Two stat-size
  loops swallowed every exception — including programming bugs and
  permission errors — making corrupted archive index entries impossible
  to debug. Now catches `OSError` specifically and logs via
  `logger.warning`.
