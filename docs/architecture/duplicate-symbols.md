# Duplicate Symbols

Names exported by two or more `src` files. Derived from `repo_map.py map`'s
`duplicate-symbols.json`, which groups **by name only** — it does not compare bodies, so
every entry is a candidate for triage, not a verdict.

**1 duplicate across 12 tracked symbols.**

## `logger` — benign

| Defined in |
|---|
| `remember/system.py` |
| `remember/file_indexer.py` |

Both are `logging.getLogger(__name__)`, so they are *different* loggers that happen to
share a local variable name — `remember.system` and `remember.file_indexer` respectively.
This is the standard Python idiom, not a collision: nothing imports `logger` across module
boundaries, and renaming either would make the code less conventional, not more correct.

**No action.**

## A name the report does not flag, and why

`RememberSystem` appears in the export list of **both** `remember/system.py` (where it is
defined) and `remember/__init__.py` (which re-exports it). That is a deliberate re-export
so `from remember import RememberSystem` works, and it is the single name in
`__init__.py`.

It does not appear above because the analysis groups own-exported names from `src` files
and treats the re-export correctly rather than as a second definition — worth stating
explicitly, since a reader scanning for duplicates would reasonably expect to see it here.

## Verification

Generated 2026-08-14 by `repo_map.py map`.
Regenerate: `python repo_map.py map <repo> --out <dir>` · Check: `python repo_map.py check <repo> --docs docs/architecture`

| Claim | Value | Source |
|---|---|---|
| totalTypeScriptFiles | 15 | dependency-graph.json |
| totalExports | 31 | dependency-graph.json |
