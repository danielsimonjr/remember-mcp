<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Test Coverage Analysis

## Summary

| Metric | Count |
|--------|-------|
| Total Source Files | 14 |
| Total Test Files | 7 |
| Source Files with Tests | 8 |
| Source Files without Tests | 6 |
| Coverage (raw, direct-import) | **57.1%** |
---

## Source Files Without Test Coverage

The following 6 source files are not directly imported by any test file:

### root/

- `src/example.ts` → Expected test: `tests/unit/root/example.test.ts`
- `src/index.ts` → Expected test: `tests/unit/root/index.test.ts`
- `src/server.ts` → Expected test: `tests/unit/root/server.test.ts`

### remember/

- `src/remember/active-store.ts` → Expected test: `tests/unit/remember/active-store.test.ts`
- `src/remember/embeddings.ts` → Expected test: `tests/unit/remember/embeddings.test.ts`
- `src/remember/sectors.ts` → Expected test: `tests/unit/remember/sectors.test.ts`

---

## Source Files With Test Coverage

| Source File | Test Files |
|-------------|------------|
| `remember/archive.ts` | `video.test.ts` |
| `remember/file-indexer.ts` | `file-indexing.test.ts`, `version.test.ts` |
| `remember/index.ts` | `version.test.ts` |
| `remember/scheduler.ts` | `version.test.ts` |
| `remember/system.ts` | `archival.test.ts`, `recall.test.ts`, `version.test.ts`, `video.test.ts` |
| `remember/types.ts` | `version.test.ts` |
| `src/tools.ts` | `tool-contract.test.ts` |
| `src/version.ts` | `version.test.ts` |

---

## Test File Details

| Test File | Imports from Source |
|-----------|---------------------|
| `tests/archival.test.ts` | 1 files |
| `tests/file-indexing.test.ts` | 1 files |
| `tests/protocol.test.ts` | 0 files |
| `tests/recall.test.ts` | 1 files |
| `tests/tool-contract.test.ts` | 1 files |
| `tests/version.test.ts` | 6 files |
| `tests/video.test.ts` | 2 files |
