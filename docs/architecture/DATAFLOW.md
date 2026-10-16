# Data Flow

This document traces the path of each operation through remember-mcp. Each trace names the steps as `File.method()`.

## Contents

- [Startup](#startup)
- [The request path](#the-request-path)
- [Memory operations](#memory-operations)
- [Archive operations](#archive-operations)
- [Scheduler operations](#scheduler-operations)
- [File operations](#file-operations)
- [Files on disk](#files-on-disk)
- [Caching](#caching)
- [Error paths](#error-paths)
- [Shutdown](#shutdown)

## Startup

1. `bun run src/index.ts` runs `index.ts`.
2. `serveStdio(buildServer)` starts the stdio transport, with `buildServer` from `server.ts` as the server factory.
3. `buildServer()` creates an `McpServer`, and registers the 13 tools from `TOOLS` with their `HANDLERS`.
4. `index.ts` writes one line to standard error and registers the `SIGINT` and `SIGTERM` handlers.

No step opens the database, creates a folder or starts `ffmpeg`. The `initialize` request therefore finishes without any storage work.

## The request path

Every `tools/call` request follows this path.

1. The SDK finds the registered tool and calls the wrapper from `buildServer()`.
2. The wrapper calls `HANDLERS[name](args ?? {})`.
3. The handler in `tools.ts` coerces the raw arguments with `asOptionalString`, `asOptionalNumber`, `asOptionalBool` or `asOptionalStringList`.
4. The handler calls `agetSystem()` or `agetFileIndexer()`. The first call under the init lock builds the singletons. Later calls return the same objects.
5. The handler calls a method of `RememberSystem`, `ArchivalScheduler` or `FileIndexer`.
6. The wrapper turns the return value into one text block with `JSON.stringify(result, null, 2)`.

The first call of a process pays the cost of step 4. The cost is the creation of the archive folder, the opening of the SQLite database, and the scan of the archive folder for existing archives. A file tool pays a smaller cost: the creation of the index folder and the read of `file_metadata.json`.

A handler returns an error object for a bad argument. The wrapper does not see an exception in that case, and the call returns a normal result.

## Memory operations

### add_memory

1. `HANDLERS.add_memory` builds the argument object and calls `RememberSystem.addMemory()`.
2. `validateContent()` checks that the content is a non-empty string of at most 100,000 characters.
3. `withWriteLock()` waits for earlier writers.
4. `ActiveStore.addMemory()` classifies the sectors with `classifySectors()`, makes a UUID, and computes the embedding with `embed()`.
5. The method inserts one row with salience 0.85, `created_at` and `last_seen_at` set to now, and the embedding as a BLOB.
6. `RememberSystem.addMemory()` adds `location: "active"` to the stored fields and returns them.

The write lock covers the insert and nothing else.

### query_memory

1. `HANDLERS.query_memory` calls `RememberSystem.query()`.
2. `query()` verifies the query is not empty. `query()` also verifies that `k` is an integer from 1 to 100. The default value for `k` is 10.
3. `ActiveStore.query()` embeds the query and reads the rows of the owner, or all rows without an owner.
4. The method drops rows that have none of the requested sectors. For each row, the method computes the decayed salience and a score of `0.85 × similarity + 0.15 × salience`.
5. The method sorts the rows, keeps the first `k`, and updates `last_seen_at` and `salience` of those rows in one transaction.
6. The method runs `_queryArchives()` for each archive of the key of the owner. The call happens only when `include_archive` is not false and the archive index has that key.
7. For each archive, `searchSidecar()` reads the JSON sidecar, embeds the query, scores every chunk, and returns the best `k`. `_queryArchives()` multiplies each score by 0.8 and builds a result with the location `archive`.
8. `query()` sorts the active and archive hits together and returns the first `k`.

An archive that fails to read is logged to standard error and skipped.

### get_stats

1. `RememberSystem.getStats()` calls `ActiveStore.countAndAvgSalience()`. The method reads the salience and the last-seen time of each row, and computes the mean of the decayed values.
2. `_archiveTotals()` walks the archive index, adds the memory counts, and reads the size of each video that exists.
3. The method reads the size of the database file and returns the nine statistics.

## Archive operations

### archive_memories

1. `HANDLERS.archive_memories` calls `RememberSystem.archiveOldMemories()` with the age, the minimum salience and the owner.
2. The method fills defaults using system settings (60 days, 0.2). The method truncates age to an integer. The method throws when age is negative. The method computes the age threshold in milliseconds.
3. `withArchiveLock()` waits for an earlier pass.
4. Under `withWriteLock()`, `ActiveStore.selectEligible()` returns the rows that are old enough and whose decayed salience is below the minimum.
5. When no row is eligible, the method returns zero counts.
6. The method picks a second with `_nextArchiveTimestamp()`. It names the files `user_<key>_<unix seconds>.mp4` and `.json` in the archive folder.
7. `encodeChunks()` runs outside the write lock. The function writes the sidecar, writes the QR frames, runs `ffmpeg`, and measures the video.
8. When step 7 throws, the method logs the error to standard error and returns zero counts. The rows stay in active storage, and `encodeChunks()` has removed its output files.
9. Under `withWriteLock()`, `_commitArchive()` adds the archive to the index, calls `ActiveStore.deleteByIds()`, and measures the video.
10. The method returns the number of archived memories, the number of remaining memories, the video size and the compression ratio.

Limits of this path:

- A second is free when the archive index has no entry for it and the folder has no video or sidecar of that name. A second pass for the same key in the same second therefore uses the next second.
- No lock covers two server processes on one archive folder. The pick and the first write are separate steps, so two processes can pick one name.
- A QR frame holds a limited number of bytes. A slice of 800 characters that are three bytes long each is too large, so step 7 throws. The same rows are then eligible again in the next pass.

### recall_memory

1. `HANDLERS.recall_memory` calls `RememberSystem.recallFromArchive()`.
2. The method validates the content.
3. `_lookupArchive()` searches the index for the archive name. With an owner, the search stays within the key of that owner. Without an owner, the search covers every key.
4. The method throws a `FileNotFoundError` when no archive matches, and again when the video file is missing.
5. The method calls `addMemory()` with the metadata `recalled_from`, which holds the video path.

The path never reads the archive. The caller supplies the content.

## Scheduler operations

### scheduler_control: start

1. `HANDLERS.scheduler_control` calls `ArchivalScheduler.start()`.
2. `start()` returns at once when the scheduler already runs. Otherwise the method sets `enabled` and `running`, and schedules `_tick()` with a delay of 0.
3. `_tick()` calls `_runArchival()`. The method returns at once when `enabled` is false. Otherwise the method calls `_archiveOnce()`, which calls `RememberSystem.archiveOldMemories()` with the system settings and no owner.
4. After a successful pass, `_archiveOnce()` stores `last_run`, adds to `total_archived` and clears `last_error`. `_tick()` schedules the next pass after the interval.
5. After a failed pass, the scheduler stores the message in `last_error` and schedules the next attempt after 60 seconds.

### scheduler_control: stop and run_now

- `stop()` clears the timer and sets `running` to false.
- `runNow()` calls `_archiveOnce()` once, so the call does the work when `enabled` is false. The scheduler of the MCP server starts with `enabled` set to false, so a `run_now` call before the first `start` runs one pass.

## File operations

### index_file

1. `HANDLERS.index_file` calls `FileIndexer.indexFile()`.
2. `validateChunking()` checks `chunk_size` (32 to 1,000,000) and `overlap` (at least 0, below `chunk_size`).
3. `_enforcePathPolicy()` resolves the path and checks the allowed roots, the dotfile rule and the type of the target.
4. The method refuses a file above the size limit.
5. The method hashes the file bytes. When the hash is already in `metadata`, the method returns `already_indexed`.
6. The method refuses PDF and EPUB files, and files with a zero byte in the first 8192 bytes.
7. For a code type with `preserve_lines`, `chunkCodeWithLines()` builds the chunks. For other files, `chunkText()` builds them.
8. `encodeChunks()` writes `<hash>.mp4` and `<hash>.json` in the index folder.
9. `_recordIndex()` stores the metadata under the hash, writes `file_metadata.json`, and returns the result.

### index_directory

1. `FileIndexer.indexDirectory()` validates the chunk settings and the folder, as in `index_file`.
2. The method scans the folder with `Bun.Glob`, files only, with the pattern `**/*` by default.
3. For each match, the method skips a path outside the folder. The method skips a path containing an exclude string. The method skips a dotfile path.
4. The method stops when the candidate count passes the cap (500) and records an error entry.
5. The method calls `indexFile()` for each remaining file and collects the result or the error message. One failure does not stop the scan.

### search_files

1. `FileIndexer.search()` checks the query and `top_k`.
2. The method applies `file_filter` and `file_type_filter` to every `metadata` entry. The method skips entries lacking a video or sidecar.
3. `searchSidecar()` returns the best `top_k` chunks of the file.
4. The method adds the file metadata to each hit, sorts all hits, and returns the first `top_k`.

## Files on disk

All paths are relative to the working directory of the server process. The names below are the ones that the MCP server uses.

| Path | Writer | Content |
|---|---|---|
| `remember_mcp.db` | `ActiveStore` | The `memories` table. SQLite also creates the files `-wal` and `-shm` in WAL mode. |
| `mcp_archives/user_<key>_<unix seconds>.mp4` | `encodeChunks()` | The QR video of one archive pass. |
| `mcp_archives/user_<key>_<unix seconds>.json` | `encodeChunks()` | The sidecar of that archive. |
| `file_index/<sha256>.mp4` | `encodeChunks()` | The QR video of one indexed file. |
| `file_index/<sha256>.json` | `encodeChunks()` | The sidecar of that file. |
| `file_index/file_metadata.json` | `FileIndexer` | The metadata of every indexed file, by content hash. |

## Caching

The code has no cache with an expiry. It keeps four things in memory:

| Object | Key | Built | Changes when |
|---|---|---|---|
| The three singletons | none | On the first call that needs them. | `shutdown()` sets them to null. |
| `RememberSystem.archiveIndex` | user key, then timestamp | In the constructor, from the file names of the archive folder. | `_commitArchive()` adds an entry. The code never removes an entry. |
| `FileIndexer.metadata` | content hash | In the constructor, from `file_metadata.json`. | `_recordIndex()` adds an entry and writes the file. |
| The SQLite page cache | none | By SQLite. | By SQLite. |

A search reads the sidecar JSON from disk on every call. The server does not see an archive that another process adds to the folder, until the next start.

## Error paths

| Where | What happens | What the caller sees |
|---|---|---|
| A handler rejects an argument | The handler returns `{ error, message }`. | A normal result with the error object. A search tool returns a list that holds the object. |
| A handler with no `try` block throws | The wrapper catches the error and writes it to standard error. | `{ "status": "error", "error": <message> }` with `isError` set. |
| `ffmpeg` is missing, or the QR library rejects a slice | `encodeChunks()` removes its outputs and throws. | `archive_memories` returns zero counts. `index_file` returns `invalid_argument`. |
| One archive cannot be read during a query | `_queryArchives()` logs the error. | The query returns the hits of the other archives. |
| A scheduler pass throws | `_tick()` stores `last_error` and retries after 60 seconds. | `scheduler_status` shows `last_error`. |
| The metadata file is corrupt | `FileIndexer` renames the file to `file_metadata.json.corrupt`. | The index starts empty. |

## Shutdown

1. The process receives `SIGINT` or `SIGTERM`.
2. `index.ts` calls `shutdown()` in `tools.ts`.
3. `shutdown()` closes the `RememberSystem`, which closes the SQLite database, and calls `FileIndexer.close()`, which does nothing. A failure of either call is logged to standard error.
4. `shutdown()` sets the three singletons to null.
5. `index.ts` closes the stdio handle and calls `process.exit(0)`.

The scheduler timer is not cleared by `shutdown()`. The process exit ends the timer.

## Verification

Generated by `repo-tools map`.
Regenerate the reports: `repo-tools map . --out=docs/architecture` · Check: `repo-tools check . --docs=docs/architecture`

The claims come from `repo-tools map .`, which reads the whole repository. A direct reading of each source file gives the traces.

| Claim | Value | Source |
|---|---|---|
| totalSourceFiles | 27 | repo-tools map (whole repository) |
| entryRoots | 3 | repo-tools map (whole repository) |
