# remember-mcp

**Hybrid long-term memory system with file indexing capabilities - combining cognitive architecture with QR-encoded video storage.**

remember-mcp integrates:
- **[openmemory-python](https://github.com/danielsimonjr/openmemory-python)** - Active memory with cognitive sectors and decay
- **[memvid](https://github.com/danielsimonjr/memvid)** - QR-encoded video storage for memories and files

## Documentation

Full architecture documentation lives in [`docs/architecture/`](docs/architecture/). Every
numeric claim in it is derived from a parse of the code and re-checked by a drift gate
(`repo_map.py check`), so a stale number fails rather than misleads.

| Document | Answers |
|---|---|
| [OVERVIEW.md](docs/architecture/OVERVIEW.md) | What this is, what it does, the numbers |
| [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | Why it is built this way, and the decisions the runtime forced |
| [COMPONENTS.md](docs/architecture/COMPONENTS.md) | Each module, with real signatures |
| [DATAFLOW.md](docs/architecture/DATAFLOW.md) | How a request travels end to end |
| [API.md](docs/architecture/API.md) | The full MCP and Python surface |
| [FILE_INVENTORY.md](docs/architecture/FILE_INVENTORY.md) | Every file and its disposition |
| [TEST_COVERAGE.md](docs/architecture/TEST_COVERAGE.md) | What is tested, and the gaps that matter |
| [DEPENDENCY_GRAPH.md](docs/architecture/DEPENDENCY_GRAPH.md) | Who imports whom |
| [unused-analysis.md](docs/architecture/unused-analysis.md) | Files and exports with no importer |
| [duplicate-symbols.md](docs/architecture/duplicate-symbols.md) | Names defined more than once |

## Architecture

### Hybrid Storage Model

```
New Memory → Active (OpenMemory) → Decay → Archive (Memvid)
                    ↑                            ↓
                    └────────── Recall ──────────┘

New File → Index → QR Video → Semantic Search
```

**Active Memory** (Hot):
- SQLite-backed with fast access
- Multi-sector cognitive organization
- Exponential decay tracking
- Salience-based importance
- Sub-second retrieval

**Archive Storage** (Cold):
- MP4 video files with QR encoding
- 10x compression vs databases
- Portable and streamable
- Long-term storage
- Semantic search capable

**File Index** (Video):
- QR-encoded video storage
- Text, PDF, EPUB, code files
- Line number preservation
- Metadata tracking
- Semantic search

### Memory Lifecycle

1. **Creation** → Memory enters active storage
2. **Active** → Fast access, decay begins, waypoint associations form
3. **Decay** → Salience decreases over time without access
4. **Archive** → Low-salience memories compressed to video
5. **Recall** → Archived memories return to active when accessed

## Features

### Memory Management
- 🧠 **Cognitive Memory** - 5 sector types (episodic, semantic, procedural, emotional, reflective)
- 📹 **Video Archival** - Compress old memories to MP4 format with QR codes
- ⚡ **Hybrid Search** - Query both active and archived memories
- 🔄 **Auto-Archival** - Scheduled compression of decayed memories
- 📊 **Memory Stats** - Track active vs archived, decay rates, storage usage
- 👤 **User Isolation** - Per-user memory spaces and archives

### File Indexing
- 📁 **File Indexing** - Index files to QR-encoded video storage
- 📄 **Multi-Format** - Support for text, PDF, EPUB, Python, JavaScript, markdown
- 🔢 **Line Tracking** - Preserve line numbers for code files
- 🔍 **File Search** - Semantic search across all indexed files
- 🏷️ **Metadata** - Track file paths, hashes, types, sizes, timestamps
- 🎯 **Filtering** - Search by file type, path pattern, or content

### Integration
- 🔌 **MCP Server** - 13 Model Context Protocol tools

## Installation

Dependencies are declared in `pyproject.toml` and locked in `uv.lock`, which is
what CI installs from:

```bash
uv sync
```

> `requirements.txt` was removed in v1.1.1. It was a second, unmaintained
> dependency list that omitted `mcp`, `pydantic` (including its exact
> `==2.13.4` pin) and `scipy`, and tracked `memvid`'s `main` branch instead of
> the commit pinned in `uv.lock` — so following it produced an incomplete
> environment that did not match CI.

## Quick Start

### Memory Management

```python
from remember import RememberSystem

# Initialize system
remember = RememberSystem(
    active_db="memory.db",
    archive_dir="archives/"
)

# Add a memory
result = await remember.add_memory(
    content="Important project meeting notes from today",
    user_id="user123"
)

# Query (searches both active + archive)
results = await remember.query(
    query="What were the meeting notes?",
    user_id="user123",
    include_archive=True
)

# Archive old memories
archived = await remember.archive_old_memories(
    age_days=30,
    min_salience=0.3
)
```

### File Indexing

```python
from remember.file_indexer import FileIndexer

# Initialize indexer
indexer = FileIndexer(index_dir="file_index/")

# Index a single file
result = indexer.index_file(
    "path/to/file.py",
    preserve_lines=True  # Keeps line numbers for code
)

# Index entire directory
stats = indexer.index_directory(
    dir_path="src/",
    pattern="**/*.py",  # All Python files
    exclude=[".git", "__pycache__"]
)

# Search indexed files
results = indexer.search(
    query="authentication logic",
    file_type_filter="python",
    top_k=10
)

# List all indexed files
files = indexer.list_indexed_files()
```

## MCP Server

Run the MCP server:

```bash
python server.py
```

### Memory Tools (7)
- `add_memory` - Add new memory to active storage
- `query_memory` - Hybrid search (active + archive)
- `archive_memories` - Manually trigger archival
- `recall_memory` - Move archived memory back to active
- `get_stats` - System statistics
- `scheduler_status` - Get archival scheduler status
- `scheduler_control` - Control archival scheduler (start/stop/run_now)

### File Indexing Tools (6)
- `index_file` - Index a file into video-encoded storage
- `index_directory` - Bulk index directory with glob patterns
- `search_files` - Semantic search across indexed files
- `list_indexed_files` - List all indexed files
- `get_file_info` - Get detailed file metadata
- `get_file_stats` - Get indexing statistics

## Use Cases

### Memory Management
- **Personal Knowledge Base** - Store notes, ideas, learnings with automatic archival
- **AI Agent Memory** - Long-term memory for conversational agents
- **Digital Journaling** - Life events with episodic memory
- **Research Notes** - Compress research with semantic search

### File Indexing
- **Codebase Search** - Index entire projects for semantic code search
- **Documentation Archive** - Index PDFs, markdown, technical docs
- **Knowledge Repository** - Searchable archive of papers, articles, books
- **Project Memory** - Index code with line numbers for context retrieval

## Architecture Details

### Active Memory Layer
- Uses OpenMemory cognitive architecture
- Pattern-based sector classification
- Dual-process exponential decay
- Waypoint graph associations
- SQLite storage

### Archive Layer
- Uses memvid video encoding
- QR code chunk encoding
- FAISS semantic search
- Streaming capable
- Offline-first

### File Index Layer
- QR-encoded video storage
- Per-file video archives
- Metadata JSON tracking
- Chunk-level line numbers
- Semantic search via FAISS

### Hybrid Manager
- Routes queries to appropriate layer
- Manages memory lifecycle
- Schedules automatic archival
- Handles recall from archive
- Tracks cross-layer statistics

## Configuration

```python
RememberSystem(
    active_db="memory.db",           # Active memory database
    archive_dir="archives/",         # Archive video directory
    archive_threshold_days=60,       # Age before archival
    archive_min_salience=0.2,        # Min salience to archive
    auto_archive_enabled=True        # Enable auto-archival
)

FileIndexer(
    index_dir="file_index/",         # File index directory
    allowed_roots=None,              # See "File-indexing security" below
)
```

### File-indexing security

To prevent prompt-injected MCP clients from indexing sensitive files (SSH
keys, `.env`, OAuth caches, credential stores), file indexing is constrained
to an allow-list of root directories.

- **Env var:** `REMEMBER_INDEX_ROOTS` — comma-separated list of absolute
  paths. Set this at server startup. Example:
  ```
  REMEMBER_INDEX_ROOTS=C:\Users\me\Documents,C:\Users\me\Projects
  ```
- **Default:** if `REMEMBER_INDEX_ROOTS` is unset, only `~/Documents` is
  allowed.
- **Programmatic override:** pass `allowed_roots=[...]` to `FileIndexer(...)`.
- **Dotfiles** (anything whose name or any parent directory begins with `.`,
  e.g. `.env`, `.ssh/id_rsa`, `.aws/credentials`) are rejected by default.
  Pass `index_dotfiles=True` on `index_file` / `index_directory` (or via the
  MCP tool argument) to opt in for a single call.
- Requests that violate either constraint raise `PermissionError` from the
  Python API and return `{"error": "permission_denied", "message": "..."}`
  from the MCP tool layer.

## Development

```bash
# Install dependencies (from uv.lock — same as CI)
uv sync

# Run the test suite — this is the gate CI runs
uv run pytest -q

# Run a single test file
uv run pytest tests/test_tool_contract.py -v

# List available MCP tools (manual inspection script, not a test)
uv run python tests/list_tools.py
```

The previous commands here (`python test_complete.py`, `python test_file_indexing.py`,
`python list_tools.py`) named paths that do not exist — those files live under
`tests/`, and running them directly bypasses pytest entirely.

## Recent updates

See [CHANGELOG.md](CHANGELOG.md) for recent changes — lazy imports for sub-handshake-window startup, stdout-pollution fix.

## License

MIT License

## Credits

Built on:
- [openmemory-python](https://github.com/danielsimonjr/openmemory-python) by @danielsimonjr
- [memvid](https://github.com/danielsimonjr/memvid) by @Olow304

Created by @danielsimonjr
