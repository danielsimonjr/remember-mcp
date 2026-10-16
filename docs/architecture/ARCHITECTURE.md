# Architecture

This document gives the reason for the shape of remember-mcp. For the module list, read [COMPONENTS.md](COMPONENTS.md). For the paths of the operations, read [DATAFLOW.md](DATAFLOW.md).

## Contents

- [System overview](#system-overview)
- [System context](#system-context)
- [Architecture principles](#architecture-principles)
- [Component architecture](#component-architecture)
- [Key design decisions](#key-design-decisions)
- [Data model](#data-model)
- [Storage architecture](#storage-architecture)
- [Build and packaging](#build-and-packaging)
- [Performance](#performance)
- [Security architecture](#security-architecture)
- [Testing strategy](#testing-strategy)

## System overview

remember-mcp gives an MCP client a long-term memory. A client such as Claude Code starts the server as a child process and sends JSON-RPC messages over standard input and output.

The server has three parts:

- A **server layer** that registers 13 tools and turns each call into a method call.
- A **memory engine** that stores memories in SQLite, ranks them, and moves old ones into archives.
- A **file indexer** that stores text and code files in the archive format and searches them.

The memory engine and the file indexer share one archive format. An archive is an MP4 video. The video holds the text as QR codes. A JSON sidecar holds a hashed embedding of each text chunk. A search reads the sidecar. The video is the portable copy of the text.

## System context

| Neighbor | Link | Direction |
|---|---|---|
| MCP client | JSON-RPC over standard input and output | The client sends requests. The server sends results. |
| Local file system | SQLite file, archive videos, sidecars, index metadata, and the files that the user asks to index | Read and write. |
| `ffmpeg` | A child process that the server starts with `spawnSync` | The server writes PNG frames and reads the exit code. |
| The terminal of the client | Standard error | The server writes logs. |

The server makes no network call. The server needs no account and no API key.

## Architecture principles

These rules settle design arguments. A reviewer can find a violation of each one.

1. **Standard output carries only the protocol.** A write to standard output from a server code path breaks the JSON-RPC stream. Logs go to standard error.
2. **Startup does no storage work.** The MCP client waits a short time for `initialize`. All storage work starts with the first tool call.
3. **No model download.** Ranking uses a hashed embedding that the code computes in process.
4. **State changes take a lock.** Every method that writes to the database runs under the write lock. Every archive pass runs under the archive lock.
5. **A memory is deleted only after its archive exists.** The archive pass deletes active rows after the encode ends without an error.
6. **Paths come from the allow-list.** The file indexer reads a file only when the resolved path is inside an allowed root.
7. **A bad argument is a result, not a crash.** A handler returns an error object for an argument problem. The wrapper catches anything else.

## Component architecture

The code has three layers. A layer may import from the layer below it, and from no layer above it.

| Layer | Modules | May import |
|---|---|---|
| Entry | `index.ts` | Server, tools |
| Server | `server.ts`, `tools.ts`, `version.ts` | Engine, file indexing |
| Engine | `system.ts`, `active-store.ts`, `archive.ts`, `embeddings.ts`, `sectors.ts`, `scheduler.ts`, `types.ts` | Engine only |
| File indexing | `file-indexer.ts` | `archive.ts` only |

Edges that the design forbids:

- The engine and the file indexer never import `server.ts`, `tools.ts` or `index.ts`.
- `RememberSystem` and `FileIndexer` never import each other. They share `archive.ts` only.
- `archive.ts` and `embeddings.ts` import no other module of the package, except that `archive.ts` imports `embeddings.ts`.
- `scheduler.ts` imports `RememberSystem` as a type. The scheduler gets the object from its caller.

`repo-tools map` finds no circular dependency, and the map confirms the direction of these edges. The table in [COMPONENTS.md](COMPONENTS.md#dependencies-between-components) lists every edge.

## Key design decisions

### Hashed embeddings instead of a model

**Decision.** `embed()` turns text into a 384-dimension unit vector. The function hashes lowercase tokens into slots with a signed weight.

**Rationale.** A model-based embedder needs a model download and a slow import. The code comment in `embeddings.ts` says that a slow start passes the MCP startup window of the client. The hashed vector needs no download, and the import takes almost no time.

**Alternative that the design does not use.** A neural embedding model with a vector index such as FAISS.

**Trade-offs.** The vectors capture shared tokens. They do not capture meaning. Two texts without a shared ASCII token have a similarity near 0. Text without any ASCII token has the same vector as all other such text.

### QR video archives with a JSON sidecar

**Decision.** An archive pass writes each memory as QR frames in an MP4 and writes a sidecar with the text and the embeddings.

**Rationale.** The comment in `archive.ts` gives the reason for the split. A search uses the sidecar embeddings and not FAISS, so a cold start stays cheap. The MP4 remains the durable, portable payload. The same format serves archived memories and indexed files, so one encoder serves both.

**Alternative that the design does not use.** Keep archived text only in the sidecar, or in the database.

**Trade-offs.** Each archive needs `ffmpeg` on the `PATH`. A slice of 800 characters limits the frame size, and the limit counts characters, not bytes. A search never decodes the video, so the video is not read back by the server at all.

### Lazy initialization

**Decision.** `tools.ts` builds the memory system and the file indexer on the first call that needs them. A lock makes the first call safe when two calls arrive together.

**Rationale.** Opening SQLite, creating folders and scanning archives all take time. The comment in `index.ts` says that the deferral keeps `initialize` under one second.

**Alternative that the design does not use.** Build the engine when the module loads.

**Trade-offs.** The first tool call is slower than later calls. An error in the setup, such as an unwritable folder, shows up in the first tool call and not at startup.

### Salience with decay and reinforcement

**Decision.** Each memory has a salience from 0 to 1. The value halves every 30 days since the last time the memory was seen. A query that returns a memory adds 0.05 to its stored salience and resets the clock.

**Rationale.** A memory that nobody retrieves fades and becomes a candidate for the archive. A memory that clients keep retrieving stays active. A query score blends similarity (weight 0.85) with salience (weight 0.15), so that fresh and important memories rise. The comment in `active-store.ts` gives that purpose.

**Initial value.** A new memory starts at 0.85, below 1.0. The eligibility rule is that salience is below the minimum. A `min_salience` of 1.0 then selects every memory that is old enough, and operators and tests use that setting to archive by age alone.

**Trade-offs.** A read changes state. The `query_memory` tool carries `readOnlyHint: true`, and the hint does not show the writes.

### Archive hits rank below active hits

**Decision.** A score from an archive is multiplied by 0.8. An archive hit has the sector `semantic` and salience 0.

**Rationale.** Archived text is older and has faded. The factor puts an archive hit below an active hit of the same similarity.

**Trade-offs.** The factor is a constant. A strong archive hit can still beat a weak active hit, and the design has no setting for the factor.

### Two locks with the encode outside the write lock

**Decision.** `RememberSystem` has a write lock and an archive lock. An archive pass holds the archive lock for its whole run, and the write lock only for the selection and for the commit.

**Rationale.** The `ffmpeg` encode is the slowest step. It runs outside the write lock, so `addMemory` calls do not wait for it. The archive lock keeps two passes from running together.

**Trade-offs.** A memory that a query touches between the selection and the commit is deleted with the batch, even though the query raised its salience. The archive names use whole seconds, so two passes in one second for one key write the same files.

### Errors as values at the tool layer

**Decision.** Handlers return `{ error, message }` for a bad argument, a missing file or a refused path. The server wrapper catches every other throw.

**Rationale.** A client model reads the result text. An error object with a code is easy to act on, and the call still counts as a normal tool result. The three codes (`invalid_argument`, `not_found`, `permission_denied`) come from the error names that the engine sets.

**Trade-offs.** A caller must look at the body to find an error. `isError` is set only for the errors that the wrapper catches.

### The file indexer stands apart from the memory system

**Decision.** `FileIndexer` has its own folder, its own metadata file and its own deduplication by content hash. The class does not use `RememberSystem`.

**Rationale.** Indexed files are reference material, not memories. The two stores have different lifetimes, and neither one needs the other's lock or database.

**Trade-offs.** A search over files and a search over memories are two calls. The code repeats a few checks, such as the query and `k` validation, in both classes.

### Bun-native TypeScript with no build step

**Decision.** The package ships its `src/` folder. Bun runs the TypeScript directly. The code uses `bun:sqlite` and `Bun.Glob`.

**Rationale.** The package has no compile output to keep in step with the source, and the install is a copy of the source.

**Trade-offs.** The package cannot run under Node. The `engines` field requires Bun.

## Data model

### Active store

One SQLite table holds the active memories.

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT, primary key | A UUID. |
| `content` | TEXT | The memory text. |
| `user_id` | TEXT or null | The owner label. |
| `primary_sector` | TEXT | One of the five sectors. |
| `sectors_json` | TEXT | A JSON list of sectors, at most three. |
| `salience` | REAL | The stored salience. Reads apply the decay. |
| `created_at` | INTEGER | Milliseconds since the epoch. |
| `last_seen_at` | INTEGER | Milliseconds since the epoch. |
| `tags_json` | TEXT | A JSON list of strings. |
| `metadata_json` | TEXT | A JSON object. |
| `embedding` | BLOB | 384 float32 values. |

Indexes: `user_id`, `salience`, `created_at`.

### Archive

| File | Content |
|---|---|
| `user_<key>_<unix seconds>.mp4` | One QR frame for each slice of at most 800 characters. |
| `user_<key>_<unix seconds>.json` | `{ version: 1, chunks: [{ text, embedding }], created_at, total_chunks }`. |

The archive index in memory has two levels. The first level is the user key. The second level is the timestamp. Each entry holds the file paths, the creation time and the memory count. The constructor of `RememberSystem` rebuilds the index from the file names.

### File index

| File | Content |
|---|---|
| `<sha256>.mp4` and `<sha256>.json` | The video and the sidecar of one file. The name is the content hash. |
| `file_metadata.json` | A map from the content hash to the metadata of the file: path, name, type, size, chunk settings, paths of the video and sidecar, line metadata for code chunks, time and encode statistics. |

## Storage architecture

- **Active memories** live in one SQLite file. The database uses WAL journaling, a busy timeout of 5000 ms and `synchronous = NORMAL`.
- **Archives** live in one folder. A file name carries the key and the creation time, so the index can be rebuilt from the folder.
- **Indexed files** live in a separate folder. The metadata file is the only record of which path an indexed file came from.
- **Writes of sidecars and metadata** go to a temporary file first, and a rename completes them. A reader never sees a partial file.
- **Deletes.** Only `ActiveStore.deleteByIds()` and `removeArchiveOutputs()` delete data. The code has no tool that deletes an archive or an indexed file.

All paths are relative to the working directory of the server process. The MCP client sets that directory.

## Build and packaging

- `package.json` declares `bin` as `./src/index.ts` and `main` as `./src/index.ts`. The `exports` field offers `.` and `./server`.
- `files` ships `src/`, `README.md` and `LICENSE`.
- `engines` requires Bun at version 1.4.2 or later. `packageManager` pins Bun, and the lock file is `bun.lock`.
- The scripts are `start`, `dev` (watch mode), `test` (`bun test`) and `typecheck` (`tsc --noEmit`). The `prepublishOnly` script runs the type check and the tests.
- `tsconfig.json` sets `strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` and `noEmit`. The config covers `src/` and `tests/`.
- The CI workflow runs on Ubuntu and on Windows. Each job installs `ffmpeg`, runs `bun install --frozen-lockfile`, the type check and the tests. The workflow pins the Bun version and the action versions.
- Two more workflows handle Dependabot pull requests: one merges them, and one refreshes the lock file.

## Performance

The code has these cost properties. The document gives no timing, because no benchmark in the repository measures one.

- **Startup.** `initialize` does no storage work (see [Lazy initialization](#lazy-initialization)). `tests/protocol.test.ts` checks that `initialize` returns within a 10-second budget.
- **Active query.** The query reads every row of the owner, decodes each embedding, and sorts in memory. The cost grows in a straight line with the number of memories.
- **Embedding.** `embed()` counts each token again for every slot update. The cost grows with the square of the token count of one text.
- **Archive query.** Each archive search reads and parses the whole sidecar JSON. The cost grows with the number of archives and the number of chunks.
- **Archive pass.** The pass writes one PNG for each 800-character slice and runs `ffmpeg` once. The `ffmpeg` call dominates the time.
- **File indexing.** One call handles at most 500 candidate files. A file larger than 32 MiB is refused. A code file or a text file with many chunks makes many frames.
- **Concurrency.** The write lock serializes writers. Readers do not take a lock.

## Security architecture

The server runs on the machine of the user and talks to one client over stdio.

- **No authentication.** The server trusts its client. `user_id` is a label that the caller sets. The label is not an identity. A call without `user_id` reads the active memories of every owner.
- **Path allow-list.** The file tools accept a path only when the resolved path is a root from `REMEMBER_INDEX_ROOTS`, or below a root. The default root is the `Documents` folder of the user. A root check uses a relative-path test, so a sibling folder with a similar name does not pass.
- **Dotfiles.** A path with a segment that starts with a dot is refused unless the caller sets `index_dotfiles`.
- **Content checks.** The indexer refuses a file above 32 MiB, a file with a zero byte in its first 8192 bytes, and PDF and EPUB files.
- **Input limits.** A memory holds at most 100,000 characters. A query returns at most 100 results. Chunk sizes are limited to 32 to 1,000,000. Every tool schema sets `additionalProperties` to false at the top level.
- **Data at rest.** The database, the videos and the sidecars are plain files. The server does no encryption. The folder permissions of the user are the only protection.
- **Process use.** The server starts only `ffmpeg`, with a fixed argument list and no shell. The frame folder is a fresh temporary folder.
- **Metadata lookups.** `get_file_info` hashes an existing file at any path, to find a moved file. The result holds only the stored metadata, so the call does not return file content.

## Testing strategy

The tests run with `bun test`. The type check runs with `bun run typecheck`. Both run in CI on Ubuntu and on Windows.

| Suite | What it asserts |
|---|---|
| `archival.test.ts` | An archive pass moves only low-salience memories and keeps the totals. The default owner archives under `default`. An empty pass does nothing. `age_days` 0 is a real value. |
| `recall.test.ts` | An archived memory can be recalled. A recall from an unknown archive leaves active storage unchanged. |
| `video.test.ts` | Encoding and searching a sidecar round-trip. A query reaches archived memories. |
| `file-indexing.test.ts` | A text file is indexed and found by search. A path outside the allowed roots is refused. |
| `protocol.test.ts` | The server starts on stdio, negotiates a protocol version, lists the expected tools, and answers `initialize` within the budget. |
| `tool-contract.test.ts` | The registered tools are exactly the expected 13, and every tool has a description. |
| `version.test.ts` | The exported version equals the version in `package.json`. |

`tests/mcp-stdio.ts` is a helper that starts the server and exchanges JSON-RPC messages.

Gaps that a reader must know:

- No test calls a tool. The protocol tests stop at `initialize` and `tools/list`. The tool handlers, the argument coercion, the error mapping and the server wrapper have no behavior test.
- The suites use absolute paths under a temporary folder. No test uses the bare file names that the server uses.
- No test covers the scheduler timer, the sector classifier, the embedding function or the line-aware chunker directly. The archival tests reach the first two only through the engine.

The generated report [TEST_COVERAGE.md](TEST_COVERAGE.md) lists the source files that no test imports directly.

## Verification

Generated by `repo-tools map`.
Regenerate the reports: `repo-tools map . --out=docs/architecture` · Check: `repo-tools check . --docs=docs/architecture`

The claims come from `repo-tools map .`, which reads the whole repository. A direct reading of the source, `package.json`, `tsconfig.json` and the workflows gives every other statement.

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 22 | repo-tools map (whole repository) |
| totalLinesOfCode | 3264 | repo-tools map (whole repository) |
| runtimeCircularDeps | 0 | repo-tools map (whole repository) |
| typeOnlyCircularDeps | 0 | repo-tools map (whole repository) |
