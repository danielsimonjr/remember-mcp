# Unused Analysis

Derived from `repo_map.py map`'s `unused-analysis.json`.

## Files with no importer: 1

| File | Verdict |
|---|---|
| `example.py` | **Expected.** A standalone demo, run directly, never imported. |

`example.py` imports `remember/__init__.py`, so it is a consumer, not dead weight. A file
with zero in-repo importers is normal for a script invoked directly — this list is a
question, not a deletion queue.

**Verified with a second method** rather than taken from the tool alone:
`git grep -n "example" -- '*.py'` returns no import of it from any module.

## Unused exports: 5

`repo_map` reports 5 exports referenced only inside their defining module. All five are
accounted for:

| Export | Module | Why it is not dead |
|---|---|---|
| `logger` | `remember/system.py` | Module logger, used throughout its own file |
| `logger` | `remember/file_indexer.py` | Same |
| `UNIFORM_EMBEDDING_MODEL` | `remember/system.py` | Consumed by `_uniform_embedding_provider()` in-module; exported so the pinning decision is inspectable and documentable |
| `setup` | `server.py` | Called by `fastmcp` as a lifecycle hook, not by an import |
| `main` | `example.py` | Script entry point under `__main__` |

**None is a deletion candidate.** Two are loggers, one is a documented constant, and two
are entry points reached by a runtime rather than by an import statement — the exact
caveat `unused-analysis.json` itself carries:

> *"`noImporterFiles` is NOT a deletion-candidate list. A file with zero in-repo importers
> is expected … for a standalone script invoked directly."*

## What this analysis cannot see

Static import parsing only. Anything reached dynamically is invisible:

- `fastmcp` discovers tools through the `@app.tool()` **decorator**, not through imports.
  Every one of the 13 tool functions therefore looks unreferenced to a pure import graph.
  `tests/test_tool_contract.py` exists precisely because this blind spot means the graph
  cannot tell you a tool is still registered.
- `openmemory` and `memvid` load models and indexes by path at runtime.

So: a name absent from this report is not proven live, and a name present is not proven
dead. Both directions need a second method.

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| noImporterFileCount | 1 | unused-analysis.json |
| unusedExportsCount | 5 | dependency-graph.json |
| orphanedFiles | 1 | dependency-graph.json |
