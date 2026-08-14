# API

Two surfaces: the **MCP tool surface** (what a client calls) and the **Python surface**
(what an importer gets).

---

## MCP tools (13)

Derived by parsing `server.py`'s `@app.tool()` decorators with `ast` — a direct source
fact, **not** a `repo_map` graph metric. Pinned as a set by
`tests/test_tool_contract.py`, which also requires every tool to carry a description.

### Memory (5)

| Tool | Signature | Notes |
|---|---|---|
| `add_memory` | `(content, user_id=None, tags=None, metadata=None)` | Writes to active storage |
| `query_memory` | `(query, k=…, include_archive=…, user_id=None)` | Searches active **and** archives |
| `archive_memories` | `(age_days=None, min_salience=None, user_id=None)` | **Mutating** — deletes from active after encoding |
| `recall_memory` | `(archive_file, content, user_id=None)` | Re-adds the memory to active |
| `get_stats` | `(user_id=None) -> Dict[str, Any]` | `archive_count` is memories; `archive_file_count` is files |

### Scheduler (2)

| Tool | Signature |
|---|---|
| `scheduler_status` | `() -> Dict[str, Any]` |
| `scheduler_control` | `(action: str) -> Dict[str, str]` |

### File index (6)

| Tool | Signature |
|---|---|
| `index_file` | `(file_path, chunk_size=…, overlap=…, preserve_lines=…)` |
| `index_directory` | `(directory, …)` |
| `search_files` | `(query, top_k=…)` |
| `list_indexed_files` | `() -> List[Dict[str, Any]]` |
| `get_file_info` | `(file_path: str) -> Optional[Dict[str, Any]]` |
| `get_file_stats` | `() -> Dict[str, Any]` |

> **`archive_memories` is the only destructive tool.** It removes rows from the active
> database after encoding them into a video. With `user_id` omitted it operates on the
> `"default"` key.

> **`get_stats().archive_count` is a memory count.** `archive_file_count` is the
> number of video files. `total_memories` (`active_count + archive_count`) is
> conserved across an archive that packs N memories into one video.

---

## Python surface

### `remember`

```python
from remember import RememberSystem
```

Re-exported from `remember/system.py` — the sole name in `__init__.py`.

### `remember.system`

| Export | Kind |
|---|---|
| `RememberSystem` | class — the hybrid manager |
| `UNIFORM_EMBEDDING_MODEL` | `str` — the model pinned for every `openmemory` sector |
| `logger` | module logger |

```python
class RememberSystem:
    def __init__(self, active_db="remember_active.db", archive_dir="archives/",
                 archive_threshold_days=60, archive_min_salience=0.2,
                 auto_archive_enabled=False)

    async def add_memory(content, user_id=None, tags=None, metadata=None) -> Dict[str, Any]
    async def query(...) -> List[HybridMemoryResult]
    async def archive_old_memories(age_days=None, min_salience=None, user_id=None) -> ArchiveStats
    async def recall_from_archive(archive_file, content, user_id=None)
    async def get_stats(user_id=None) -> SystemStats
    def close() -> None
```

### `remember.file_indexer`

| Export | Kind |
|---|---|
| `FileIndexer` | class — synchronous file/video index |
| `logger` | module logger |

```python
class FileIndexer:
    def index_file(file_path, chunk_size=…, overlap=…, preserve_lines=…) -> dict
    def index_directory(...) -> dict
    def search(query, top_k=…) -> list
    def get_file_info(file_path) -> Optional[Dict[str, Any]]
    def list_indexed_files() -> List[Dict[str, Any]]
    def get_stats() -> Dict[str, Any]
    def close() -> None
```

Note this API is **synchronous**, unlike `RememberSystem`'s.

### `remember.scheduler`

```python
class ArchivalScheduler:
    async def start() -> None
    async def stop() -> None
    async def run_now() -> None
    def get_status() -> dict
```

### `remember.types`

```python
class MemoryLocation(str, Enum)       # ACTIVE | ARCHIVE
@dataclass HybridMemoryResult
@dataclass ArchiveStats(archived_count, active_remaining,
                        archive_size_bytes, compression_ratio)
@dataclass SystemStats(active_count, archive_count, total_memories, active_db_size,
                       archive_size, total_size, compression_ratio, avg_salience)
```

### `server`

| Export | Kind |
|---|---|
| `app` | the `fastmcp` application |
| `setup` | async startup hook |

Imported directly by `tests/test_tool_contract.py` and `tests/list_tools.py` to inspect the
registered tool set without speaking MCP.

---

## Environment

| Variable | Effect |
|---|---|
| `PYTHONIOENCODING=utf-8` | Set by the timing test's harness; the server writes non-ASCII to stderr |
| `PYTHONUNBUFFERED=1` | Same — prevents buffering from masking handshake latency |

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalExports | 31 | dependency-graph.json |
| totalTypeScriptFiles | 18 | dependency-graph.json |
