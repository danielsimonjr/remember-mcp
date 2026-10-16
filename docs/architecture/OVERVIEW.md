# Overview

## Project summary

remember-mcp is a Model Context Protocol (MCP) server for long-term memory. The server runs on Bun and speaks MCP over stdio.

The server keeps recent memories in a SQLite database. A memory that is old and has low salience moves into an archive. An archive is an MP4 video of QR codes, with a JSON sidecar that holds one embedding for each text chunk. The server also indexes text and code files into the same archive format, and searches them.

The package runs its TypeScript source directly. The `bin` entry in `package.json` points at `src/index.ts`, and the package has no build step. The package also exports a library entry point, so a program can use the three core classes without MCP.

The server offers 13 MCP tools: 5 memory tools, 2 scheduler tools and 6 file tools.

## Key metrics

The first four rows come from `repo-tools map`. The scope of each row is the whole repository, tests included.

| Metric | Value | Scope | Source |
|---|---|---|---|
| Source files | 27 | whole repository | `repo-tools map` |
| Lines of code | 4083 | whole repository | `repo-tools map` |
| Exports | 58 | whole repository | `repo-tools map` |
| Entry roots | 3 | whole repository | `repo-tools map` |
| Files in `src/` | 15 | `src/` only | `file-inventory.json`, area `src` |
| Lines in `src/` | 2775 | `src/` only | `file-inventory.json`, area `src` |
| Files in `tests/` | 12 | `tests/` only | `file-inventory.json`, area `tests` |
| Lines in `tests/` | 1308 | `tests/` only | `file-inventory.json`, area `tests` |
| MCP tools | 13 | `src/tools.ts` | direct count of the `TOOLS` array |

The three entry roots are `src/index.ts` (the `bin` entry), `src/server.ts` (the `./server` export) and `src/remember/index.ts` (the `.` export).

## Directory structure

```
remember-mcp/
├── src/                        15 files, 2775 lines
│   ├── index.ts                stdio entry: serves the MCP server, handles SIGINT and SIGTERM
│   ├── server.ts               builds the MCP server and registers every tool
│   ├── tools.ts                tool definitions, handlers, and the lazy singletons
│   ├── version.ts              package name and version, read from package.json
│   ├── example.ts              demo program that nothing imports
│   └── remember/               the memory engine
│       ├── index.ts            library barrel
│       ├── system.ts           RememberSystem: active store plus archives
│       ├── active-store.ts     ActiveStore: SQLite storage, ranking and decay
│       ├── archive.ts          QR frames, ffmpeg encode, JSON sidecar, sidecar search
│       ├── embeddings.ts       hashed 384-dimension embeddings
│       ├── sectors.ts          keyword classifier for the five sectors
│       ├── scheduler.ts        ArchivalScheduler: timer for archive passes
│       ├── file-indexer.ts     FileIndexer: file chunking, indexing and search
│       ├── ensure-dir.ts       ensureDir: creates a folder only when it is missing
│       └── types.ts            shared types and the sector list
├── tests/                      12 files, 1308 lines (11 test files and one stdio helper)
├── docs/architecture/          this documentation set
├── README.md
├── CHANGELOG.md
├── package.json                bin, exports, scripts, engines
├── tsconfig.json               strict type check, no emit
└── .github/workflows/          CI, Dependabot automerge, Dependabot lockfile update
```

## Key design principles

1. **Standard output belongs to the protocol.** The server writes logs and errors to standard error only. The demo in `src/example.ts` prints to standard output, and the server never imports it.
2. **Heavy work waits for the first tool call.** No module builds a `RememberSystem` or a `FileIndexer` at import time. The `initialize` request stays fast, because SQLite and `ffmpeg` work starts later.
3. **Embeddings need no model.** `embed()` hashes tokens into a 384-dimension unit vector. No dependency downloads a model, and no network call occurs.
4. **Writers take a lock.** `RememberSystem` runs `addMemory` and the two storage steps of an archive pass under `withWriteLock`, and every archive pass under `withArchiveLock`. `query()` updates salience without the write lock.
5. **A memory leaves active storage only after its archive exists.** `archiveOldMemories` encodes the archive first and deletes the active rows afterwards. When the encoder fails, the pass archives nothing and deletes nothing.
6. **File indexing stays inside allowed roots.** `FileIndexer` refuses a path outside the roots and a file over 32 MiB. `FileIndexer` refuses a binary file and a file that is not valid UTF-8. `FileIndexer` refuses a dotfile unless the caller sets `index_dotfiles`.
7. **Argument errors are values.** A handler returns an object with `error` and `message` for a bad argument. The server layer catches every other throw and returns a result with `isError` set.

## How the code gets loaded

Most code loads with a plain `import`. These mechanisms differ:

- **Tool registration by name.** `buildServer()` loops over `TOOLS` and looks up `HANDLERS[tool.name]`. A tool with no handler is skipped without a warning.
- **Lazy singletons.** `tools.ts` creates the `RememberSystem`, the `ArchivalScheduler` and the `FileIndexer` on the first call that needs them. A lock serializes that first call.
- **Built-in Bun modules.** `active-store.ts` imports `bun:sqlite`. `file-indexer.ts` uses the global `Bun.Glob`. Node does not provide either one.
- **A JSON import.** `version.ts` imports `package.json` with an import attribute.
- **An external process.** `archive.ts` starts `ffmpeg` through `spawnSync`. The `PATH` must contain `ffmpeg`.
- **Scaffolding.** `src/example.ts` is a demo. A developer runs it with `bun run src/example.ts`, and nothing imports it.

## Unused code

`repo-tools map` reports one orphaned file, 1 file with no importer, and 15 exports with no importer.

- **`src/example.ts`** is the orphaned file. The file is a demo, so the missing importer is by design.
- **`setup` in `src/tools.ts`** has no reference. The function warms the singletons for tests and benchmarks.
- **`PKG_NAME` in `src/version.ts`** has no reference.
- **13 exports** are types, constants and functions that no other file imports. Their own module uses each one.

The count is not a deletion list. The `exports` field of `package.json` exposes two subpaths: `.` (the barrel) and `./server`. A symbol that is outside both is not public API. A symbol in the barrel is public API, and to remove it is a breaking change.

## Related documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): why the system has this shape.
- [COMPONENTS.md](COMPONENTS.md): each module, with real signatures.
- [DATAFLOW.md](DATAFLOW.md): the path of each operation.
- [API.md](API.md): the MCP tools and the library surface.
- [FILE_INVENTORY.md](FILE_INVENTORY.md), [TEST_COVERAGE.md](TEST_COVERAGE.md), [DEPENDENCY_GRAPH.md](DEPENDENCY_GRAPH.md), [unused-analysis.md](unused-analysis.md) and [duplicate-symbols.md](duplicate-symbols.md): generated reports.

## Verification

Generated by `repo-tools map`.
Regenerate the reports: `repo-tools map . --out=docs/architecture` · Check: `repo-tools check . --docs=docs/architecture`

The claims come from `repo-tools map .`, which reads the whole repository. The other counts in this document come from `file-inventory.json`. A direct count of the source gives the number of tools.

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 27 | repo-tools map (whole repository) |
| totalLinesOfCode | 4083 | repo-tools map (whole repository) |
| totalExports | 58 | repo-tools map (whole repository) |
| entryRoots | 3 | repo-tools map (whole repository) |
| orphanedFiles | 1 | repo-tools map (whole repository) |
| noImporterFileCount | 1 | repo-tools map (whole repository) |
| unusedExportsCount | 15 | repo-tools map (whole repository) |
