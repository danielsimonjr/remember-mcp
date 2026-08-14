# Overview

`remember-mcp` is a **hybrid long-term memory MCP server**. It keeps recent, salient
memories in a queryable active store and ages the rest into **video** archives, then
recalls them on demand.

Two libraries do the heavy lifting:

| Layer | Library | Role |
|---|---|---|
| **Active** | `openmemory` | SQLite-backed store with salience, decay, and sector-typed embeddings |
| **Archive** | `memvid` | Encodes memories as QR frames in an `.mp4`, with a FAISS index beside it |

The unusual part is the archive: a memory that decays below the salience floor is written
into a video file (plus `.faiss` + `.json` sidecars) and deleted from the active database.
Recall reverses the trip. The claimed win is compression — a run of this repo's own test
corpus packed three memories into 254,887 bytes of `.mp4`.

## What it can do

**13 MCP tools**, in three groups. (Tool count and names are derived by parsing
`server.py`'s `@app.tool()` decorators with `ast` — a direct source fact, **not** a
`repo_map` graph metric.)

- **Memory (5)** — `add_memory`, `query_memory`, `archive_memories`, `recall_memory`,
  `get_stats`
- **Scheduler (2)** — `scheduler_status`, `scheduler_control`
- **File index (6)** — `index_file`, `index_directory`, `search_files`,
  `list_indexed_files`, `get_file_info`, `get_file_stats`

The file-index group is a second, independent memvid application: it chunks and indexes
*files* into their own video store, unrelated to conversational memory.

## Layout

```
server.py              MCP surface — the 13 tools, lazy singletons, stdio transport
remember/
  system.py            RememberSystem — the hybrid active+archive manager
  video.py             Shared memvid helpers (stdout isolation, encoder, LRU cache)
  file_indexer.py      FileIndexer — the file-chunking/video-index application
  scheduler.py         ArchivalScheduler — periodic archival
  types.py             Dataclasses crossing the boundary
  __init__.py          Re-exports RememberSystem
example.py             Standalone demo (orphan by design — nothing imports it)
tests/                 pytest suite
```

`server.py` is the only entry root. Everything reachable hangs off it; `example.py` is
the single file with no importer, which is correct for a demo script.

## Numbers

| | |
|---|---|
| Python files (tracked) | 18 |
| Entry roots | 1 (`server.py`) |
| Runtime circular dependencies | 0 |
| Files with no importer | 1 (`example.py`) |
| MCP tools | 13 *(source-parsed, not a graph metric)* |
| Collected tests | 29 *(from a real `pytest` run, not a graph metric)* |

## Operating constraints worth knowing before you read the code

- **stdio is the transport, so stdout is reserved.** Any `print()` reachable at runtime
  corrupts JSON-RPC framing. Library imports are wrapped in
  `contextlib.redirect_stdout(sys.stderr)` for exactly this reason.
- **Heavy imports are deferred.** `sentence-transformers`, FAISS and `memvid` cost seconds
  to load; importing them at module scope pushed the MCP handshake past Claude Code's
  ~30 s startup window. `tests/test_handshake_timing.py` pins a 10 s budget.
- **All sectors share one embedding model.** `openmemory` maps a different model per
  sector by default (768-dim for `REFLECTIVE`, 384-dim elsewhere) and then compares
  embeddings *across* sectors — which raises. See `ARCHITECTURE.md`.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — why it is built this way
- [`COMPONENTS.md`](COMPONENTS.md) — each module, with real signatures
- [`DATAFLOW.md`](DATAFLOW.md) — how a request travels end to end
- [`API.md`](API.md) — the full public surface
- [`FILE_INVENTORY.md`](FILE_INVENTORY.md) — every file and its disposition
- [`TEST_COVERAGE.md`](TEST_COVERAGE.md) — what is tested, and the gaps that matter
- [`DEPENDENCY_GRAPH.md`](DEPENDENCY_GRAPH.md) — who imports whom
- [`unused-analysis.md`](unused-analysis.md) — files and exports with no importer
- [`duplicate-symbols.md`](duplicate-symbols.md) — names defined more than once

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalTypeScriptFiles | 18 | dependency-graph.json |
| totalLinesOfCode | 3268 | dependency-graph.json |
| totalExports | 31 | dependency-graph.json |
| entryRoots | 1 | dependency-graph.json |
| runtimeCircularDeps | 0 | dependency-graph.json |
| noImporterFileCount | 1 | unused-analysis.json |

> `totalTypeScriptFiles` counts **Python** files here. The key name is the graph
> schema's, shared by every language `repo_map` supports; renaming it would break every
> existing TypeScript repo's Verification block. Read it as "total source files".
