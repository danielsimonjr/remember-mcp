# Components

Six source modules. Signatures below are transcribed from the source, not paraphrased.

---

## `server.py` — the MCP surface

Creates the `fastmcp` app, registers 13 tools, and owns process lifecycle. Holds **no**
memory logic: every tool is a thin translation into `RememberSystem` or `FileIndexer`.

```python
def get_system() -> "RememberSystem"
def get_file_indexer() -> "FileIndexer"
async def setup()
def shutdown() -> None
def main()
```

**Lazy singletons are the load-bearing detail.** `get_system()` and `get_file_indexer()`
construct on first use, behind an `asyncio.Lock` (`_get_init_lock()`), so a burst of
concurrent tool calls builds one instance rather than several — and, critically, so the
multi-second import of `sentence-transformers`/FAISS/`memvid` never runs during the MCP
handshake. See `ARCHITECTURE.md`.

Exports: `app`, `setup`.

---

## `remember/system.py` — `RememberSystem`

The hybrid manager, and the only module that knows a memory can live in two places.

```python
class RememberSystem:
    def __init__(self,
                 active_db: str = "remember_active.db",
                 archive_dir: str = "archives/",
                 archive_threshold_days: int = 60,
                 archive_min_salience: float = 0.2,
                 auto_archive_enabled: bool = False)

    async def add_memory(self, content, user_id=None, tags=None, metadata=None) -> Dict[str, Any]
    async def query(self, ...) -> List[HybridMemoryResult]
    async def archive_old_memories(self, age_days=None, min_salience=None, user_id=None) -> ArchiveStats
    async def recall_from_archive(self, archive_file, content, user_id=None)
    async def get_stats(self, user_id: Optional[str] = None) -> SystemStats
    def close(self) -> None

    @staticmethod
    def _archive_key(user_id: Optional[str]) -> str
```

Key internals:

- **`_archive_key`** normalizes `None` → `"default"`. Every archive-index write and lookup
  goes through it. Before it existed the write path was guarded by `if user_id:` and the
  default path orphaned its own archives.
- **`_uniform_embedding_provider()`** (module level) pins every `openmemory` sector to
  `UNIFORM_EMBEDDING_MODEL`, preventing the 384-vs-768 dimension crash.
- **`_write_lock`** serializes archive/add/forget; the archival DELETE runs in `with conn:`.
- **`_retriever_cache`** memoizes `MemvidRetriever` by `(video_path, index_path)`.

Exports: `RememberSystem`, `UNIFORM_EMBEDDING_MODEL`, `logger`.
Depends on: `remember/types.py` (first-party); `openmemory`, `memvid` (external).

---

## `remember/file_indexer.py` — `FileIndexer`

A second memvid application, independent of conversational memory: it chunks *files* and
indexes them into their own video store.

```python
class FileIndexer:
    def index_file(self, file_path, chunk_size=..., overlap=..., preserve_lines=...) -> dict
    def index_directory(self, ...) -> dict
    def search(self, query, top_k=...) -> list
    def get_file_info(self, file_path: str) -> Optional[Dict[str, Any]]
    def list_indexed_files(self) -> List[Dict[str, Any]]
    def get_stats(self) -> Dict[str, Any]
    def close(self) -> None
```

Note the API is **synchronous** while `RememberSystem`'s is `async`. `server.py` bridges
this: the file-index tools are `async def` at the MCP boundary and call these directly.

Exports: `FileIndexer`, `logger`. Depends on: `memvid` (external) only — no first-party
imports, which is why it is a leaf in the graph.

---

## `remember/scheduler.py` — `ArchivalScheduler`

Periodic archival, driven by `asyncio`.

```python
class ArchivalScheduler:
    async def start(self) -> None
    async def stop(self) -> None
    async def run_now(self) -> None
    def get_status(self) -> dict
```

Surfaced through `scheduler_status` / `scheduler_control`. Disabled by default
(`auto_archive_enabled=False`), so archival is an explicit act unless switched on.

Exports: `ArchivalScheduler`. No first-party imports — it is handed a `RememberSystem`
rather than importing one, which keeps it independently testable.

---

## `remember/types.py` — the boundary types

```python
class MemoryLocation(str, Enum)     # active | archive
@dataclass class HybridMemoryResult # a result that knows which store it came from
@dataclass class ArchiveStats       # archived_count, active_remaining,
                                    # archive_size_bytes, compression_ratio
@dataclass class SystemStats        # active_count, archive_count, total_memories,
                                    # active_db_size, archive_size, total_size,
                                    # compression_ratio, avg_salience
```

Imports nothing first-party — a true leaf, so it cannot participate in a cycle.

> ⚠ `SystemStats.archive_count` counts archive **files**, not archived memories, so
> `total_memories = active_count + archive_count` mixes units. Recorded in the CHANGELOG
> as a known issue.

Exports: all four names above.

---

## `remember/__init__.py`

Re-exports `RememberSystem` so `from remember import RememberSystem` works. This is why
`RememberSystem` appears as an export of two files.

---

## `example.py`

A standalone demo. **Deliberately an orphan** — nothing imports it, and
`unused-analysis.md` reports it as the repo's only no-importer file. That is correct for a
script meant to be run, not imported.

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalTypeScriptFiles | 15 | dependency-graph.json |
| totalExports | 31 | dependency-graph.json |
| noImporterFileCount | 1 | unused-analysis.json |
