# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **The Windows CI job fails at the ffmpeg install step when ffmpeg is missing.** `choco install
  ffmpeg -y` exits 0 when it cannot reach its feed ("Unable to find package", "installed 0/0
  packages"). The job went on without ffmpeg, and `bun test` failed 57 tests, with errors that do
  not name the cause. The step now runs `ffmpeg -version` after the install, and tries the pair up
  to three times with a pause of 20 s. If ffmpeg still does not run, the step fails and says so.

- **`embed()` gives a text in a script other than ASCII a vector of its own.** The tokenizer kept only ASCII
  words of two characters or more. Every other text got one vector (1 in the first slot), so a query in
  Chinese, Japanese, Thai, Russian, Greek or Korean ranked all memories in that script equal, and the cosine
  of two different Chinese sentences was 1. A word of another script is now a token. A script that writes
  words without a space (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) gives overlapping pairs of
  characters, or the one character of a run of one. A lone letter of any script is noise, as it is in ASCII.
  Text goes to Unicode form NFC first, so a letter with a separate accent mark and the joined letter give one
  vector. The vector of an ASCII text is byte for byte the vector it was; ten texts pin that against a copy
  of the first version of `embed`. The count of a token is now one pass over a map and no longer a scan for each token, so a text of
  100 000 characters costs a linear number of steps. Vectors that a store already holds are not rewritten.
  The new `currentVector` embeds the text again for a stored vector with 1 in the first slot and 0 in the
  others, in the active store and in the archive search, so an existing memory in these scripts is still found
  after the change. A query of one character of an unspaced script matches only a text that holds that
  character as a run of one. The new file `tests/embeddings.test.ts` has 27 tests, and 19 of them fail
  against the old tokenizer.

- **The test helper `sendJsonRpc` returns the reply to its own request.** The helper read the first line
  that the server wrote, whatever its id, and dropped every other line in its buffer. One notification, or
  one late reply, moved every later answer of a shared session by one request. It checked its limit only
  between reads, so a silent server blocked it forever. One line reader now serves a whole server session.
  The helper skips each line that is not the reply with the same id, keeps unread lines for the next
  request, and stops a read at the limit without losing its bytes. The limit is 100 s, under the 120 s
  that a slow test may run, and a caller can give another limit. A message with no id, and a second
  request while one waits on the same server, throw before anything is written. The new file
  `tests/mcp-stdio.test.ts` has 13 tests on a scripted server. Seven of them fail on the old helper and
  one hangs it. Nine mutations of the helper each fail at least one test.

- **`index_file` refuses an empty file of any type and names the cause.** The text chunker
  returned one empty chunk for an empty text, so the QR library threw `No input text`, and the
  call answered `invalid_argument` with that message. The code chunker returned one header chunk
  for an empty file, so the call indexed the file and recorded the hash that every empty file
  shares. The known-hash exit ran before any content check. After an empty code file, an empty
  text file answered `already_indexed` and not the refusal, and the answer of a directory run
  depended on the order of the files. An index that an earlier version built keeps that hash.
  `indexFile` now refuses a file of zero bytes before it looks up the hash. The message is
  `No indexable content in <path>`, the call answers `invalid_argument`, the indexer records
  nothing, and a directory run lists the file in `errors`. A file of one line break or one space
  is not empty and indexes as before. Tests cover a code, a text, a PDF and an EPUB file, both
  orders, an index that holds the hash, a directory run and the answer over MCP.

- **The text chunker no longer keeps a chunk that adds no text.** With an `overlap` one below
  `chunk_size`, a window can start one unit after the last kept window. If the end of that
  window then moves one unit early to avoid a surrogate pair, it can end where the last window
  ended. It then holds only text that the last window holds. The entry below made that case
  possible. The chunker now drops a window that does not end after the last kept window. For
  any other `overlap` the chunks stay the same, because a window then ends at least one unit
  after the last window. The coverage test of an astral text now also asserts that each chunk
  ends after the one before it. It runs two more sizes and a third prefix length. A new test
  pins that this overlap drops no window of a text without surrogates. Each of 10 mutations of
  the guard fails at least one test. Of the 14 mutations of the chunker in the entry below, 12
  still fail at least one test and 2 loop for ever.

- **The file chunker no longer cuts inside a surrogate pair, so `index_file` no longer throws
  `URIError` and `index_directory` no longer lists the file in `errors`, for text with emoji
  or other characters above U+FFFF.** `chunkText` cut windows of `chunk_size` UTF-16 units
  with `slice`. A cut between the two halves of a pair left a lone surrogate at the end of
  one chunk and at the start of the next, and the `qrcode` package throws `URIError: String
  contained an illegal UTF-16 sequence` on a lone surrogate. The start of the next window, `end - overlap`, could fall
  inside a pair too. A window that would end inside a pair now ends one unit early, and a
  window that would start inside a pair now starts one unit late. A chunk never holds more
  than `chunk_size` units, and the overlap never grows. Every file that indexed before has no
  cut inside a pair, so neither adjustment applies to it and its chunks are the same. This
  closes the separate item that the entry below names. `chunkCodeWithLines` cuts at line
  breaks and is not changed. Five new tests in `tests/file-indexing.test.ts`: four fail on
  the old code with `URIError`, and one (the boundaries of a text without surrogates) passes
  on both. Each of 14 mutations of the chunker fails at least one test.

- **A QR frame now holds at most 800 UTF-8 bytes, not 800 characters, so long CJK and emoji
  text can be archived and indexed.** `splitForQr` cut each chunk into slices of 800
  UTF-16 units. A QR frame at error correction level M holds 2331 bytes, so 800 characters of
  three bytes each (2400 bytes) made the `qrcode` package throw `The amount of data is too big
  to be stored in a QR Code`. `archive_memories` then returned zero counts and kept the rows,
  so one memory of more than 777 CJK characters blocked every pass that selected it, and
  `index_file` failed for CJK text at the default `chunk_size` of 1024. A cut at 800 units
  could also fall inside a surrogate pair, and the package throws `URIError: String contained
  an illegal UTF-16 sequence` on a lone surrogate, so emoji text failed too. The slice budget
  is now 800 UTF-8 bytes, and a cut falls only between two code points. ASCII text keeps
  slices of 800 characters. Text of two-byte characters gets more frames than before: 800
  characters of `é` were one frame and are now two, so `video_size` and `compression_ratio`
  of such an archive change. Ten new tests in `tests/video.test.ts` and
  `tests/file-indexing.test.ts`: eight fail on the old code, and two pass on both (the ASCII
  frame sizes, which stay as they were). Each of 13 mutations of `splitForQr` fails at least
  one test. A chunk that already holds a lone surrogate still fails. The file chunker could
  make one, and the entry above fixes that.

- **`scheduler_control` with `run_now` now answers `Scheduler not started` before the
  scheduler has started.** The server builds its scheduler with `enabled` set to false, and
  `runNow` returned at once while `enabled` was false. The tool still answered `Archival
  triggered`, and `scheduler_status` kept `last_run` at null. `runNow` now returns true after
  a pass and false when it ran none, and the tool answers by that value. The call still runs
  no pass before `start`. The option that `run_now` runs a pass while `enabled` is false was
  considered and held for the owner, because that pass moves rows out of the active store
  under the default key. The new test file `tests/scheduler.test.ts` has 8 tests. 4 of them
  fail on the old code. Removing the gate from `runNow` makes 2 fail, and a handler that
  ignores the result makes 1 fail. One test starts the server and calls `scheduler_control`
  before and after `start`.

- **`index_file` now refuses a file that is not valid UTF-8, and `index_directory` lists such
  a file in `errors`.** The indexer decoded every file with `Buffer.toString("utf8")`. That
  call replaces each invalid byte with U+FFFD and never throws, so a Latin-1 file was
  indexed with damaged text, and the `catch` branch that refuses a non-UTF-8 file could not
  run. The indexer now decodes with a fatal `TextDecoder`. The tool answers
  `{ error: "permission_denied", message: "Refusing to index non-UTF-8 file: <path>" }`
  and records nothing for the file. A file with a leading byte order mark decodes as
  before, and the mark stays in the text. A file that the indexer stored before this change
  keeps its stored text: `index_file` answers `already_indexed` for it, because the check of
  the content hash runs before the decode. Six new tests in `tests/file-indexing.test.ts`:
  four fail on the old code (one of them calls `index_file` over MCP), and two pass on
  both. Each of two mutations of the decoder options (no `fatal`, and `ignoreBOM: false`)
  fails at least one test.

- **`search_files` now sets `line_info` for a code chunk, and no longer sets it for a text
  chunk that starts with a link reference.** `FileIndexer.search` set `line_info` when the
  chunk text started with `[` and contained `]:`. The header that `chunkCodeWithLines` writes
  is `[name:first-last]` and a line break, so a code chunk got `line_info` only when its body
  held `]:`, and a text chunk such as `[1]: https://example.com` got the wrong value `[1]`.
  The search now sets `line_info` only for a file whose metadata has `chunks_meta` (the
  indexer split the file by lines), and only when the chunk starts with a header of that
  form. The value is the header without its line break. Three new tests in
  `tests/file-indexing.test.ts`: two fail on the old code. The third passes on the old code,
  and fails when the `chunks_meta` condition is removed from the new code.

- **Two archive passes in the same second no longer share one archive name.** An archive
  name is `user_<key>_<unix seconds>`. Two passes for one key in one second wrote the same
  names, so the later pass replaced the files of the earlier archive. When the later pass
  failed to encode, its cleanup also deleted the earlier archive's files, and the index
  still pointed at them. `RememberSystem._nextArchiveTimestamp` now picks the first second,
  from now on, with no index entry and no video or sidecar of that name in the folder. A
  pass can therefore get a timestamp a few seconds ahead of the clock. The rule covers one
  `RememberSystem`, because the archive lock lives in that object. Two server processes on
  one archive folder share no lock. The new test file `tests/archive-names.test.ts` fails
  on the old code (0 pass, 4 fail) and passes now. One test forces a failed encode by
  removing `ffmpeg` from the path.

- **A bare database file name no longer makes the server fail with `EEXIST`.** The server
  uses the database path `remember_mcp.db`, and the folder of that path is `.`. Bun on
  Windows throws `EEXIST` for `mkdirSync(".", { recursive: true })`. Bun 1.4.2 and Bun
  1.4.3 both do this, and Bun 1.4.3 also throws `EEXIST` for `..` and `ENOENT` for `./`.
  `ActiveStore` made that call, so the first tool call failed with
  `EEXIST: file already exists, mkdir '.'`. The archive folder, the two folders in
  `archive.ts` and the index folder made the same call. The new `ensureDir` in
  `src/remember/ensure-dir.ts` skips `mkdirSync` for a folder that exists, and all five
  call sites use it. The new test files `tests/bare-paths.test.ts` and
  `tests/ensure-dir.test.ts` fail on the old call sites (7 of 12 fail) and pass now.
  Putting the old call back at any one of the five sites makes at least one test fail. With
  the old call, the CI job on Windows fails and the CI job on Ubuntu passes.

- **TypeScript 7 removed `baseUrl`; the option was dead config here anyway.** `tsc` now errors
  `TS5102: Option 'baseUrl' has been removed`. This tsconfig declared `baseUrl: "."` with **no
  `paths` map**, and every import in `src/` is a package specifier resolving through
  `node_modules`, so nothing depended on it. Deleted rather than replaced with the suggested
  `"paths": {"*": ["./*"]}` shim, which would have re-created a resolution rule the code never used.

- **Regenerated `bun.lock` for the Dependabot bump.** Dependabot's npm ecosystem edits
  `package.json` only and leaves `bun.lock` untouched, so CI failed with
  `error: lockfile had changes, but lockfile is frozen` on both runners. This is structural for
  every Dependabot PR against a Bun repo, not specific to this bump.

### Changed

- **`tests/file-indexing.test.ts` keeps one `setup()` helper.** The describes for
  `line_info`, for a file that is not valid UTF-8, and for a file with no text each defined the
  same helper: a temp root, a `docs` folder as the only allowed root, and a `FileIndexer`. One
  helper now sits at the top of the file. No test changes: 25 tests in the file and 119 in the
  suite pass, with 3,204 `expect()` calls, before and after.

- **Eight of the 13 tools now have a test that calls them through the stdio server.** The
  tools `add_memory`, `query_memory`, `archive_memories`, `recall_memory`, `index_directory`,
  `search_files`, `get_file_info` and `get_file_stats` had no such test. The tests in
  `tests/protocol.test.ts` and `tests/tool-contract.test.ts` list their names and never call
  them. The code that sits between the SDK and the memory system and the file indexer ran
  only in a manual session: the argument defaults, the scope by `user_id`, the optional
  arguments and the error objects. The new file `tests/tool-handlers.test.ts` has 47 tests.
  It starts the server in a new folder and calls `add_memory`, `query_memory`,
  `archive_memories`, `recall_memory`, `get_stats`, `index_file`, `index_directory`,
  `search_files`, `list_indexed_files`, `get_file_info` and `get_file_stats`. It also checks
  that the SDK refuses an unknown tool (code -32602) and an argument that breaks the input
  schema (`isError: true` with a text message), because those errors have a different shape
  from the `{ error, message }` object that a handler returns. The tests assert the fields,
  the counts and the order of the hits that the tools return. They assert no exact salience
  or score: a salience must lie from 0 to 1, and a score must be above 0. The helper
  `openToolSession` in `tests/mcp-stdio.ts` starts the server, finishes the handshake, and
  returns `call` and `request`. It also passes an environment to the server only. No file
  under `src/` changes. 36 mutations were tried one at a time, on `src/tools.ts` and on the
  sort in `src/remember/file-indexer.ts`: a default flipped, a `user_id` dropped, an argument
  ignored, an error label swapped, a filter ignored, a list or a count altered. Each one
  fails at least one test, and the baseline of 47 passes ran before the first mutation. The
  mutation with a flipped default of `include_archive` fails 6 tests, and the mutation that
  drops `user_id` from `archive_memories` fails 9.

- **The changelog has one `## [Unreleased]` heading.** A second block of that name sat between
  the entries for 2.0.0 and 1.3.0. It held two Fixed entries: the removal of `baseUrl` for
  TypeScript 7 and the regenerated `bun.lock` for the Dependabot bump. Both describe changes
  that came after the 2.0.0 commit, so they now stand in the first block. Their text is the
  same as before.

- **Dependabot no longer carries a dead npm entry.** No dependency-update ecosystem
  can read a Bun-managed directory: `bun` rejects `lockfileVersion` 2, which Bun 1.4
  writes, and `npm` aborts with "cannot update bun.lock. Set package-ecosystem: bun".
  Each error recommends the other. The `npm` entry covering `/` therefore failed every
  week from 2026-09-28, and its last successful update was #11 on 2026-09-05. The entry
  is removed and `github-actions` is kept, so action updates continue. The config now
  records both errors, the cost, and a checkable revisit condition. The cost is that
  security alerts still fire, because they come from the dependency graph rather than
  the updater, so "no open Dependabot pull requests" now partly means Dependabot cannot
  open one. Bump a dependency with `bun outdated`, then `bun update <pkg>`, then commit
  the regenerated `bun.lock`.

- **Bun floor raised to 1.4.2**, and a `packageManager` field added. `engines.bun`
  still said `>=1.1.0` while CI already installed 1.4.2, so the declared floor and the
  tested floor had drifted more than three minor versions apart. Both now say 1.4.2.

- **Architecture documents rewritten for the TypeScript implementation.** All ten files in
  `docs/architecture/` still described the removed Python stack, and `repo-tools check`
  failed on every one. `OVERVIEW.md`, `ARCHITECTURE.md`, `COMPONENTS.md`, `DATAFLOW.md` and
  `API.md` are written again from the source, and each ends with a Verification table that the
  check reads. `FILE_INVENTORY.md`, `TEST_COVERAGE.md`, `DEPENDENCY_GRAPH.md`,
  `unused-analysis.md` and `duplicate-symbols.md` are now the output of
  `repo-tools map . --out=docs/architecture`. The README links all ten and states the real
  Bun floor (1.4.2).

- **Doc comments on the 37 exported symbols that had none.** `repo-tools docs check src`
  now passes with 45 of 45 documented and no MUST issue. The change adds comments only.
  Runtime behavior is the same.

## [2.0.0] - 2026-09-05

### Changed — TypeScript on Bun

- Replaced the Python / FastMCP / `openmemory-python` / `memvid` stack with a
  Bun-native TypeScript implementation.
- MCP transport now uses `@modelcontextprotocol/server` + `serveStdio`,
  matching the author's other TypeScript MCP servers. Protocol negotiation
  follows the SDK (`LATEST_PROTOCOL_VERSION`, currently `2025-11-25`).
- Active memory: `bun:sqlite` with hashed embeddings (no model download),
  five cognitive sectors, and exponential salience decay.
- Archive + file index: QR-coded PNG frames packed with `ffmpeg` into MP4,
  plus a JSON sidecar for semantic search (FAISS-free).
- CI installs Bun + ffmpeg on Ubuntu and Windows; Dependabot tracks npm.
- Removed `pyproject.toml`, `uv.lock`, and the Python package layout.

### Removed

- PDF/EPUB indexing (not yet ported; text and code files still work).
- Python SBOM / `uv` lock artifacts.

## 2026-09-03 - fastmcp 4.0.0: the constraint, not the lockfile

- Dependabot bumped `fastmcp` 4.0.0b5 -> 4.0.0 in `pyproject.toml`, and CI failed on both legs
  with `No solution found when resolving dependencies`. The cause was NOT a stale lockfile --
  `uv lock` failed for the same reason. `constraint-dependencies` still pinned
  `fastmcp-slim==4.0.0b5`, while `fastmcp 4.0.0` requires `fastmcp-slim[client,server]==4.0.0`
  exactly, so the two pins were mutually unsatisfiable.
- Moved the constraint to `4.0.0` rather than deleting it: it exists to keep the two aligned,
  and that intent is still correct now the release is final. Corrected the comment, which
  still described FastMCP 4 as prerelease.
- Verified against PyPI before changing anything: `fastmcp-slim 4.0.0` exists and is exactly
  what `fastmcp 4.0.0` declares. `uv lock` then resolves; 36 tests pass locally.

## [1.3.0] - 2026-08-30

### Changed — MCP 2026-07-28 ("MCP 2.0") protocol

- Upgraded to **FastMCP 4.0.0b5** and **MCP Python SDK v2** (`mcp>=2.0`), which
  implement the stateless `2026-07-28` revision: per-request `_meta`,
  `server/discover` capability discovery, and no required `initialize` /
  `Mcp-Session-Id` session lifecycle.
- Legacy `initialize` handshake clients remain supported during the spec grace
  period (pinned by `tests/test_mcp2_protocol.py`).
- `tests/test_handshake_timing.py` now measures `server/discover` instead of
  `initialize`.
- Added `tests/test_mcp2_protocol.py` for MCP 2.0 wire compliance (discover,
  stateless `tools/list`, startup budget).

## [1.2.0] - 2026-08-14

Speed, reliability, security, and maintainability pass. Several of these were
load-bearing bugs that the previous suite could not see.

### Fixed — archive search was a no-op

`MemvidRetriever` takes `video_file` / `index_file`. The archive-query path
passed `video_path` / `index_path`, which raises `TypeError`. The exception was
swallowed per-archive, so hybrid search silently dropped every archived hit.
It also unpacked `search()`'s `List[str]` as `(chunk, score)` tuples — memvid
does not return scores from `search()`. Both are fixed: correct kwargs, and
`search_with_metadata` for real scores. Mutation-covered by
`test_query_reaches_archived_memories` and `tests/test_video.py`.

### Fixed — `age_days=0` and `min_salience=0.0` were ignored

`age_days or self.archive_threshold_days` treats `0` as missing, so an explicit
"archive now" from the MCP tool fell back to the 60-day default. Same for
`min_salience=0.0`. Defaults now apply only when the argument is `None`.

### Fixed — recall of an unknown archive invented a memory

`recall_from_archive` re-added `content` without checking that `archive_file`
was a registered archive. An unknown name (or a path-traversal string) created
a phantom active memory. Recall now resolves against the in-memory index only
and raises `FileNotFoundError` otherwise.

### Fixed — `SystemStats.archive_count` mixed files and memories

`archive_count` counted archive *files*, so `total_memories = active_count +
archive_count` was not conserved when N memories packed into one video. It is
now a memory count (recovered from the memvid JSON sidecar after restart).
`archive_file_count` is the file tally. `get_stats` exposes both.

### Fixed — encoding froze the server and held the write lock

`MemvidEncoder.build_video` ran on the event loop, inside `_write_lock`. Every
`add_memory` blocked for the duration of QR encoding, and memvid's own
`print("FRAMES: ...")` / ffmpeg summaries went to **stdout** — which is
JSON-RPC. Encoding now runs in a worker thread, without the write lock (a
separate `_archive_lock` serializes archival), with stdout redirected, Docker
disabled, and partial `.mp4`/`.json`/`.faiss` files removed on failure.

### Fixed — file-index stdio, glob escape, metadata races

- `FileIndexer` imported memvid with no stdout isolation (same JSON-RPC hazard).
- `Path.glob("../**")` could walk *out* of the requested directory; each file
  is now confined to that directory *and* the allow-list.
- `index_directory(exclude=...)` mutated the caller's list in place.
- Metadata JSON was written non-atomically; a crash left a half file that
  then crashed the next boot. Writes are `tmp` + `os.replace`; corrupt files
  are quarantined.
- Identical content at two paths overwrote the first path's metadata.
- Line-preserving chunk offsets were O(n²).

### Security

- Per-file size cap (32 MiB) and per-directory file cap (500).
- Binary / non-UTF-8 files refused (no more `errors='ignore'` on secrets in
  binaries).
- MCP tools validate empty content, `k`/`top_k` bounds, chunk_size/overlap,
  and unknown scheduler actions; they return `{"error": ...}` rather than
  raising through the protocol.
- `memvid` is pinned to a git **rev** (`1deb9b29…`) instead of `branch = main`,
  so `uv lock` cannot silently pick up a new main.

### Speed / stability

- SQLite WAL + busy_timeout on the openmemory connection.
- `get_stats` is one `COUNT`/`AVG` query instead of two.
- Archive search fans out per-video in worker threads.
- Retriever cache is a bounded LRU (32), not unbounded process-lifetime growth.
- `SELECT id, content` for eligibility, not `SELECT *` (skips embedding blobs).
- `get_file_info` looks up by path before hashing.

### Tests / CI / maintainability

- `tests/test_complete.py` was collected as `test_phase2` with **zero
  assertions** and wrote `test_phase2.db` into the working directory. It is
  now a real scheduler test in `tmp_path`.
- `tests/test_file_indexing.py` collected nothing; `FileIndexer` now has
  allow-list, glob, binary, size, metadata, and round-trip tests.
- CI no longer treats pytest exit 5 ("no tests collected") as success.
- `remember.__version__` was `1.0.0` against `pyproject.toml` `1.1.1`; both
  are `1.2.0` and pinned to each other.
- Dead `schedule` dependency removed (the scheduler is asyncio).
- Shared memvid helpers live in `remember/video.py` so the two call sites
  cannot drift on constructor names or stdout isolation again.

The architecture documents in `docs/architecture/` from the previous
unreleased work are included in this release and updated for the new module
and the closed `archive_count` debt.

### Added — architecture documentation, gated against drift

`docs/architecture/` now carries the ten canonical documents (OVERVIEW, ARCHITECTURE,
COMPONENTS, DATAFLOW, API, FILE_INVENTORY, TEST_COVERAGE, DEPENDENCY_GRAPH,
unused-analysis, duplicate-symbols), and README links them.

Every numeric claim is derived from a parse of the code and re-checked by
`repo_map.py check`, which exits non-zero on a stale value. **Mutation-verified**: editing
`totalLinesOfCode` to a wrong number makes the gate fail and name the drifted claim.

This required teaching the tool Python first — `repo_map` was JavaScript/TypeScript only
and reported this repo as an empty graph, so there was no gate to write against. That work
landed in `danielsimonjr/skills` (a Python resolver, an `ast`-based parser, per-repo
language detection that leaves every existing TS repo untouched, and Python entry-root
detection). Claims the gate cannot hold — the 13 MCP tools, the 29 collected tests — are
written with their actual basis stated rather than given a fake Verification row.

Findings recorded while writing, not discarded:

- `example.py` is the repo's only no-importer file — correct for a demo script, not a
  deletion candidate (confirmed by grep as a second method).
- All 5 "unused" exports are accounted for: two module loggers, one documented constant,
  and two entry points reached by a runtime rather than an import.
- `logger` is the single duplicate symbol (two module-local loggers) — benign.
- `server.py`'s three internal edges each appear twice, because the imports are deliberately
  made both lazily and under `TYPE_CHECKING` to keep heavy imports out of module scope.


## [1.1.1] - 2026-08-13

Two crash/data-visibility bugs in the core memory path, plus the reason neither
was ever caught: **the test suite asserted nothing.**

### Fixed — `add_memory` raised `ValueError` on the second memory

`add_memory` crashed with `ValueError: shapes (384,) and (768,) not aligned` as
soon as two memories classified into different sectors — which is the normal
path, not an edge case.

openmemory maps embedding models **per sector** (`embeddings.py`): `REFLECTIVE`
gets the 768-dimension `all-mpnet-base-v2`, every other sector gets the
384-dimension `all-MiniLM-L6-v2`. But `MemorySystem.add_memory` then calls
`graph.create_similarity_waypoint`, which cosine-compares the incoming memory
against existing ones *regardless of sector*. Mixed dimensions meet, and numpy
raises. Visible in the logs as two different models loading back to back
(`Loading weights: 199/199` then `103/103`).

`RememberSystem` now constructs an explicit `EmbeddingProvider` with every
sector pinned to one model, so the vector space is uniform. Cost: `REFLECTIVE`
memories lose mpnet's slightly stronger embeddings — the right trade against a
space that raises.

### Fixed — archiving without a user_id orphaned the archive

`archive_old_memories` guarded its index update with `if user_id:`. The default
path (`user_id=None`) — which is what the `archive_memories` **MCP tool** uses —
wrote the `.mp4`/`.faiss`/`.json`, **deleted the memories from active storage**,
and recorded nothing. `get_stats` then reported `archive_count=0` and
`total_memories=0`, and query/recall could not reach them: the memories read as
destroyed while 261 KB of their data sat on disk.

Archive *filenames* had always normalized `None` → `"default"`
(`f"user_{user_id or 'default'}_{timestamp}"`), and `_load_archive_index` parsed
that back out — so even a restart recovered the archive under `"default"` while
every lookup asked for `None`. Three sites disagreed about one key. Normalized
into a single `_archive_key()` helper used by the index write and all lookups.

Data was never actually lost — but it was unreachable and reported as gone.

### Fixed — the test suite asserted almost nothing

This is why both bugs shipped. Before: 8 test files, **4 collected tests, 2
assertions in total** (both in `test_handshake_timing.py`, the one genuinely
good file).

- **`tests/test_tools.py` and `tests/test_tools_async.py` — deleted.** Near-identical
  copies of each other; neither contained an `assert`; both wrapped everything in
  `try/except` that swallowed failures; neither was collectable by pytest (their
  bodies sat under `if __name__ == "__main__"`); and both called
  `app.get_tools()`, the **fastmcp 2.x** API, while this project requires
  `fastmcp>=3.2.0` where it is `list_tools()`. Dead *and* broken *and* silent.
- **`tests/test_tool_contract.py` — added.** Pins the full 13-tool MCP surface as a
  set and requires every tool to carry a description. Mutation-verified: removing
  one `@app.tool()` decorator makes it fail and name the missing tool.
- **`tests/test_archival.py` — rewritten.** Had zero assertions and ran against
  `remember_mcp.db` in the repo root (the real 184 KB working database), calling
  `archive_old_memories()` on it — destructive and non-deterministic. Now builds
  its corpus in `tmp_path`. Includes the regression test for the orphaned-archive
  bug, mutation-verified against the restored `if user_id:` guard.
- **`tests/test_recall.py` — rewritten.** Had zero assertions, used the real
  database, and hardcoded `archive_file = "user_default_1762577738"` — an archive
  from one machine at one instant, which exists nowhere else. It now creates its
  own archive and asserts the round trip restores the memory.

**4 collected tests → 10, and they assert.**

### Removed — `requirements.txt`

A second, unmaintained dependency list that omitted **`mcp`, `pydantic`
(including its exact `==2.13.4` pin) and `scipy`**, and tracked `memvid`'s
`main` branch instead of the commit pinned in `uv.lock`. `README.md` told users
to `pip install -r requirements.txt` **twice**, so the documented install
produced an environment that did not match CI. `pyproject.toml` + `uv.lock` are
authoritative (CI runs `uv sync --frozen`); README now documents `uv sync`. This
is the same defect class as the `setup.py` removed in 1.1.0 — a duplicate source
of truth that can only drift.

Also corrected the README's Development section, which named
`python test_complete.py` / `test_file_indexing.py` / `list_tools.py` — paths
that do not exist, since those files live under `tests/`.

### Known issues (recorded, not fixed here)

- `SystemStats.archive_count` counts archive **files**, not archived memories, so
  `total_memories = active_count + archive_count` adds memories to files and is
  not conserved across an archive that packs N memories into one video.
- `tests/test_complete.py` and `tests/test_file_indexing.py` still contain no
  assertions; the latter is not collected by pytest at all.

## [1.1.0] - 2026-08-13

Rolls up every change since `v1.0.3` — a long run of security work that had never been
tagged. Minor rather than patch because `fastmcp` crossed a **major** boundary (2.x -> 3.4.2)
under the entries below, which changes the server's runtime, not just its dependency pins.

### Removed — the vestigial `setup.py`

`setup.py` was dead weight that actively contradicted the real metadata, and had drifted
unnoticed for three releases. Every field disagreed with `pyproject.toml`:

| Field | `setup.py` claimed | `pyproject.toml` (authoritative) |
|---|---|---|
| `version` | `1.0.0` | `1.0.3` — stale by 3 releases |
| `python_requires` | `>=3.8` | `==3.13.*` |
| `mcp` | `>=0.9.0` | `>=1.23.0` |
| `fastmcp` | *absent entirely* | `>=3.2.0` |
| `numpy` | `>=1.24.0` | `>=2.0` |

Its `console_scripts` entry point pointed at `remember.mcp.server:main` — **a module that
does not exist**; the package is flat (`remember/{__init__,file_indexer,scheduler,system,
types}.py`). Nothing references the file. Under PEP 621 the `[project]` table is
authoritative and setuptools ignores the duplicated `setup()` metadata, so this was a second
"source of truth" that could only ever be wrong. Deleted rather than synced: keeping two
version sources is the defect, and syncing them just re-arms it.

> **Note for the next release:** `uv.lock` records the project's **own** version
> (`[[package]] name = "remember-mcp"`). CI runs `uv sync --frozen`, so bumping
> `pyproject.toml` without re-running `uv lock` fails the build. Bump and re-lock together.

### Security — pypdf 6.14.2 -> 6.15.0 (2026-08-13)

Two medium advisories, both the same package. `pypdf` is transitive: it arrives through
`memvid@0.2.0`, which this project consumes as a **git dependency** rather than from PyPI.

`uv lock --upgrade-package pypdf` moved it without touching anything else — verified from
the diff rather than the command's summary line: the change is exactly three lines, the
version and its wheel hashes, and no second package appears. (A local `uv sync` also moved
torch 2.12.1 -> 2.13.0, which is the *virtualenv* catching up to a lock entry that was
already 2.13.0, not part of this change.)

Gate matches CI (`uv sync --frozen`, `uv run pytest -q`): 4 passed.

### Security — cryptography 49.0.0 -> 50.0.0 (2026-08-04)

High-severity alert raised minutes after the setuptools/torch push. Cleared with
`uv lock --upgrade-package cryptography`; `pyproject.toml` unchanged. Same
reasoning as below: CI's `uv sync --frozen` + `pytest` across the OS matrix is
the verification, not a multi-GB local sync.

### Security — setuptools and torch (2026-08-04)

Both open alerts cleared via `uv lock --upgrade-package`; `pyproject.toml`
unchanged.

- `setuptools` 81.0.0 -> 83.0.0 (medium)
- `torch` 2.12.1 -> 2.13.0 (low), pulled in transitively by
  `sentence-transformers` — it is neither declared in `pyproject.toml` nor
  imported anywhere in `src/`

The torch bump also carried `cuda-toolkit` 13.0.2 -> 13.0.3.0 and
`nvidia-cublas` 13.1.0.3 -> 13.1.1.3, which are torch's own pinned CUDA stack.

Verification is deliberately left to CI rather than done locally: syncing this
lock means a multi-GB torch/CUDA download, and CI already runs
`uv sync --frozen` followed by `uv run pytest -q` across the OS matrix on
Python 3.13 — which exercises the resolved lock more thoroughly than a single
local machine would.


### Security

- **11 high-severity Dependabot alerts closed with one targeted lock refresh.** Ten of the
  eleven were the *same package* under different advisories: `pillow < 12.3.0` (→ 12.3.0),
  plus `mcp < 1.28.1` (→ 1.29.0). Upgraded with
  `uv lock --upgrade-package pillow --upgrade-package mcp` rather than a blanket re-lock,
  so the blast radius stays reviewable.
- **Lockfile had drifted from its own manifest.** `pyproject.toml` pins
  `pydantic==2.13.4`, but `uv.lock` was resolving **2.11.7**. The refresh corrected it
  (and `pydantic-core` 2.33.2 → 2.46.4). Worth noting because a lock that disagrees with
  its manifest means *nobody was running the versions the manifest claims*.

### Fixed

- **CI could not have caught a dependency regression — now it can.** The `test` job ran
  `python -m compileall -q .` and nothing else: a **syntax gate**, guarding a repo with
  seven `test_*.py` files. The comment justifying this cited `faiss-cpu==1.7.4` /
  `numpy==1.26.4` having no cp313 wheels and `memvid` being an archived PyPI package
  capped at 0.1.3.
  **All three premises had expired.** `memvid` now resolves to `danielsimonjr/memvid`
  @ v0.2.0 over **git** (not PyPI), which pulls `faiss-cpu 1.13.2` and `numpy 2.4.4` —
  both shipping cp313 wheels. Proven before changing CI: `uv sync` completed on
  3.13.14 and `pytest` ran green. CI now installs with `uv sync --frozen` and runs
  `pytest`, with `compileall` retained as a fast pre-check.
  *The gate was honest when written and quietly went obsolete when the blocker was
  fixed elsewhere — nothing re-checked it.*

### Known gaps

- **Only 4 of the 7 `test_*.py` files contain any tests.** `test_file_indexing.py`,
  `test_tools.py` and `test_tools_async.py` are manual demo scripts (`async def main()`
  + `print()` + `if __name__ == "__main__"`); pytest collects **0** from them. They
  assert nothing and the `test_` prefix is cosmetic. The four real tests now run in CI;
  converting or renaming the other three is tracked separately.

### Added

- **Windows CI leg.** CI ran on `ubuntu-latest` only — but Windows is the *production*
  platform for this MCP server (it runs on the user's Windows box), so CI had never once
  tested the OS the server actually ships on. The `test` job now runs a
  `[ubuntu-latest, windows-latest]` matrix.

### Security
- **Patched transitive dependency vulnerabilities** in `uv.lock`: `cryptography` 47.0.0 → 49.0.0 (HIGH), `starlette` 1.2.1 → 1.3.1 (HIGH), `pydantic-settings` 2.14.0 → 2.14.2, `python-multipart` 0.0.27 → 0.0.32. All are indirect (pulled via the MCP/fastmcp stack). Two advisories have no upstream fix and are left as-is: `PyPDF2` (unmaintained — the maintained successor is `pypdf`) and a low-severity `torch` advisory.

### Fixed
- **Stdout pollution at runtime.** Routed the remaining `print()` calls that run during normal operation to stderr so they cannot corrupt the JSON-RPC stdio framing this server uses: the archival scheduler's status/error lines (`remember/scheduler.py`, via a new `_log` stderr helper), the archive-query error in `remember/system.py`, the memvid-encoding error in `remember/system.py`, and the file-search error in `remember/file_indexer.py` (now `logger.error`). Complements the v1.0.3 import-time stdout fix. (Verified via `py_compile` + a stdout-print sweep; full pytest suite not run locally — `memvid`/`openmemory` runtime deps absent in the dev shell.)

## [1.0.3] - 2026-05-01

### Documentation
- Add CycloneDX SBOM (sbom.json).

### Fixed

- **Stdout pollution at import (`remember/system.py`).** OpenMemory and
  memvid both `print(...)` at import time (e.g. "Warning: Google Generative
  AI library not available"). Stdio MCP servers reserve stdout for
  JSON-RPC framing — any stray byte breaks the protocol. The two
  vendor imports are now wrapped in `contextlib.redirect_stdout(sys.stderr)`
  so library notices land in the conventional log channel without
  corrupting the wire. Verified: `STDOUT_LEAK_LEN: 0` after import on
  the venv that produces the warnings.

### Performance

- **Defer heavy imports for sub-handshake-window MCP startup** (`server.py`).
  `RememberSystem`, `ArchivalScheduler`, and `FileIndexer` were imported at
  module top, transitively pulling in OpenMemory, memvid,
  sentence-transformers, FAISS, and scipy; on top of that, `main()` ran an
  eager `asyncio.run(setup())` that constructed both objects and loaded
  their FAISS indexes from disk before `app.run("stdio")` could process the
  `initialize` JSON-RPC message. Cold-start handshake measured 220.88s on a
  Windows/Dropbox box — Claude Code's MCP startup window is ~30s, so the
  server appeared broken on every fresh launch and Wave 4 round-trip
  testing only succeeded after lifting the harness cap to 150s. Heavy
  imports now live inside `get_system()` / `get_file_indexer()`, the eager
  `setup()` call is removed from `main()`, and concurrent first-use is
  serialized through an `asyncio.Lock`. Cold handshake now ~6-8s
  (floor set by `fastmcp` itself per `python -X importtime`); the heavy
  work runs on the first tool call that needs it (~60-90s, acceptable
  because the client is no longer racing the handshake timeout).
  Regression guard: `tests/test_handshake_timing.py` (10s budget).
  Tools that don't touch heavy state (`scheduler_status`,
  `scheduler_control`) continue to return without forcing init.

## [1.0.2] - 2026-04-30

### Fixed

- **SQLite concurrency race in archive flow** (`remember/system.py`).
  `archive_old_memories` previously ran SELECT, the (slow) memvid encode,
  and DELETE/COMMIT across separate `asyncio.to_thread` calls on the
  shared SQLite connection, allowing concurrent `add_memory` to interleave
  and corrupt state. The DELETE + COMMIT now run inside a `with conn:`
  transaction block, and an `asyncio.Lock` on the system instance
  serializes archive/add paths.
- **MemvidRetriever per-query reinstantiation leak**
  (`remember/system.py`, `remember/file_indexer.py`). Retrievers were
  constructed fresh inside every search loop, reloading the FAISS index
  and reopening the mp4 reader on every call (file-handle leak + slow).
  Retrievers are now cached keyed by `(video_path, index_path)` on the
  system / indexer instance. Both classes expose a `close()` that drops
  the pool; `server.main()` now calls them in a `finally:` block on exit.
- **Bare `except: pass` in `RememberSystem.get_stats`**. Two stat-size
  loops swallowed every exception — including programming bugs and
  permission errors — making corrupted archive index entries impossible
  to debug. Now catches `OSError` specifically and logs via
  `logger.warning`.
