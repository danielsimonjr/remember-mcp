# Changelog

All notable changes to this project will be documented in this file.

## 2026-09-03 - fastmcp 4.0.0: the constraint, not the lockfile

- Dependabot bumped `fastmcp` 4.0.0b5 -> 4.0.0 in `pyproject.toml`, and CI failed on both legs
  with `No solution found when resolving dependencies`. The cause was NOT a stale lockfile --
  `uv lock` failed for the same reason. `constraint-dependencies` still pinned
  `fastmcp-slim==4.0.0b5`, while `fastmcp 4.0.0` requires `fastmcp-slim[client,server]==4.0.0`
  exactly, so the two pins were mutually unsatisfiable.
- Moved the constraint to `4.0.0` rather than deleting it: it exists to keep the two aligned,
  and that intent is still correct now the release is final. Corrected the comment, which
  still described FastMCP 4 as prerelease.
- Verified against PyPI before changing anything: `fastmcp-slim 4.0.0` exists and is exactly
  what `fastmcp 4.0.0` declares. `uv lock` then resolves; 36 tests pass locally.

## [Unreleased]

## [1.3.0] - 2026-08-30

### Changed — MCP 2026-07-28 ("MCP 2.0") protocol

- Upgraded to **FastMCP 4.0.0b5** and **MCP Python SDK v2** (`mcp>=2.0`), which
  implement the stateless `2026-07-28` revision: per-request `_meta`,
  `server/discover` capability discovery, and no required `initialize` /
  `Mcp-Session-Id` session lifecycle.
- Legacy `initialize` handshake clients remain supported during the spec grace
  period (pinned by `tests/test_mcp2_protocol.py`).
- `tests/test_handshake_timing.py` now measures `server/discover` instead of
  `initialize`.
- Added `tests/test_mcp2_protocol.py` for MCP 2.0 wire compliance (discover,
  stateless `tools/list`, startup budget).

## [1.2.0] - 2026-08-14

Speed, reliability, security, and maintainability pass. Several of these were
load-bearing bugs that the previous suite could not see.

### Fixed — archive search was a no-op

`MemvidRetriever` takes `video_file` / `index_file`. The archive-query path
passed `video_path` / `index_path`, which raises `TypeError`. The exception was
swallowed per-archive, so hybrid search silently dropped every archived hit.
It also unpacked `search()`'s `List[str]` as `(chunk, score)` tuples — memvid
does not return scores from `search()`. Both are fixed: correct kwargs, and
`search_with_metadata` for real scores. Mutation-covered by
`test_query_reaches_archived_memories` and `tests/test_video.py`.

### Fixed — `age_days=0` and `min_salience=0.0` were ignored

`age_days or self.archive_threshold_days` treats `0` as missing, so an explicit
"archive now" from the MCP tool fell back to the 60-day default. Same for
`min_salience=0.0`. Defaults now apply only when the argument is `None`.

### Fixed — recall of an unknown archive invented a memory

`recall_from_archive` re-added `content` without checking that `archive_file`
was a registered archive. An unknown name (or a path-traversal string) created
a phantom active memory. Recall now resolves against the in-memory index only
and raises `FileNotFoundError` otherwise.

### Fixed — `SystemStats.archive_count` mixed files and memories

`archive_count` counted archive *files*, so `total_memories = active_count +
archive_count` was not conserved when N memories packed into one video. It is
now a memory count (recovered from the memvid JSON sidecar after restart).
`archive_file_count` is the file tally. `get_stats` exposes both.

### Fixed — encoding froze the server and held the write lock

`MemvidEncoder.build_video` ran on the event loop, inside `_write_lock`. Every
`add_memory` blocked for the duration of QR encoding, and memvid's own
`print("FRAMES: ...")` / ffmpeg summaries went to **stdout** — which is
JSON-RPC. Encoding now runs in a worker thread, without the write lock (a
separate `_archive_lock` serializes archival), with stdout redirected, Docker
disabled, and partial `.mp4`/`.json`/`.faiss` files removed on failure.

### Fixed — file-index stdio, glob escape, metadata races

- `FileIndexer` imported memvid with no stdout isolation (same JSON-RPC hazard).
- `Path.glob("../**")` could walk *out* of the requested directory; each file
  is now confined to that directory *and* the allow-list.
- `index_directory(exclude=...)` mutated the caller's list in place.
- Metadata JSON was written non-atomically; a crash left a half file that
  then crashed the next boot. Writes are `tmp` + `os.replace`; corrupt files
  are quarantined.
- Identical content at two paths overwrote the first path's metadata.
- Line-preserving chunk offsets were O(n²).

### Security

- Per-file size cap (32 MiB) and per-directory file cap (500).
- Binary / non-UTF-8 files refused (no more `errors='ignore'` on secrets in
  binaries).
- MCP tools validate empty content, `k`/`top_k` bounds, chunk_size/overlap,
  and unknown scheduler actions; they return `{"error": ...}` rather than
  raising through the protocol.
- `memvid` is pinned to a git **rev** (`1deb9b29…`) instead of `branch = main`,
  so `uv lock` cannot silently pick up a new main.

### Speed / stability

- SQLite WAL + busy_timeout on the openmemory connection.
- `get_stats` is one `COUNT`/`AVG` query instead of two.
- Archive search fans out per-video in worker threads.
- Retriever cache is a bounded LRU (32), not unbounded process-lifetime growth.
- `SELECT id, content` for eligibility, not `SELECT *` (skips embedding blobs).
- `get_file_info` looks up by path before hashing.

### Tests / CI / maintainability

- `tests/test_complete.py` was collected as `test_phase2` with **zero
  assertions** and wrote `test_phase2.db` into the working directory. It is
  now a real scheduler test in `tmp_path`.
- `tests/test_file_indexing.py` collected nothing; `FileIndexer` now has
  allow-list, glob, binary, size, metadata, and round-trip tests.
- CI no longer treats pytest exit 5 ("no tests collected") as success.
- `remember.__version__` was `1.0.0` against `pyproject.toml` `1.1.1`; both
  are `1.2.0` and pinned to each other.
- Dead `schedule` dependency removed (the scheduler is asyncio).
- Shared memvid helpers live in `remember/video.py` so the two call sites
  cannot drift on constructor names or stdout isolation again.

The architecture documents in `docs/architecture/` from the previous
unreleased work are included in this release and updated for the new module
and the closed `archive_count` debt.

### Added — architecture documentation, gated against drift

`docs/architecture/` now carries the ten canonical documents (OVERVIEW, ARCHITECTURE,
COMPONENTS, DATAFLOW, API, FILE_INVENTORY, TEST_COVERAGE, DEPENDENCY_GRAPH,
unused-analysis, duplicate-symbols), and README links them.

Every numeric claim is derived from a parse of the code and re-checked by
`repo_map.py check`, which exits non-zero on a stale value. **Mutation-verified**: editing
`totalLinesOfCode` to a wrong number makes the gate fail and name the drifted claim.

This required teaching the tool Python first — `repo_map` was JavaScript/TypeScript only
and reported this repo as an empty graph, so there was no gate to write against. That work
landed in `danielsimonjr/skills` (a Python resolver, an `ast`-based parser, per-repo
language detection that leaves every existing TS repo untouched, and Python entry-root
detection). Claims the gate cannot hold — the 13 MCP tools, the 29 collected tests — are
written with their actual basis stated rather than given a fake Verification row.

Findings recorded while writing, not discarded:

- `example.py` is the repo's only no-importer file — correct for a demo script, not a
  deletion candidate (confirmed by grep as a second method).
- All 5 "unused" exports are accounted for: two module loggers, one documented constant,
  and two entry points reached by a runtime rather than an import.
- `logger` is the single duplicate symbol (two module-local loggers) — benign.
- `server.py`'s three internal edges each appear twice, because the imports are deliberately
  made both lazily and under `TYPE_CHECKING` to keep heavy imports out of module scope.


## [1.1.1] - 2026-08-13

Two crash/data-visibility bugs in the core memory path, plus the reason neither
was ever caught: **the test suite asserted nothing.**

### Fixed — `add_memory` raised `ValueError` on the second memory

`add_memory` crashed with `ValueError: shapes (384,) and (768,) not aligned` as
soon as two memories classified into different sectors — which is the normal
path, not an edge case.

openmemory maps embedding models **per sector** (`embeddings.py`): `REFLECTIVE`
gets the 768-dimension `all-mpnet-base-v2`, every other sector gets the
384-dimension `all-MiniLM-L6-v2`. But `MemorySystem.add_memory` then calls
`graph.create_similarity_waypoint`, which cosine-compares the incoming memory
against existing ones *regardless of sector*. Mixed dimensions meet, and numpy
raises. Visible in the logs as two different models loading back to back
(`Loading weights: 199/199` then `103/103`).

`RememberSystem` now constructs an explicit `EmbeddingProvider` with every
sector pinned to one model, so the vector space is uniform. Cost: `REFLECTIVE`
memories lose mpnet's slightly stronger embeddings — the right trade against a
space that raises.

### Fixed — archiving without a user_id orphaned the archive

`archive_old_memories` guarded its index update with `if user_id:`. The default
path (`user_id=None`) — which is what the `archive_memories` **MCP tool** uses —
wrote the `.mp4`/`.faiss`/`.json`, **deleted the memories from active storage**,
and recorded nothing. `get_stats` then reported `archive_count=0` and
`total_memories=0`, and query/recall could not reach them: the memories read as
destroyed while 261 KB of their data sat on disk.

Archive *filenames* had always normalized `None` → `"default"`
(`f"user_{user_id or 'default'}_{timestamp}"`), and `_load_archive_index` parsed
that back out — so even a restart recovered the archive under `"default"` while
every lookup asked for `None`. Three sites disagreed about one key. Normalized
into a single `_archive_key()` helper used by the index write and all lookups.

Data was never actually lost — but it was unreachable and reported as gone.

### Fixed — the test suite asserted almost nothing

This is why both bugs shipped. Before: 8 test files, **4 collected tests, 2
assertions in total** (both in `test_handshake_timing.py`, the one genuinely
good file).

- **`tests/test_tools.py` and `tests/test_tools_async.py` — deleted.** Near-identical
  copies of each other; neither contained an `assert`; both wrapped everything in
  `try/except` that swallowed failures; neither was collectable by pytest (their
  bodies sat under `if __name__ == "__main__"`); and both called
  `app.get_tools()`, the **fastmcp 2.x** API, while this project requires
  `fastmcp>=3.2.0` where it is `list_tools()`. Dead *and* broken *and* silent.
- **`tests/test_tool_contract.py` — added.** Pins the full 13-tool MCP surface as a
  set and requires every tool to carry a description. Mutation-verified: removing
  one `@app.tool()` decorator makes it fail and name the missing tool.
- **`tests/test_archival.py` — rewritten.** Had zero assertions and ran against
  `remember_mcp.db` in the repo root (the real 184 KB working database), calling
  `archive_old_memories()` on it — destructive and non-deterministic. Now builds
  its corpus in `tmp_path`. Includes the regression test for the orphaned-archive
  bug, mutation-verified against the restored `if user_id:` guard.
- **`tests/test_recall.py` — rewritten.** Had zero assertions, used the real
  database, and hardcoded `archive_file = "user_default_1762577738"` — an archive
  from one machine at one instant, which exists nowhere else. It now creates its
  own archive and asserts the round trip restores the memory.

**4 collected tests → 10, and they assert.**

### Removed — `requirements.txt`

A second, unmaintained dependency list that omitted **`mcp`, `pydantic`
(including its exact `==2.13.4` pin) and `scipy`**, and tracked `memvid`'s
`main` branch instead of the commit pinned in `uv.lock`. `README.md` told users
to `pip install -r requirements.txt` **twice**, so the documented install
produced an environment that did not match CI. `pyproject.toml` + `uv.lock` are
authoritative (CI runs `uv sync --frozen`); README now documents `uv sync`. This
is the same defect class as the `setup.py` removed in 1.1.0 — a duplicate source
of truth that can only drift.

Also corrected the README's Development section, which named
`python test_complete.py` / `test_file_indexing.py` / `list_tools.py` — paths
that do not exist, since those files live under `tests/`.

### Known issues (recorded, not fixed here)

- `SystemStats.archive_count` counts archive **files**, not archived memories, so
  `total_memories = active_count + archive_count` adds memories to files and is
  not conserved across an archive that packs N memories into one video.
- `tests/test_complete.py` and `tests/test_file_indexing.py` still contain no
  assertions; the latter is not collected by pytest at all.

## [1.1.0] - 2026-08-13

Rolls up every change since `v1.0.3` — a long run of security work that had never been
tagged. Minor rather than patch because `fastmcp` crossed a **major** boundary (2.x -> 3.4.2)
under the entries below, which changes the server's runtime, not just its dependency pins.

### Removed — the vestigial `setup.py`

`setup.py` was dead weight that actively contradicted the real metadata, and had drifted
unnoticed for three releases. Every field disagreed with `pyproject.toml`:

| Field | `setup.py` claimed | `pyproject.toml` (authoritative) |
|---|---|---|
| `version` | `1.0.0` | `1.0.3` — stale by 3 releases |
| `python_requires` | `>=3.8` | `==3.13.*` |
| `mcp` | `>=0.9.0` | `>=1.23.0` |
| `fastmcp` | *absent entirely* | `>=3.2.0` |
| `numpy` | `>=1.24.0` | `>=2.0` |

Its `console_scripts` entry point pointed at `remember.mcp.server:main` — **a module that
does not exist**; the package is flat (`remember/{__init__,file_indexer,scheduler,system,
types}.py`). Nothing references the file. Under PEP 621 the `[project]` table is
authoritative and setuptools ignores the duplicated `setup()` metadata, so this was a second
"source of truth" that could only ever be wrong. Deleted rather than synced: keeping two
version sources is the defect, and syncing them just re-arms it.

> **Note for the next release:** `uv.lock` records the project's **own** version
> (`[[package]] name = "remember-mcp"`). CI runs `uv sync --frozen`, so bumping
> `pyproject.toml` without re-running `uv lock` fails the build. Bump and re-lock together.

### Security — pypdf 6.14.2 -> 6.15.0 (2026-08-13)

Two medium advisories, both the same package. `pypdf` is transitive: it arrives through
`memvid@0.2.0`, which this project consumes as a **git dependency** rather than from PyPI.

`uv lock --upgrade-package pypdf` moved it without touching anything else — verified from
the diff rather than the command's summary line: the change is exactly three lines, the
version and its wheel hashes, and no second package appears. (A local `uv sync` also moved
torch 2.12.1 -> 2.13.0, which is the *virtualenv* catching up to a lock entry that was
already 2.13.0, not part of this change.)

Gate matches CI (`uv sync --frozen`, `uv run pytest -q`): 4 passed.

### Security — cryptography 49.0.0 -> 50.0.0 (2026-08-04)

High-severity alert raised minutes after the setuptools/torch push. Cleared with
`uv lock --upgrade-package cryptography`; `pyproject.toml` unchanged. Same
reasoning as below: CI's `uv sync --frozen` + `pytest` across the OS matrix is
the verification, not a multi-GB local sync.

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
  platform for this MCP server (it runs on the user's Windows box), so CI had never once
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
