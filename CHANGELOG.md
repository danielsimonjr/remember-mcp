# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
