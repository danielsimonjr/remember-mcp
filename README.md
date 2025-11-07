# remember-mcp

**Hybrid long-term memory system combining cognitive architecture with video-based archival storage.**

remember-mcp integrates:
- **[openmemory-python](https://github.com/danielsimonjr/openmemory-python)** - Active memory with cognitive sectors and decay
- **[memvid](https://github.com/danielsimonjr/memvid)** - Video-based compressed archival storage

## Architecture

### Hybrid Storage Model

```
New Memory → Active (OpenMemory) → Decay → Archive (Memvid)
                    ↑                            ↓
                    └────────── Recall ──────────┘
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

### Memory Lifecycle

1. **Creation** → Memory enters active storage
2. **Active** → Fast access, decay begins, waypoint associations form
3. **Decay** → Salience decreases over time without access
4. **Archive** → Low-salience memories compressed to video
5. **Recall** → Archived memories return to active when accessed

## Features

- 🧠 **Cognitive Memory** - 5 sector types (episodic, semantic, procedural, emotional, reflective)
- 📹 **Video Archival** - Compress old memories to MP4 format
- ⚡ **Hybrid Search** - Query both active and archived memories
- 🔄 **Auto-Archival** - Scheduled compression of decayed memories
- 📊 **Memory Stats** - Track active vs archived, decay rates, storage usage
- 👤 **User Isolation** - Per-user memory spaces and archives
- 🔌 **MCP Server** - Model Context Protocol integration

## Installation

```bash
pip install -r requirements.txt
```

## Quick Start

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

## MCP Server

Run the MCP server:

```bash
python -m remember.mcp.server
```

Available tools:
- `add_memory` - Add new memory
- `query_memory` - Hybrid search (active + archive)
- `archive_old` - Manually trigger archival
- `recall_memory` - Move archived memory back to active
- `get_stats` - System statistics

## Use Cases

- **Personal Knowledge Base** - Store notes, ideas, learnings with automatic archival
- **AI Agent Memory** - Long-term memory for conversational agents
- **Research Archive** - Compress papers, articles with semantic search
- **Code Context** - Remember project history and decisions
- **Digital Journaling** - Life events with episodic memory

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
    segment_size=10000,              # Memories per segment
    archive_threshold_days=60,       # Age before archival
    archive_min_salience=0.2,        # Min salience to archive
    auto_archive_enabled=True,       # Enable auto-archival
    auto_archive_interval=86400      # Archive check interval (seconds)
)
```

## Development

```bash
# Install dev dependencies
pip install -r requirements-dev.txt

# Run tests
pytest tests/

# Format code
black remember/
```

## License

MIT License

## Credits

Built on:
- [openmemory-python](https://github.com/danielsimonjr/openmemory-python) by @danielsimonjr
- [memvid](https://github.com/danielsimonjr/memvid) by @Olow304

Created by @danielsimonjr
