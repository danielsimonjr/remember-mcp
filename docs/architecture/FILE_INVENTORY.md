<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Complete File Inventory

This report lists each source file that the map census finds, with a disposition. The census reads the files that git tracks. Outside a git work tree, it walks the folder. The census skips tool state, dependency folders and build output (for example `.git/`, `node_modules/`, `dist/` and `target/`), and `obj/` and `bin/` for C#.

**Language**: typescript

**Total files**: 28

## Disposition counts

| Disposition | Count | Meaning |
| --- | --: | --- |
| `reachable` | 11 | A `src`-area file that an entry root reaches. |
| `build-entry` | 3 | A `src`-area file that is an entry root. |
| `test-only` | 0 | A `src`-area file that only a test reaches. |
| `orphan` | 1 | A `src`-area file that nothing reaches. Delete it, or wire it to a root. |
| `test` | 13 | A file in a `tests/` folder, or a `*.test.ts` or `*.spec.ts` file. |
| `tool` | 0 | A file in a `tools/` or `scripts/` folder outside `src/`. |
| `config` | 0 | A `*.config.*` file of TypeScript or JavaScript. |
| `example` | 0 | A file in `examples/` or `docs/`. |
| `bench` | 0 | A file in `bench/` or `benchmarks/`, or a `*.bench.*` file. |
| **Total** | **28** | |

## Per-area counts

| Area | Files |
| --- | --: |
| `src` | 15 |
| `tests` | 13 |

## Per-package counts

| Package | Files |
| --- | --: |
| `(root)` | 13 |
| `remember-mcp` | 15 |

## All files

| File | Package | Area | Disposition | Lines |
| --- | --- | --- | --- | --: |
| `src/example.ts` | remember-mcp | src | orphan | 97 |
| `src/index.ts` | remember-mcp | src | build-entry | 38 |
| `src/remember/active-store.ts` | remember-mcp | src | reachable | 301 |
| `src/remember/archive.ts` | remember-mcp | src | reachable | 233 |
| `src/remember/embeddings.ts` | remember-mcp | src | reachable | 82 |
| `src/remember/ensure-dir.ts` | remember-mcp | src | reachable | 29 |
| `src/remember/file-indexer.ts` | remember-mcp | src | reachable | 637 |
| `src/remember/index.ts` | remember-mcp | src | build-entry | 11 |
| `src/remember/scheduler.ts` | remember-mcp | src | reachable | 106 |
| `src/remember/sectors.ts` | remember-mcp | src | reachable | 104 |
| `src/remember/system.ts` | remember-mcp | src | reachable | 479 |
| `src/remember/types.ts` | remember-mcp | src | reachable | 76 |
| `src/server.ts` | remember-mcp | src | build-entry | 59 |
| `src/tools.ts` | remember-mcp | src | reachable | 542 |
| `src/version.ts` | remember-mcp | src | reachable | 5 |
| `tests/archival.test.ts` | (root) | tests | test | 95 |
| `tests/archive-names.test.ts` | (root) | tests | test | 149 |
| `tests/bare-paths.test.ts` | (root) | tests | test | 155 |
| `tests/ensure-dir.test.ts` | (root) | tests | test | 51 |
| `tests/file-indexing.test.ts` | (root) | tests | test | 429 |
| `tests/mcp-stdio.ts` | (root) | tests | test | 141 |
| `tests/protocol.test.ts` | (root) | tests | test | 104 |
| `tests/recall.test.ts` | (root) | tests | test | 85 |
| `tests/scheduler.test.ts` | (root) | tests | test | 181 |
| `tests/tool-contract.test.ts` | (root) | tests | test | 32 |
| `tests/tool-handlers.test.ts` | (root) | tests | test | 590 |
| `tests/version.test.ts` | (root) | tests | test | 11 |
| `tests/video.test.ts` | (root) | tests | test | 182 |

## Skipped links

Links (symbolic links and junctions) that the census did not follow. A link can point to another repository, so no file behind a link is in this inventory or in the graph.

_None._

## Warnings

_None._
