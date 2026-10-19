# API Reference

This document gives the public surface of remember-mcp: the MCP tools and the library entry points.

## Contents

- [Entry points](#entry-points)
- [How a tool call returns](#how-a-tool-call-returns)
- [Memory tools](#memory-tools)
- [Scheduler tools](#scheduler-tools)
- [File tools](#file-tools)
- [Library: RememberSystem](#library-remembersystem)
- [Library: FileIndexer](#library-fileindexer)
- [Library: ArchivalScheduler](#library-archivalscheduler)
- [Library: types](#library-types)

## Entry points

| Entry | Resolves to | Use |
|---|---|---|
| `remember-mcp` (bin) | `src/index.ts` | Starts the MCP server on stdio. |
| `remember-mcp` (import) | `src/remember/index.ts` | The library barrel. |
| `remember-mcp/server` (import) | `src/server.ts` | `buildServer()`, which returns a configured `McpServer`. |

The `exports` field of `package.json` lists only the two import paths. A caller cannot import another file of the package.

The library barrel exports these names: `RememberSystem`, `FileIndexer`, `ArchivalScheduler`, `MemoryLocation`, the types `HybridMemoryResult`, `ArchiveStats`, `SystemStats` and `SectorType`, and `VERSION`. `VERSION` is `PKG_VERSION` from `src/version.ts`.

The server announces the name `remember` and the package version. The server offers the `tools` capability only.

## How a tool call returns

A handler returns a value. The server writes the value as pretty-printed JSON (two-space indent) in one text content block.

A tool reports an error in one of three ways:

| Case | Result shape |
|---|---|
| A bad argument, a missing file or a refused path | An object `{ "error": "<code>", "message": "<text>" }`. The error codes are `invalid_argument`, `not_found` and `permission_denied`. |
| A bad argument in `query_memory` or `search_files` | A list that holds one such object. |
| Any other thrown error | A text block with `{ "status": "error", "error": "<message>" }`, and `isError` is true on the result. The server also writes the message to standard error. |

The error-object cases return a normal result. `isError` is not set for them.

Each tool has an `inputSchema`. Every top-level schema sets `additionalProperties` to false.

## Memory tools

### add_memory

Add a memory to active storage.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `content` | string | yes | Not empty after trimming. At most 100,000 characters. |
| `user_id` | string | no | The owner of the memory. The default is no owner. |
| `tags` | string list | no | The handler drops list items that are not strings. |
| `metadata` | object | no | Stored as JSON. |

Result: the stored memory with these fields: `id`, `content`, `primary_sector`, `sectors`, `salience`, `user_id`, `tags`, `created_at` (milliseconds since the epoch), and `location` (always `active`). A new memory has salience 0.85.

Errors: `invalid_argument` when the content is empty or too long.

### query_memory

Search active memory, and the archives of the same user key, with one ranking.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Not empty after trimming. |
| `k` | integer | no | From 1 to 100. The default is 10. |
| `user_id` | string | no | Limits active memories to this owner, and selects this owner's archives. |
| `include_archive` | boolean | no | The default is true. |
| `sectors` | string list | no | Keeps active memories that have at least one listed sector. The match ignores case. |

Result: a list of at most `k` objects, sorted by `score`, highest first. Each object has `id`, `content`, `score`, `location`, `primary_sector`, `sectors`, `salience`, `archived_at` and `archive_file`. The last two fields are null for an active memory.

Behavior notes:

- Without `user_id`, the active search covers the memories of every owner. The archive search covers only the archives of the key `default`.
- The `sectors` filter applies to active memories only. An archive hit passes the filter.
- An archive hit has the sector `semantic`, salience 0, and a score that is 0.8 times the cosine similarity. Its `id` is `archive_<timestamp>_<16 hex digits>`, where the digits are a SHA-256 digest of the chunk text.
- The tool raises the salience of each returned active memory by 0.05 (maximum 1.0) and sets its last-seen time to now. The tool annotation says `readOnlyHint: true`, and the annotation does not show these writes.

Errors: a list of one `invalid_argument` object for an empty query or a bad `k`.

### archive_memories

Move old, low-salience memories into a new archive video. The tool carries the annotation `destructiveHint: true`, because the pass deletes the active rows.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `age_days` | number | no | The server truncates the value to an integer. The default is 60. The value 0 is valid. A negative value is an error. |
| `min_salience` | number | no | The default is 0.2. |
| `user_id` | string | no | Limits the pass to one owner. |

A memory is eligible when both rules hold: the memory is at least `age_days` old, and its decayed salience is below `min_salience`. A new memory has salience 0.85, so `min_salience` of 1.0 selects every memory that is old enough.

Result: `archived_count`, `active_remaining`, `archive_size_bytes` and `compression_ratio`. The ratio is the text size divided by the video size. When no memory is eligible, or when the encoder fails, the result has `archived_count` 0, `archive_size_bytes` 0 and `compression_ratio` 1.

Behavior notes:

- Without `user_id`, the pass selects the memories of every owner and stores them in one archive under the key `default`.
- The archive files are `user_<key>_<unix seconds>.mp4` and `user_<key>_<unix seconds>.json` in the archive directory.
- A pass uses the first second that the index and the archive directory do not use for the key. Two passes of one `RememberSystem` in the same second write different files.

Errors: `invalid_argument` for a negative `age_days`.

### recall_memory

Add content to active storage and record the archive that the content came from. The tool does not read the archive. The tool checks that the archive exists.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `archive_file` | string | yes | The video path, the video file name, or the file name without its extension. |
| `content` | string | yes | The text to store. The same limits as `add_memory` apply. |
| `user_id` | string | no | Searches only the archives of this key. Without it, the tool searches the archives of every key. |

Result: the same object as `add_memory`. The stored row also has the metadata `recalled_from`, which holds the video path.

Errors: `not_found` when the archive is unknown or its video file is missing. `invalid_argument` for bad content.

### get_stats

Return statistics for active storage and the archives.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `user_id` | string | no | Limits the counts to one owner. |

Result: an object with these fields.

| Field | Meaning |
|---|---|
| `active_count` | Memories in active storage. |
| `archive_count` | Memories in archives. This is the sum of the memory counts, not the number of files. |
| `archive_file_count` | Archive videos. |
| `total_memories` | `active_count` plus `archive_count`. |
| `active_db_size` | Size of the SQLite file, in bytes. |
| `archive_size` | Total size of the archive videos that exist, in bytes. |
| `total_size` | `active_db_size` plus `archive_size`. |
| `compression_ratio` | `total_size` divided by `active_db_size`. The value is 1 when the database file is absent. |
| `avg_salience` | The mean of the decayed salience of the active memories. |

## Scheduler tools

The scheduler runs `archiveOldMemories` with the system threshold (60 days) and the system minimum salience (0.2), for every owner. The interval is 86,400 seconds.

### scheduler_status

No parameters. Result: `running`, `enabled`, `interval_seconds`, `last_run` (milliseconds since the epoch, or null), `total_archived`, `next_run_in` (seconds, or null) and `last_error`.

The server builds the scheduler with `enabled` set to false. `next_run_in` is null while the scheduler is stopped or before the first pass ends.

### scheduler_control

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `action` | string | yes | `start`, `stop` or `run_now`. |

- `start` enables the scheduler and schedules the first pass at once. After each pass, the scheduler waits for the interval. After a failed pass, the scheduler waits 60 seconds.
- `stop` cancels the timer. The `enabled` flag stays as it was.
- `run_now` runs one archive pass while `enabled` is true. Before the first `start`, `enabled` is false: the call then runs no pass and answers `Scheduler not started`. When the pass fails, the call throws, and the result is an error with `isError` true.

Result: `{ "status": "Scheduler started" }`, `{ "status": "Scheduler stopped" }`, `{ "status": "Archival triggered" }` or `{ "status": "Scheduler not started" }`.

Errors: `invalid_argument` for another action.

## File tools

The file tools use the `FileIndexer`, which is separate from the memory store. Every path must be inside an allowed root. The environment variable `REMEMBER_INDEX_ROOTS` sets the roots as a comma-separated list. The default root is the `Documents` folder of the user. A leading `~` in a path expands to the home folder.

### index_file

Index one file. The tool splits the text into chunks, writes a QR video and a JSON sidecar, and records the file.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `file_path` | string | yes | Must be a file inside an allowed root. |
| `chunk_size` | integer | no | From 32 to 1,000,000. The default is 1024. |
| `overlap` | integer | no | At least 0 and less than `chunk_size`. The default is 128. |
| `preserve_lines` | boolean | no | The default is true. Applies to code files. |
| `index_dotfiles` | boolean | no | The default is false. |

Result for a new file: `status` `indexed`, `file_path`, `file_hash`, `chunk_count`, `video_size` and `compression_ratio`.

Result for a file with known content: `status` `already_indexed`, `file_path` (the first path), `file_hash` and `indexed_at`. The content hash is a SHA-256 digest of the file bytes.

Errors:

| Code | Cause |
|---|---|
| `permission_denied` | A path outside the allowed roots, a dotfile (unless `index_dotfiles` is true), a file larger than 32 MiB, a file with a zero byte in its first 8192 bytes, or a file that is not valid UTF-8. |
| `not_found` | The path is not a file. |
| `invalid_argument` | A bad chunk setting, a PDF or EPUB file, an empty file that the indexer splits into windows, or any other error that the indexer raises. |

Chunking rules:

- A file of type `python`, `javascript`, `typescript`, `java`, `cpp` or `c` is split by lines when `preserve_lines` is true. Each chunk holds `chunk_size` divided by 50 lines (at least 1) and starts with the header `[name:first-last]`. These chunks do not overlap.
- Any other file is split into windows of `chunk_size` UTF-16 units. Each window starts `overlap` units before the end of the last window. A window starts at least one unit after the last start. A cut never splits a surrogate pair, so a code point stays whole. The indexer drops a window that ends where the last window ended, because that window adds no text.
- An empty file that the indexer splits into windows gives no chunk. The indexer refuses such a file with the message `No indexable content in <path>`.
- The type comes from the file extension. An extension that is not in the map gives the type `unknown`, and the indexer treats the file as text.

### index_directory

Index the files of a folder that match a glob pattern.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `dir_path` | string | yes | Must be a folder inside an allowed root. |
| `pattern` | string | no | A glob. The default is `**/*`. |
| `exclude` | string list | no | Substrings. The tool skips a file when its full path contains one. |
| `chunk_size` | integer | no | As in `index_file`. |
| `overlap` | integer | no | As in `index_file`. |
| `index_dotfiles` | boolean | no | The default is false. |

The tool always excludes paths that contain `.git`, `__pycache__`, `node_modules`, `.pyc`, `.mp4` or `.mp3`. A caller list adds to these.

Result: `indexed_count`, `skipped_count`, `error_count`, `indexed_files` (the `index_file` results) and `errors` (a list of `file` and `error`). A file that fails does not stop the run. The run stops after 500 candidate files and adds an error entry for the stop.

Errors: the same codes as `index_file`, for the folder.

### search_files

Search every indexed file.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Not empty after trimming. |
| `top_k` | integer | no | From 1 to 100. The default is 10. |
| `file_filter` | string | no | Keeps files whose path contains this text. |
| `file_type_filter` | string | no | Keeps files of exactly this type, such as `typescript`. |

Result: a list of at most `top_k` objects, sorted by `score`. Each object has `content`, `score`, `file_path`, `file_name`, `file_type`, `file_hash` and `indexed_at`. The tool adds `line_info` to a hit of a file that the indexer split by lines. The value is the header at the start of the chunk, without its line break, for example `[sample.ts:1-20]`. A hit of any other file has no `line_info`, whatever its text starts with.

A file whose video or sidecar is missing is skipped without an error.

Errors: a list of one `invalid_argument` object for an empty query or a bad `top_k`.

### list_indexed_files

No parameters. Result: a list with one object for each indexed file: `file_path`, `file_name`, `file_type`, `file_size`, `chunk_count` and `indexed_at`.

### get_file_info

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `file_path` | string | yes | A path as stored, or a path that resolves to the stored one. |

Result: the metadata object of the file, or null. The object has `file_path`, `file_name`, `file_hash`, `file_type`, `file_size`, `chunk_count`, `chunk_size`, `overlap`, `video_path`, `index_path`, `chunks_meta`, `indexed_at` and `stats`.

When no stored path matches and the file exists, the tool hashes the file and looks up the hash. A moved file is therefore found.

### get_file_stats

No parameters. Result: `total_files`, `total_chunks`, `total_source_size`, `total_video_size`, `compression_ratio` (source size divided by video size, or 0) and `file_types` (a count for each type).

## Library: RememberSystem

Import from `remember-mcp`.

```typescript
export class RememberSystem {
  readonly activeDb: string;
  readonly archiveDir: string;
  readonly archiveThresholdDays: number;
  readonly archiveMinSalience: number;
  readonly autoArchiveEnabled: boolean;
  readonly active: ActiveStore;
  archiveIndex: ArchiveIndex;

  constructor(opts?: RememberSystemOptions);
  static archiveKey(userId?: string | null): string;
  addMemory(opts: {
    content: string;
    user_id?: string | null;
    tags?: string[] | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<Record<string, unknown>>;
  query(opts: {
    query: string;
    k?: number;
    user_id?: string | null;
    include_archive?: boolean;
    sectors?: string[] | null;
  }): Promise<HybridMemoryResult[]>;
  archiveOldMemories(opts?: {
    age_days?: number | null;
    min_salience?: number | null;
    user_id?: string | null;
  }): Promise<ArchiveStats>;
  recallFromArchive(opts: {
    archive_file: string;
    content: string;
    user_id?: string | null;
  }): Promise<Record<string, unknown>>;
  getStats(userId?: string | null): Promise<SystemStats>;
  close(): void;
}

export interface RememberSystemOptions {
  active_db?: string;
  archive_dir?: string;
  archive_threshold_days?: number;
  archive_min_salience?: number;
  auto_archive_enabled?: boolean;
}
```

Defaults for the library: `active_db` is `remember_active.db`, `archive_dir` is `archives/`, `archive_threshold_days` is 60, `archive_min_salience` is 0.2, and `auto_archive_enabled` is false. The MCP server uses different file names: `remember_mcp.db` and `mcp_archives/`.

The constructor creates the archive folder, opens the database, and reads the archive folder to rebuild `archiveIndex`. A folder that exists is accepted, including `.` and `./`. A bare file name for `active_db` puts the database in the working directory. The rebuild accepts only video files named `user_<key>_<digits>.mp4`.

`archiveKey` returns the user id, or `default` when the id is null, undefined or empty.

No code reads `autoArchiveEnabled`. Use `ArchivalScheduler` to archive on a timer.

The class exports the constants `MAX_CONTENT_CHARS` (100,000) and `MAX_QUERY_K` (100) from its module. The barrel does not re-export them.

Errors: `addMemory` and `recallFromArchive` throw an `Error` for bad content. `query` throws for an empty query or for a `k` that is not an integer from 1 to 100. `archiveOldMemories` throws for a negative `age_days`. `recallFromArchive` throws an error with the name `FileNotFoundError` for an unknown archive or a missing video.

## Library: FileIndexer

Import from `remember-mcp`.

```typescript
export class FileIndexer {
  readonly indexDir: string;
  readonly allowedRoots: string[];
  readonly maxFileBytes: number;
  readonly maxDirectoryFiles: number;
  readonly metadataFile: string;
  metadata: Record<string, FileMeta>;

  constructor(opts?: FileIndexerOptions);
  close(): void;
  indexFile(opts: {
    file_path: string;
    chunk_size?: number;
    overlap?: number;
    preserve_lines?: boolean;
    index_dotfiles?: boolean;
  }): Promise<Record<string, unknown>>;
  indexDirectory(opts: {
    dir_path: string;
    pattern?: string;
    exclude?: string[] | null;
    chunk_size?: number;
    overlap?: number;
    index_dotfiles?: boolean;
  }): Promise<Record<string, unknown>>;
  search(opts: {
    query: string;
    top_k?: number;
    file_filter?: string | null;
    file_type_filter?: string | null;
  }): Record<string, unknown>[];
  getFileInfo(filePath: string): FileMeta | null;
  listIndexedFiles(): Record<string, unknown>[];
  getStats(): Record<string, unknown>;
}

export interface FileIndexerOptions {
  index_dir?: string;
  allowed_roots?: string[] | null;
  max_file_bytes?: number;
  max_directory_files?: number;
}
```

Defaults: `index_dir` is `file_index/` (the MCP server uses this value), `max_file_bytes` is 32 MiB, and `max_directory_files` is 500. A non-null `allowed_roots` replaces the roots from the environment. The constructor creates the index folder if it is missing. A folder that exists is accepted, including `.` and `./`.

`FileMeta` is `Record<string, unknown>`, and the module does not export the alias.

The indexer stores one video and one sidecar for each file, named with the content hash. The file `file_metadata.json` in the index folder records the files. A metadata file that cannot be parsed is renamed with the suffix `.corrupt`, and the index starts empty.

Errors: the methods throw an `Error`. The `name` is `PermissionError`, `FileNotFoundError` or `ValueError` for the causes in the table of `index_file`. A bad chunk setting and a file with no chunk throw a plain `Error`. The `close` method does nothing.

## Library: ArchivalScheduler

Import from `remember-mcp`.

```typescript
export class ArchivalScheduler {
  readonly system: RememberSystem;
  interval: number;
  enabled: boolean;
  running: boolean;
  last_run: number | null;
  total_archived: number;
  last_error: string | null;

  constructor(rememberSystem: RememberSystem, intervalSeconds?: number, enabled?: boolean);
  start(): Promise<void>;
  stop(): Promise<void>;
  runNow(): Promise<boolean>;
  getStatus(): Record<string, unknown>;
}
```

Defaults: `intervalSeconds` is 86,400 and `enabled` is true. The constructor throws when `intervalSeconds` is below 1. The MCP server builds the scheduler with `enabled` set to false.

`start` returns at once when the scheduler already runs. `runNow` runs one pass and returns true. While `enabled` is false, `runNow` runs no pass and returns false. When the pass fails, `runNow` rejects and stores the message in `last_error`.

## Library: types

```typescript
export enum MemoryLocation { ACTIVE = "active", ARCHIVE = "archive" }

export type SectorType = "episodic" | "semantic" | "procedural" | "emotional" | "reflective";

export interface HybridMemoryResult {
  id: string;
  content: string;
  score: number;
  location: MemoryLocation;
  sectors: string[];
  primary_sector: string;
  salience: number;
  last_seen_at: number;
  archived_at?: number | null;
  archive_file?: string | null;
}

export interface ArchiveStats {
  archived_count: number;
  active_remaining: number;
  archive_size_bytes: number;
  compression_ratio: number;
}

export interface SystemStats {
  active_count: number;
  archive_count: number;
  total_memories: number;
  active_db_size: number;
  archive_size: number;
  total_size: number;
  compression_ratio: number;
  avg_salience: number;
  archive_file_count: number;
}
```

In an archive hit, `archived_at` and `last_seen_at` both hold the archive creation time in seconds since the epoch. In an active result, `last_seen_at` is in milliseconds.

## Verification

Generated by `repo-tools map`.
Regenerate the reports: `repo-tools map . --out=docs/architecture` · Check: `repo-tools check . --docs=docs/architecture`

The claims come from `repo-tools map .`, which reads the whole repository. A direct reading of `src/tools.ts`, `src/server.ts` and `package.json` gives the tool and entry-point facts.

| Claim | Value | Source |
|---|---|---|
| totalExports | 61 | repo-tools map (whole repository) |
| totalSourceFiles | 28 | repo-tools map (whole repository) |
