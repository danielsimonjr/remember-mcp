# Overview

> **Runtime note (v2.0):** this server is now **TypeScript on Bun**. The
> documents in this folder were originally generated against the Python
> FastMCP layout; the *behavior* they describe (13 tools, hybrid
> active→archive lifecycle, QR-video file index, lazy startup) still holds.
> Paths that said `server.py` / `remember/*.py` map to `src/index.ts` /
> `src/remember/*.ts`. Active storage is `bun:sqlite` (replacing
> openmemory-python); archives are QR frames + ffmpeg MP4 with a JSON
> embedding sidecar (replacing memvid/FAISS).

`remember-mcp` is a **hybrid long-term memory MCP server**. It keeps recent, salient
memories in a queryable active store and ages the rest into **video** archives, then
recalls them on demand.

Two layers do the heavy lifting:

| Layer | Implementation | Role |
|---|---|---|
| **Active** | `bun:sqlite` + hashed embeddings | Hot store with salience, decay, and sector tags |
| **Archive** | QR frames → ffmpeg MP4 + JSON sidecar | Cold store; semantic search over sidecar embeddings |

The unusual part is the archive: a memory that decays below the salience floor is written
into a video file (plus a `.json` sidecar) and deleted from the active database.
Recall reverses the trip.

## What it can do

**13 MCP tools**, in three groups.

- **Memory (5)** — `add_memory`, `query_memory`, `archive_memories`, `recall_memory`,
  `get_stats`
- **Scheduler (2)** — `scheduler_status`, `scheduler_control`
- **File index (6)** — `index_file`, `index_directory`, `search_files`,
  `list_indexed_files`, `get_file_info`, `get_file_stats`

## Layout

```
src/index.ts           MCP stdio entry (Bun)
src/server.ts          buildServer() — tool registration
src/tools.ts           13 tool defs + handlers, lazy singletons
src/remember/
  system.ts            RememberSystem — hybrid active+archive manager
  active-store.ts      bun:sqlite active memory
  archive.ts           QR + ffmpeg encode / sidecar search
  file-indexer.ts      FileIndexer — file-chunking/video-index application
  scheduler.ts         ArchivalScheduler — periodic archival
  types.ts             Shared types
  embeddings.ts        Fast hashed embeddings (no model download)
  sectors.ts           Keyword sector classifier
tests/                 bun:test suite
```

## Operating constraints

- **stdio is the transport, so stdout is reserved.** Diagnostics go to stderr.
- **Heavy work is deferred.** QR/ffmpeg archival and SQLite construction wait
  until the first `tools/call`. `initialize` stays well under Claude Code's
  startup window.
- **ffmpeg must be on PATH** for archival and file indexing encodes.
