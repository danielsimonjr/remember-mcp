# Components

This document describes each module of remember-mcp. Each section gives the path, the purpose, the real signatures, and the behavior that a signature does not show.

## Contents

- [Server layer](#server-layer): `index.ts`, `server.ts`, `tools.ts`, `version.ts`
- [Memory engine](#memory-engine): `system.ts`, `active-store.ts`, `archive.ts`, `embeddings.ts`, `sectors.ts`, `scheduler.ts`, `types.ts`, `ensure-dir.ts`, `index.ts`
- [File indexing](#file-indexing): `file-indexer.ts`
- [Scaffolding](#scaffolding): `example.ts`
- [Dependencies between components](#dependencies-between-components)

## Server layer

### src/index.ts

The stdio entry. The file has no exports.

The file calls `serveStdio(buildServer)`, writes one line to standard error, and registers handlers for `SIGINT` and `SIGTERM`. Each handler calls `shutdown()`, closes the stdio handle, and exits with code 0.

Behavior notes:

- The file starts with the line `#!/usr/bin/env bun`, so the `bin` entry runs under Bun.
- `serveStdio` receives `buildServer` as a factory function.
- The startup line names `LATEST_PROTOCOL_VERSION` from the SDK, followed by the word `legacy`.

### src/server.ts

```typescript
export function buildServer(): McpServer;
```

The function creates an `McpServer` named `remember` with the package version and the `tools` capability. For each entry of `TOOLS`, the function looks up `HANDLERS[tool.name]` and registers the tool with `fromJsonSchema(tool.inputSchema)`.

Behavior notes:

- A tool without a handler is skipped. The code gives no warning.
- The wrapper serializes the handler result with `JSON.stringify(result, null, 2)` into one text block.
- The wrapper catches every thrown error. The wrapper writes `remember-mcp: handler '<name>' threw: <message>` to standard error and returns `{ "status": "error", "error": <message> }` with `isError` set.
- A handler that returns an object with an `error` field is not an exception. The wrapper treats the object as a normal result.

### src/tools.ts

```typescript
export type ToolHandler = (raw: Record<string, unknown>) => Promise<unknown>;
export const TOOLS: Tool[];
export const HANDLERS: Record<string, ToolHandler>;
export async function setup(): Promise<void>;
export function shutdown(): void;
export function listRegisteredToolNames(): string[];
```

`TOOLS` holds the 13 tool definitions: name, description, annotations and JSON input schema. `HANDLERS` holds one function for each name.

Behavior notes:

- **Lazy singletons.** The module keeps `rememberSystem`, `scheduler` and `fileIndexer` as module variables that start as null. `getSystem()` creates the `RememberSystem` and the `ArchivalScheduler` together. `getFileIndexer()` creates the `FileIndexer`.
- **Init lock.** `agetSystem()` and `agetFileIndexer()` run the getters under `withInitLock`. Two calls that arrive together therefore build one object.
- **Fixed configuration.** The server uses the database `remember_mcp.db`, the archive folder `mcp_archives/` and the file index folder `file_index/`. The age threshold is 60 days, the minimum salience is 0.2, and the scheduler interval is 86,400 seconds. The scheduler is created with `enabled` set to false. All paths are relative to the working directory of the process.
- **Argument coercion.** The helpers `asOptionalString`, `asOptionalStringList`, `asOptionalBool` and `asOptionalNumber` turn each raw argument into a typed value or `undefined`. A string, list or number of the wrong type becomes `undefined`. A boolean of the wrong type takes its default. A list drops its items that are not strings. A number must be finite.
- **Error mapping.** A thrown error with the name `FileNotFoundError` becomes `not_found`. The name `PermissionError` becomes `permission_denied`. Every other error becomes `invalid_argument`.
- **Handlers that do not catch.** `get_stats`, `scheduler_status`, `scheduler_control`, `list_indexed_files`, `get_file_info` and `get_file_stats` have no `try` block. An error from these handlers reaches the server wrapper.
- **`shutdown`.** The function closes the memory system and the file indexer, each in its own `try` block that writes a failure to standard error. The function then sets the three singletons to null.
- **`setup`.** The function builds both singletons ahead of time. Tests and benchmarks use the function. The stdio entry does not call it.
- **`run_now` and `enabled`.** The handler for `scheduler_control` calls `scheduler.runNow()`. The handler reports `Archival triggered` when `runNow` returns true, and `Scheduler not started` when it returns false. The scheduler runs no pass while `enabled` is false.

### src/version.ts

```typescript
export const PKG_VERSION: string;
export const PKG_NAME: string;
```

Both values come from `package.json`, which the file imports with a JSON import attribute. `tests/version.test.ts` checks that the barrel `VERSION` and `PKG_VERSION` both equal the version in `package.json`.

## Memory engine

### src/remember/system.ts

`RememberSystem` joins the active store and the archives. The full public signature is in [API.md](API.md#library-remembersystem).

```typescript
export const MAX_CONTENT_CHARS = 100_000;
export const MAX_QUERY_K = 100;

export class RememberSystem {
  constructor(opts?: RememberSystemOptions);
  static archiveKey(userId?: string | null): string;
  addMemory(opts: { ... }): Promise<Record<string, unknown>>;
  query(opts: { ... }): Promise<HybridMemoryResult[]>;
  archiveOldMemories(opts?: { ... }): Promise<ArchiveStats>;
  recallFromArchive(opts: { ... }): Promise<Record<string, unknown>>;
  getStats(userId?: string | null): Promise<SystemStats>;
  close(): void;
}
```

Behavior notes:

- **Two locks.** `withWriteLock` and `withArchiveLock` are promise chains. Each caller waits for the previous holder and then runs. The order is first in, first out.
- **Lock order in an archive pass.** The pass takes the archive lock first. The pass takes the write lock only for the selection and for the commit. The slow `ffmpeg` encode runs outside the write lock, so `addMemory` calls do not wait for the encode.
- **Encode before delete.** The pass selects the eligible rows, encodes them, and only then deletes the rows. An encode error returns zero statistics, logs the error to standard error, and leaves the rows in place.
- **Archive names.** An archive pass names the files `user_<key>_<unix seconds>` with the extensions `.mp4` and `.json`. `_nextArchiveTimestamp` picks the first second, from now on, that the index and the archive folder do not use for the key. Two passes of one `RememberSystem` for one key within one second therefore get different names. The timestamp of the later archive can be ahead of the clock.
- **Archive index.** `archiveIndex` maps a user key to a map from the timestamp text to an `ArchiveInfo`. The constructor rebuilds the index from the file names in the archive folder. The memory count of each archive comes from its sidecar.
- **Hybrid query.** The query takes the top `k` active memories. When archives are included, the query adds the top `k` hits of each archive of the key. The query then sorts all hits by score and returns `k` of them.
- **Archive ranking.** An archive score is the cosine similarity times 0.8. An archive hit has no stored sector, so the code gives it the sector `semantic`. An error in one archive is logged to standard error and does not stop the query.
- **Archive identifiers.** The `id` of an archive hit is `archive_<timestamp>_<first 16 hex digits of the SHA-256 digest of the chunk>`.
- **Recall.** `recallFromArchive` validates the content, finds the archive with `_lookupArchive`, and checks that the video file exists. The method then calls `addMemory` with the metadata `recalled_from`. The method never reads the archive.
- **Lookup.** `_lookupArchive` matches the argument against the full video path, the file name and the file stem. With a user id, the lookup searches that key only. Without one, the lookup searches every key.
- **Statistics.** `getStats` adds the archive sizes that exist on disk. The `compression_ratio` field is the total size divided by the database size. The value is 1 when the database file is missing.
- **Reserved option.** `auto_archive_enabled` is stored as `autoArchiveEnabled`, and no code reads the field.
- **Error tag.** `recallFromArchive` throws errors with the name `FileNotFoundError`, because the tool layer maps that name to `not_found`.

### src/remember/active-store.ts

```typescript
export interface ActiveMemoryRow {
  id: string;
  content: string;
  user_id: string | null;
  primary_sector: SectorType;
  sectors: SectorType[];
  salience: number;
  created_at: number;
  last_seen_at: number;
  tags: string[];
  metadata: Record<string, unknown>;
  score?: number;
}

export interface AddMemoryResult {
  id: string;
  content: string;
  primary_sector: string;
  sectors: string[];
  salience: number;
  user_id: string | null;
  tags: string[];
  created_at: number;
}

export class ActiveStore {
  readonly dbPath: string;
  readonly db: Database;
  constructor(dbPath: string);
  addMemory(opts: {
    content: string;
    user_id?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
  }): AddMemoryResult;
  query(opts: {
    query: string;
    k: number;
    user_id?: string | null;
    sectors?: string[] | null;
  }): ActiveMemoryRow[];
  selectEligible(opts: {
    user_id?: string | null;
    age_threshold_ms: number;
    min_salience: number;
  }): Array<{ id: string; content: string }>;
  deleteByIds(ids: string[]): number;
  count(user_id?: string | null): number;
  countAndAvgSalience(user_id?: string | null): { count: number; avg: number };
  close(): void;
}
```

Behavior notes:

- **Storage.** One table, `memories`, with the columns `id`, `content`, `user_id`, `primary_sector`, `sectors_json`, `salience`, `created_at`, `last_seen_at`, `tags_json`, `metadata_json` and `embedding` (a BLOB). The constructor adds three indexes: on `user_id`, on `salience` and on `created_at`. The table has no schema version.
- **Pragmas.** The constructor sets WAL journaling, a busy timeout of 5000 ms, `synchronous` to `NORMAL`, and foreign keys on.
- **Database path.** The constructor creates the parent folder of the database file with `ensureDir`. The path `:memory:` skips that step. A bare file name has `.` as its parent folder, and `ensureDir` accepts that folder.
- **Initial salience.** A new memory has salience 0.85. The value is below 1.0 on purpose. A `min_salience` of 1.0 then selects fresh memories, because the rule is that salience is below the minimum.
- **Decay.** Salience halves every 30 days since `last_seen_at`. The code computes the decay when it reads a row. The stored value does not change until a query reinforces the row.
- **Ranking.** A score is `0.85 × similarity + 0.15 × decayed salience`. The query reads every row of the owner and computes the score in memory. The cost grows in a straight line with the number of memories.
- **Owner filter.** A false `user_id`, including an empty string, selects the rows of every owner.
- **Reinforcement.** For each returned row, the query sets `last_seen_at` to now and adds 0.05 to the stored salience, with a maximum of 1.0. The update runs in one transaction.
- **Eligibility.** `selectEligible` keeps rows with `created_at` at or before the threshold and a decayed salience below the minimum. The method sorts the rows by salience, lowest first, and then by age.
- **Delete count.** `deleteByIds` returns the length of the list that the caller gave. The value is not the number of rows that the database removed.

### src/remember/archive.ts

```typescript
export interface ArchiveChunk { text: string; embedding: number[] }
export interface ArchiveSidecar {
  version: 1;
  chunks: ArchiveChunk[];
  created_at: number;
  total_chunks: number;
}
export interface EncodeResult {
  video_size: number;
  chunk_count: number;
  compression_ratio: number;
}

export function removeArchiveOutputs(videoPath: string, indexPath: string): void;
export async function encodeChunks(
  chunks: Iterable<string>,
  videoPath: string,
  indexPath: string,
): Promise<EncodeResult>;
export function loadSidecar(indexPath: string): ArchiveSidecar | null;
export function sidecarChunkCount(indexPath: string): number;
export function searchSidecar(
  indexPath: string,
  query: string,
  topK: number,
): Array<{ text: string; score: number }>;
```

Behavior notes:

- **Encode steps.** `encodeChunks` makes a temporary folder, writes the JSON sidecar, writes one PNG per frame, runs `ffmpeg`, measures the video, and removes the temporary folder.
- **Sidecar write.** The sidecar goes to a temporary file first. A rename then replaces the final file, so a reader never sees a partial file.
- **Frames.** A chunk of more than 800 UTF-8 bytes is cut into slices of at most 800 bytes. A cut falls between two code points, so a slice never ends inside a surrogate pair. Each slice becomes one 512-pixel QR frame with error correction level M.
- **Frame limit.** A QR frame at level M holds 2331 bytes (the limit of QR version 40), so a budget of 800 bytes leaves a wide margin. An ASCII slice has 800 characters. A slice of three-byte characters, such as CJK, has at most 266 characters. A slice of four-byte characters, such as emoji, has at most 200 characters. The QR library throws on a lone surrogate, which a cut inside a pair would make.
- **Video.** The `ffmpeg` call reads the frames at 2 frames per second and writes H.264 in the `yuv420p` pixel format, with the `faststart` flag. The frame count is at least 1.
- **Encode errors.** `ffmpeg` that is missing from `PATH` or that exits with an error throws an `Error` with the text `ffmpeg encode failed`. After any error, the function removes the outputs and throws again.
- **Compression ratio.** The ratio is the UTF-8 size of the chunks divided by the video size. The value is 1 when the video size is 0.
- **Cleanup.** `removeArchiveOutputs` also removes the `.tmp` file of the sidecar, and any `.json` and `.faiss` file with the video name. The function ignores a deletion that fails.
- **Search.** `searchSidecar` embeds the query, scores every chunk with `cosine`, sorts the scores, and returns the first `topK`. A search never opens the video.

### src/remember/embeddings.ts

```typescript
export function embed(text: string): Float32Array;
export function cosine(a: Float32Array, b: Float32Array): number;
export function embeddingToBlob(vec: Float32Array): Buffer;
export function blobToEmbedding(blob: Buffer | Uint8Array | ArrayBuffer): Float32Array;
export { EMBED_DIM };  // 384
```

Behavior notes:

- **Method.** `embed` lowercases the text and takes the tokens that match `[a-z0-9_]+` and have two or more characters. Each token adds a signed weight to one of 384 slots. One hash function with two seeds chooses the slot and the sign. The weight is `1 + ln(1 + count of the token)`. The function then scales the vector to unit length.
- **No tokens.** Text with no usable token gives the vector with 1 in the first slot.
- **Language.** The tokenizer keeps ASCII letters, digits and underscores. Other characters separate tokens. Text with no ASCII token of two or more characters gets the no-token vector. Any two such texts, for example two Chinese sentences, score 1 against each other.
- **Similarity.** `cosine` is a plain dot product of the shorter length. For two outputs of `embed`, the dot product is the cosine similarity.
- **Cost.** The function counts a token again for every slot update, so a long text costs a quadratic number of comparisons in its token count.
- **Storage.** `embeddingToBlob` shares the memory of the vector. `blobToEmbedding` shares the memory of a `Buffer` or `ArrayBuffer`. A `Uint8Array` input is copied.

### src/remember/sectors.ts

```typescript
export function classifySectors(content: string): {
  primary: SectorType;
  sectors: SectorType[];
};
```

The function counts, for each of the five sectors, how many of its ten keywords occur as a substring of the lowercased text. The sector with the most matches is primary. When two sectors tie, the earlier one in the list `episodic`, `semantic`, `procedural`, `emotional`, `reflective` wins. Up to two more sectors with at least one match follow. When nothing matches, the result is `semantic` alone.

Behavior notes: a keyword match is a substring match, so `is a` matches inside longer words.

### src/remember/scheduler.ts

The full signature is in [API.md](API.md#library-archivalscheduler).

Behavior notes:

- `start` sets `enabled` and `running`, and schedules a pass with a delay of 0. The pass runs `archiveOldMemories` with the threshold and the minimum salience of the memory system, for every owner.
- After a successful pass, the scheduler waits `interval` seconds. After an error, the scheduler stores the message in `last_error` and waits 60 seconds.
- `stop` clears the timer and sets `running` to false. The `enabled` flag keeps its value.
- `runNow` returns false while `enabled` is false. Otherwise `runNow` calls `_runArchival()` and returns true. The timer calls `_runArchival()` too.
- `getStatus` reports `next_run_in` as the interval minus the time since `last_run`, in whole seconds with a minimum of 0. The value is null while the scheduler is stopped or before the first pass ends.

### src/remember/types.ts

The file holds the shared types. The full text is in [API.md](API.md#library-types).

```typescript
export enum MemoryLocation { ACTIVE = "active", ARCHIVE = "archive" }
export type SectorType = "episodic" | "semantic" | "procedural" | "emotional" | "reflective";
export const SECTORS: readonly SectorType[];
export interface HybridMemoryResult { ... }
export interface ArchiveStats { ... }
export interface SystemStats { ... }
export interface ArchiveInfo { file: string; index: string; created_at: number; memory_count: number }
export type ArchiveIndex = Record<string, Record<string, ArchiveInfo>>;
```

### src/remember/ensure-dir.ts

```typescript
export function ensureDir(dir: string): void;
```

Behavior notes:

- **Purpose.** The function creates a folder and its missing parents. The function does nothing when the folder exists.
- **Reason.** `mkdirSync` with `recursive` must accept a folder that exists. Bun on Windows can throw `EEXIST` for `.`, and the call succeeds on Linux. Some Bun releases also throw `EEXIST` for `..` and `ENOENT` for `./`. A bare file name such as `remember_mcp.db` has `.` as its parent folder.
- **Method.** The function reads the path with `statSync`. `existsSync` can report `false` for `./`, so the function does not use it.
- **Errors.** A path that names a file still throws, because `mkdirSync` reports it.
- **Callers.** `ActiveStore` uses it for the database folder. `RememberSystem` uses it for the archive folder. `archive.ts` uses it for the folders of the sidecar and the video. `FileIndexer` uses it for the index folder.

### src/remember/index.ts

The library barrel. The file re-exports `RememberSystem`, `FileIndexer`, `ArchivalScheduler`, `MemoryLocation`, the types `HybridMemoryResult`, `ArchiveStats`, `SystemStats` and `SectorType`, and `PKG_VERSION` under the name `VERSION`.

## File indexing

### src/remember/file-indexer.ts

The full public signature is in [API.md](API.md#library-fileindexer).

Behavior notes:

- **Path policy.** `_enforcePathPolicy` runs first. The function resolves the path. The function checks the path against the allowed roots. The function refuses a dotfile path unless the caller allows it. The function checks that the target is a file or a folder.
- **Roots.** A root check passes when the path equals a root or lies below it. The function uses a relative-path test, so a sibling folder with a matching name prefix does not pass.
- **Dotfile rule.** A path is a dotfile path when any segment starts with a dot. A Windows drive letter does not count.
- **Order of checks in `indexFile`.** Chunk settings, path policy, size limit, content hash, known-hash exit, PDF and EPUB refusal, binary refusal, non-UTF-8 refusal. Then chunking, refusal of a file with no chunk, encode, record. The known-hash exit comes before the PDF refusal, the binary refusal and the non-UTF-8 refusal.
- **Duplicate detection.** The key is the SHA-256 digest of the file bytes. A second path with the same bytes returns `already_indexed` with the first path.
- **Binary test.** A zero byte in the first 8192 bytes marks a file as binary.
- **Decoding.** The indexer decodes the file with a strict UTF-8 decoder that throws on an invalid byte. The `catch` branch then throws a `PermissionError` that names the path, and the indexer records nothing for the file. A leading byte order mark stays in the text.
- **Line chunks.** For the code types, `chunkCodeWithLines` takes `max(1, floor(chunk_size / 50))` lines per chunk and writes the header `[name:first-last]` and a line break before the lines. The function also builds `chunks_meta` with the line numbers and the character offsets of each chunk.
- **Window chunks.** `chunkText` returns no chunk for an empty text. The function returns the whole text as one chunk when the text fits. Otherwise the function cuts windows of `chunk_size` UTF-16 units. Each window starts `overlap` units before the end of the last one. A window starts at least one unit after the last start. A window that would end inside a surrogate pair ends one unit early. A window that would start inside a pair starts one unit late. So a window never holds half of a pair, and never holds more than `chunk_size` units. With an `overlap` one below `chunk_size`, a window whose end moved early can end where the last window ended. Such a window adds no text, and the function drops it.
- **Empty text.** An empty file gives no chunk when `chunkText` splits it. `indexFile` then throws an error with the message `No indexable content in <path>`. The indexer records nothing for the file. A code file with `preserve_lines` always gives a header chunk. The known-hash exit runs first, so an empty file answers `already_indexed` after another empty file was indexed.
- **Metadata file.** `file_metadata.json` maps the content hash to the metadata. The indexer writes the file after each indexed file, through a temporary file and a rename.
- **Corrupt metadata.** When the file does not parse, the indexer renames the file to `file_metadata.json.corrupt` and starts with an empty index.
- **Directory scan.** `indexDirectory` scans with `Bun.Glob`, files only. For each match the function skips a path outside the folder, a path that contains an exclude string, and a dotfile path. The remaining files go through `indexFile`, one at a time.
- **Directory cap.** The scan stops when it meets the 501st candidate. The result then holds an error entry for the stop.
- **Search.** `search` takes the top `top_k` chunks of each file that passes the filters, merges them, sorts them, and keeps `top_k`. The method skips a file whose video or sidecar is missing.
- **`line_info`.** The method adds `line_info` to a hit when the metadata of the file has `chunks_meta`, which means the indexer split the file by lines. The value is the header `[name:first-last]` at the start of the chunk, without its line break. A hit of any other file never has `line_info`.
- **Lookup.** `getFileInfo` matches the stored path, then the resolved path, and then the content hash of the file when the file exists.
- **Size limit.** The default limit is 32 MiB. The check uses the file size before the indexer reads the file.
- **`close`.** The method does nothing. A search reads sidecar files and keeps nothing open.

## Scaffolding

### src/example.ts

A demo program. The file builds a `RememberSystem` using `demo.db` and `demo_archives/`. The file adds sample memories. The file queries the memories. The file reads the statistics. The file prints the results to standard output. A developer runs the file with `bun run src/example.ts`. No other file imports the file. The dependency graph reports the file as orphaned.

## Dependencies between components

Each row lists the package files that a module imports. A module that imports nothing from the package has a dash.

| Module | Imports from the package |
|---|---|
| `index.ts` | `server.ts`, `tools.ts` |
| `server.ts` | `tools.ts`, `version.ts` |
| `tools.ts` | `remember/system.ts`, `remember/scheduler.ts`, `remember/file-indexer.ts` |
| `version.ts` | `package.json` |
| `remember/index.ts` | `system.ts`, `file-indexer.ts`, `scheduler.ts`, `types.ts`, `version.ts` |
| `remember/system.ts` | `active-store.ts`, `archive.ts`, `ensure-dir.ts`, `types.ts` |
| `remember/active-store.ts` | `embeddings.ts`, `ensure-dir.ts`, `sectors.ts`, `types.ts` (type only) |
| `remember/archive.ts` | `embeddings.ts`, `ensure-dir.ts` |
| `remember/file-indexer.ts` | `archive.ts`, `ensure-dir.ts` |
| `remember/scheduler.ts` | `system.ts` (type only) |
| `remember/sectors.ts` | `types.ts` |
| `remember/embeddings.ts` | none |
| `remember/ensure-dir.ts` | none |
| `remember/types.ts` | none |
| `example.ts` | `remember/index.ts` |

Rules that the graph follows:

- The server layer imports the memory engine. The memory engine never imports the server layer.
- `FileIndexer` and `RememberSystem` do not import each other. Both use `archive.ts`.
- The dependency graph has no circular dependency. The generated report [DEPENDENCY_GRAPH.md](DEPENDENCY_GRAPH.md) gives the full matrix.

## Verification

Generated by `repo-tools map`.
Regenerate the reports: `repo-tools map . --out=docs/architecture` · Check: `repo-tools check . --docs=docs/architecture`

The claims come from `repo-tools map .`, which reads the whole repository. A direct reading of each source file gives the signatures and the behavior notes.

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 28 | repo-tools map (whole repository) |
| totalExports | 61 | repo-tools map (whole repository) |
| runtimeCircularDeps | 0 | repo-tools map (whole repository) |
