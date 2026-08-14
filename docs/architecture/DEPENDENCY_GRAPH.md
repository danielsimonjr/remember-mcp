# Dependency Graph

Derived from `repo_map.py map`'s `dependency-graph.json`. First-party edges only —
`external`/stdlib are listed separately per module.

## Shape

```
server.py  (entry root)
   ├─► remember/system.py ──► remember/types.py        (leaf)
   ├─► remember/scheduler.py                           (leaf)
   └─► remember/file_indexer.py                        (leaf)

remember/__init__.py ──► remember/system.py            (re-export)
example.py ──► remember/__init__.py                    (orphan: nothing imports example.py)
```

**0 runtime circular dependencies.** The graph is a shallow tree: one root, one two-level
chain (`server → system → types`), and three leaves.

## Per module

| Module | First-party imports | External |
|---|---|---|
| `server.py` | `remember/system.py`, `remember/scheduler.py`, `remember/file_indexer.py` | `fastmcp` |
| `remember/system.py` | `remember/types.py` | `openmemory`, `openmemory.embeddings`, `openmemory.types`, `memvid` |
| `remember/file_indexer.py` | — | `memvid` |
| `remember/scheduler.py` | — | — |
| `remember/types.py` | — | — |
| `remember/__init__.py` | `remember/system.py` | — |
| `example.py` | `remember/__init__.py` | — |

### Tests

| Module | First-party imports |
|---|---|
| `tests/test_archival.py` | `remember/system.py` |
| `tests/test_recall.py` | `remember/system.py` |
| `tests/test_tool_contract.py` | `server.py` |
| `tests/test_complete.py` | `remember/__init__.py`, `remember/scheduler.py` |
| `tests/test_file_indexing.py` | `remember/file_indexer.py` |
| `tests/list_tools.py` | `server.py` |
| `tests/test_handshake_timing.py` | — (spawns the server as a subprocess) |

`test_handshake_timing.py` importing nothing first-party is the point: it exercises the
real process boundary rather than the module graph.

## Reading notes

- **`server.py` imports each of its three dependencies twice.** Once lazily inside
  `get_system()`/`get_file_indexer()` and once under `TYPE_CHECKING` for annotations. The
  graph records import *statements*, so the edge appears twice. That duplication is
  deliberate in the source — it is what keeps the heavy imports out of module scope while
  preserving type hints.
- **`remember/scheduler.py` has no first-party imports** because it is handed a
  `RememberSystem` rather than importing one. That is what makes it independently testable.
- **`remember/types.py` is a true leaf** — it can never participate in a cycle.

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| runtimeCircularDeps | 0 | dependency-graph.json |
| typeOnlyCircularDeps | 0 | dependency-graph.json |
| totalTypeScriptFiles | 15 | dependency-graph.json |
| entryRoots | 1 | dependency-graph.json |
