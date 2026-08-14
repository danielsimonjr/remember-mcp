# Architecture

## The central idea

Memory is not one store. It is **two stores with a one-way default flow and an on-demand
return path**:

```
add_memory ─► ACTIVE (openmemory / SQLite)
                 │  salience decays over time
                 │  archive_old_memories(age, min_salience)
                 ▼
             ARCHIVE (memvid / .mp4 + .faiss + .json)
                 │  recall_from_archive(archive_file, content)
                 └──────────────► back into ACTIVE
```

Active storage answers fast and supports semantic query. Archive storage is cheap and
cold. The claim that justifies the design is compression: memories are encoded as QR
frames in a video, and video codecs are very good at repetitive frames.

## Why the boundaries sit where they do

**`RememberSystem` owns the lifecycle, not the storage.** It holds an `openmemory`
`MemorySystem` and a `memvid` encoder/retriever, and it is the only place that knows a
memory can live in two places. `server.py` never touches either library directly — it
translates MCP calls into `RememberSystem`/`FileIndexer` calls. That is what keeps the MCP
surface swappable and the lifecycle testable without a protocol client.

**`FileIndexer` is a separate application that happens to share a technique.** It also
uses memvid, but it indexes *files*, has its own store, and shares no state with the
memory system. It is a sibling of `RememberSystem`, not a layer beneath it. The
`server.py` grouping reflects this: six of the thirteen tools are file-index tools that
never touch conversational memory.

**`types.py` holds only what crosses a boundary** — `MemoryLocation`,
`HybridMemoryResult`, `ArchiveStats`, `SystemStats`. It imports nothing first-party, so
it is a leaf and can never participate in a cycle.

## Decisions that were forced by the runtime

### stdout belongs to JSON-RPC

The server speaks MCP over stdio. Anything written to stdout that is not a JSON-RPC frame
corrupts the protocol, and the failure looks like a hung or broken server rather than a
logging bug. Two consequences are visible in the source and are deliberate:

- Third-party imports are wrapped:
  `with contextlib.redirect_stdout(sys.stderr): from openmemory import ...`.
  Both `openmemory` and `memvid` print at import time (e.g. *"Google Generative AI library
  not available"*), and that text would otherwise land mid-handshake.
- Runtime logging goes to stderr. A past release had to move several `print()` calls that
  ran during normal operation for this reason.

### Heavy imports are deferred, and the budget is enforced

`sentence-transformers`, FAISS and `memvid` take seconds to import, and the FAISS index
load costs more. Doing that work at module scope blocked the handshake for **80–220 s**
against Claude Code's ~30 s MCP startup window — so the server appeared broken on every
launch. The fix is lazy construction behind `get_system()` / `get_file_indexer()`, guarded
by an `asyncio.Lock` so a burst of concurrent tool calls builds one instance, not several.

`tests/test_handshake_timing.py` spawns the real server, sends a real `initialize`, and
asserts a **10 s** budget. The floor is `fastmcp`'s own import cost (~6 s here), so 10 s
leaves headroom while still catching a regression that was 8–20× over.

### One embedding model for every sector

`openmemory` maps embedding models **per sector**: `REFLECTIVE` gets 768-dimension
`all-mpnet-base-v2`, every other sector gets 384-dimension `all-MiniLM-L6-v2`. But
`MemorySystem.add_memory` then calls `graph.create_similarity_waypoint`, which
cosine-compares the incoming memory against existing ones *regardless of sector*. Mixed
dimensions meet and numpy raises:

```
ValueError: shapes (384,) and (768,) not aligned
```

This fires on the **second** `add_memory` whenever the two memories classify into
different sectors — the normal path, not an edge case. `RememberSystem` therefore
constructs an explicit `EmbeddingProvider` with every sector pinned to one model
(`UNIFORM_EMBEDDING_MODEL`). The trade is deliberate: `REFLECTIVE` memories lose mpnet's
slightly stronger embeddings, and in exchange the vector space is uniform and the
comparison is well-defined.

### One normalized key for archive bookkeeping

Archive filenames have always normalized a missing user to `"default"`
(`f"user_{user_id or 'default'}_{timestamp}"`), and `_load_archive_index` parses that name
back out — so the on-disk world is keyed by `"default"`. The in-memory index and every
lookup used the raw `user_id`, so on the default (`user_id=None`) path the two never met:
archiving wrote the video, deleted the memories from active storage, and recorded nothing.
`get_stats` then reported zero archives and recall could not reach them.

`_archive_key()` now normalizes in one place, used by the index write and every lookup.
The lesson generalizes: **a value that is normalized when written must be normalized when
read, in the same function**, or the two conventions drift apart silently.

## Concurrency

- **`_write_lock`** (an `asyncio.Lock`) serializes archive/add/forget so a SELECT of
  eligible memories cannot interleave with a concurrent write before the matching DELETE.
- The DELETE runs inside `with conn:` so it commits or rolls back atomically.
- **`_retriever_cache`** keys `MemvidRetriever` instances by `(video_path, index_path)`,
  because constructing one reloads a FAISS index and reopens the mp4.

## Known architectural debts

- **`SystemStats.archive_count` counts archive *files*, not archived memories**, and
  `total_memories = active_count + archive_count` therefore adds memories to files. The
  number is not conserved across an archive that packs N memories into one video.
- **`logger` is defined at module scope in two files** (`system.py`, `file_indexer.py`).
  Harmless — each is a separate `logging.getLogger(__name__)` — but it is the one
  duplicate symbol in the repo.

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| runtimeCircularDeps | 0 | dependency-graph.json |
| entryRoots | 1 | dependency-graph.json |
| totalModules | 2 | dependency-graph.json |
