<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Duplicate Symbols

Names that are OWN-DEFINED (not merely re-exported) by >= 2 distinct files across the monorepo, then CLASSIFIED (see `DupEntryTag`) so the actionable subset is clear: `TRUE_DUPLICATE` (real merge targets) vs `DISPATCH_VARIANT` (>=2 `mathTyped(...)` registrations of the same public name — distinct dispatch surfaces, Bucket C delegation candidates, not copy-paste bodies), `ALIAS_DELEGATION` (a `const X = importedY` forward, excluded once <2 real bodies remain), and `ALLOWLISTED` (matches `duplicate-allowlist.json`: hot-path `is*` guards, AssemblyScript mirrors, per-package `VERSION` strings).

> **Note:** This report groups names by OWN definition, not by call graph, then classifies each flagged name (see DupEntryTag): TRUE_DUPLICATE (the actionable merge targets), DISPATCH_VARIANT (>=2 mathTyped(...) registrations of the same public name — distinct dispatch surfaces, Bucket C delegation candidates, not copy-paste bodies), ALIAS_DELEGATION (a const-alias forward to an imported symbol, not an independent body — excluded once fewer than 2 real bodies remain), and ALLOWLISTED (matches duplicate-allowlist.json: hot-path is* guards, AssemblyScript mirrors, per-package VERSION strings). NOT detected: same-file typed-dispatch overload polymorphism for different argument shapes within one registration — a human still triages TRUE_DUPLICATE entries using the defining files + public flags before merging anything.

## Summary — runtime (function/constant/class)

| Category | Count |
| --- | --: |
| **TRUE_DUPLICATE** (actionable) | 0 |
| DISPATCH_VARIANT | 0 |
| ALIAS_DELEGATION | 0 |
| ALLOWLISTED | 0 |
| _Total flagged names_ | 0 |

## Summary — types (interface/type/enum)

| Category | Count |
| --- | --: |
| **TRUE_DUPLICATE** (actionable) | 0 |
| DISPATCH_VARIANT | 0 |
| ALIAS_DELEGATION | 0 |
| ALLOWLISTED | 0 |
| _Total flagged names_ | 0 |

## Runtime duplicates

### TRUE_DUPLICATE — actionable merge targets

_None._

### DISPATCH_VARIANT — distinct public typed-dispatch surfaces (Bucket C candidates)

_None._

### ALIAS_DELEGATION — const-alias forwards (not independent bodies)

_None._

### ALLOWLISTED — accepted layering (see duplicate-allowlist.json)

_None._

## Type duplicates (lower priority)

### TRUE_DUPLICATE

_None._

### DISPATCH_VARIANT

_None._

### ALIAS_DELEGATION

_None._

### ALLOWLISTED

_None._
