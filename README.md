# remember-mcp

**Hybrid long-term memory system with file indexing — TypeScript on Bun.**

Active memories live in SQLite with cognitive sectors and salience decay.
Decayed memories compress into QR-encoded MP4 archives (plus a JSON sidecar
for semantic search). The same QR-video path indexes text and code files.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- `ffmpeg` on `PATH` (QR-frame → MP4 archival)

## Install

```bash
bun install
```

## Run (MCP stdio)

```bash
bun run src/index.ts
```

Claude Desktop / Claude Code config example:

```json
{
  "mcpServers": {
    "remember": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/remember-mcp/src/index.ts"]
    }
  }
}
```

Optional: set `REMEMBER_INDEX_ROOTS` (comma-separated absolute paths) to
constrain file indexing. Default is `~/Documents`.

## Library usage

```ts
import { RememberSystem } from "remember-mcp";

const remember = new RememberSystem({
  active_db: "memory.db",
  archive_dir: "archives/",
});

await remember.addMemory({
  content: "Important project meeting notes from today",
  user_id: "user123",
});

const results = await remember.query({
  query: "What were the meeting notes?",
  user_id: "user123",
  include_archive: true,
});

await remember.archiveOldMemories({ age_days: 30, min_salience: 0.3 });
remember.close();
```

## MCP tools (13)

**Memory:** `add_memory`, `query_memory`, `archive_memories`, `recall_memory`, `get_stats`  
**Scheduler:** `scheduler_status`, `scheduler_control`  
**Files:** `index_file`, `index_directory`, `search_files`, `list_indexed_files`, `get_file_info`, `get_file_stats`

## Development

```bash
bun test
bun run typecheck
bun run src/example.ts
```

## Architecture

```
New Memory → Active (bun:sqlite) → Decay → Archive (QR MP4 + JSON)
                    ↑                            ↓
                    └────────── Recall ──────────┘

New File → Chunk → QR Video → Semantic Search
```

- **Active:** `bun:sqlite`, hashed embeddings (no model download), five
  cognitive sectors, exponential salience decay.
- **Archive:** each chunk → QR PNG frame → `ffmpeg` H.264 MP4; search uses
  the JSON sidecar embeddings (fast, FAISS-free).
- **Startup:** heavy work is deferred to the first `tools/call` so MCP
  `initialize` stays well under Claude Code's startup window.

## Migration notes (v2.0)

This release replaces the Python / FastMCP / openmemory-python / memvid stack
with a Bun-native TypeScript implementation. The 13-tool MCP surface is
preserved. PDF/EPUB file indexing is not yet ported (text and code files work).

Protocol negotiation follows `@modelcontextprotocol/server` (currently
`2025-11-25`), matching the author's other TypeScript MCP servers.

## License

MIT
