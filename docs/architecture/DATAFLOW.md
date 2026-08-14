# Data Flow

Four operations carry the system. Each is traced from the MCP frame to the store and back.

---

## 1. Startup and the handshake

```
Claude Code ──spawn──► python server.py
                         │  import fastmcp                (~6 s — the floor)
                         │  import remember.*             (deferred, NOT at module scope)
                         ▼
                    stdio transport ready
Claude Code ──initialize──► server ──result──► Claude Code      must land < 10 s
```

**Nothing heavy is imported here.** `sentence-transformers`, FAISS and `memvid` are pulled
in on the first tool call, not at import. Doing it eagerly once blocked the handshake for
80–220 s against a ~30 s window, so the server read as broken on every launch.
`tests/test_handshake_timing.py` spawns the real process and asserts the budget.

Third-party imports are wrapped in `contextlib.redirect_stdout(sys.stderr)` — both
libraries print at import time, and on this transport stdout is JSON-RPC only.

---

## 2. `add_memory`

```
tools/call add_memory
   └─► server.add_memory
         └─► get_system()                    lazy build, under asyncio.Lock
               └─► RememberSystem.add_memory
                     └─► openmemory MemorySystem.add_memory
                           ├─ embed content  (EmbeddingProvider — one model, all sectors)
                           ├─ graph.create_similarity_waypoint
                           │     cosine-compares against EXISTING memories
                           └─ persist to SQLite
```

The similarity waypoint is why the embedding provider is pinned. It compares the new
memory against existing ones **regardless of sector**; with `openmemory`'s default
per-sector model map that means a 384-dim vector meeting a 768-dim one, which raises on the
second memory whenever the two land in different sectors.

---

## 3. `archive_memories` — the one that moves data

```
tools/call archive_memories(age_days, min_salience, user_id=None)
   └─► RememberSystem.archive_old_memories
         │
         ├─ acquire _write_lock                      (no interleaved add/forget)
         ├─ SELECT eligible memories                 age + salience filter
         ├─ MemvidEncoder ──► user_<key>_<ts>.mp4
         │                    user_<key>_<ts>.faiss
         │                    user_<key>_<ts>.json
         ├─ archive_index[_archive_key(user_id)][ts] = {...}   ◄── registration
         ├─ DELETE eligible FROM memories             inside `with conn:` (atomic)
         └─ return ArchiveStats
```

**Registration and deletion must both happen.** The write is unconditional now; it used to
be guarded by `if user_id:`, so the default path encoded the video, deleted the rows, and
recorded nothing. The data survived on disk but nothing could find it: `get_stats`
reported zero archives and query/recall looked under a key that was never written.

Filenames normalize `None` → `"default"`; `_archive_key` makes the index agree.

---

## 4. `query_memory` and `recall_memory`

```
query(query, k, include_archive=True)
   ├─► active: openmemory semantic search ──────────────┐
   └─► archive (if _archive_key(user_id) in index):     │
         for each archive:
           _get_retriever(video, index)   ◄── cached: FAISS + mp4 reopen is expensive
           retriever.search(query)                      │
                                                        ▼
                                        merged List[HybridMemoryResult]
                                        each tagged MemoryLocation.ACTIVE | ARCHIVE
```

`recall_memory` is the return leg: it reads the named archive, then **re-adds** the content
to active storage, so a recalled memory is live again rather than merely displayed.

```
recall_from_archive(archive_file, content)
   └─► add_memory(content, metadata={"recalled_from": archive_file})
```

---

## 5. File indexing — a parallel pipeline

```
index_file(path)  ─► FileIndexer.index_file
                       ├─ read + chunk (chunk_size / overlap / preserve_lines)
                       ├─ MemvidEncoder ──► its OWN video store
                       └─ metadata: path, hash, type, size, timestamps

search_files(q)   ─► FileIndexer.search ─► its own retriever
```

This shares the memvid *technique* with the memory system and none of its state. The two
never read each other's stores.

---

## Where failures surface

| Failure | Where it shows |
|---|---|
| stdout pollution | Corrupt JSON-RPC — the client sees a broken server, not a log line |
| Slow imports | Handshake timeout; server "fails to start" with no error |
| Mixed embedding dims | `ValueError: shapes (384,) and (768,) not aligned` on the 2nd `add_memory` |
| Unregistered archive | `get_stats` shows 0 archives; recall finds nothing; data still on disk |

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| entryRoots | 1 | dependency-graph.json |
| runtimeCircularDeps | 0 | dependency-graph.json |
