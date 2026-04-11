# Python Foundation — Design Specification

> **spec_id:** 2026-04-11-python-foundation-2014
> **topic:** Python Foundation (import graph + extractor enhancements)
> **status:** Approved
> **created_at:** 2026-04-10T20:14:15Z
> **approved_at:** 2026-04-10T20:14:15Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift is a 72-tool MCP server used by AI coding agents for code intelligence. Its Python support is graded C-: the extractor handles only basic functions/classes/methods, and the import graph has **zero** Python support (JS/TS regex patterns only). As a direct consequence, `find_references`, `get_knowledge_map`, `detect_communities`, `impact_analysis`, and `trace_call_chain` return empty or misleading results on Python codebases.

This blocks CodeSift from being useful on the ~40% of MCP users working on Python projects. It also blocks Phase 2 of the Python Support roadmap (framework-aware intelligence — Django/Flask/FastAPI route tracing, anti-patterns, model relationships), which all depend on a working Python import graph.

Who is affected: every AI agent working on a Python codebase via CodeSift. What happens if we do nothing: Python users get degraded results with no error message (silent failure is the worst kind), and competing MCP servers (CodePathfinder, Serena) capture the Python segment.

## Design Decisions

### D1. Data model: typed fields + generic meta overflow
**Decision:** Extend `CodeSymbol` with four optional fields: `decorators?: string[]`, `extends?: string[]`, `is_async?: boolean`, `meta?: Record<string, unknown>`.

**Rationale:** Typed fields make common Python metadata queryable and reusable by other extractors (Kotlin/TS already collect annotations but drop them). The generic `meta` field absorbs Python-specific tags (`is_dunder`, `dataclass_frozen`, `all_computed`, `parse_errors`, `star_import`, `type_only`) without polluting the type union. All four fields are optional — old indexes load unchanged.

**Alternatives rejected:**
- Encoding in `signature` string (opaque, not queryable)
- New `SymbolKind` values per Python construct (explosion of kinds, no room for combinations)

### D2. Import parsing method: tree-sitter AST (no regex)
**Decision:** Python import edges are extracted from the tree-sitter AST via `import_statement` and `import_from_statement` node traversal. Not regex.

**Rationale:** Regex-based parsing produces false positives from string literals (`"""import os"""`) and comments (`# from X import Y`). Since the tree-sitter Python grammar is already parsing the file for symbol extraction, AST-based import detection is both accurate and cheap. The parse is cached via the existing parser-manager infrastructure.

**Alternatives rejected:** Extend `IMPORT_PATTERNS` regex array in `import-graph.ts` (false positives, inconsistent with accuracy goals).

### D3. Import resolution: absolute + relative against index tree
**Decision:** Track both absolute (`from myapp.models import X`) and relative (`from . import Y`) imports. Resolve absolute imports by checking the first segment against top-level index directories, with automatic `src/` layout detection.

**Rationale:** Most real Python codebases use absolute imports even within the same package. Only tracking relative imports (like the current JS filter) would leave the graph mostly empty. Auto-detecting `src/` layout removes configuration burden.

**Algorithm:**
1. Parse the import via tree-sitter → extract dotted path or relative path + level
2. For relative imports: count leading dots, walk up from the file's package root (nearest ancestor without an `__init__.py`), append the remaining dotted path
3. For absolute imports: try each search path root (`repoRoot`, `repoRoot/src`) and try `.py` then `/__init__.py` then namespace package (bare directory)
4. Silently drop imports that don't resolve to an indexed file (stdlib, third-party packages)

**Alternatives rejected:**
- Relative-only tracking (too narrow — 90% of Python imports are absolute)
- Configurable search paths (deferred — auto-detect handles 95% of cases)

### D4. Parse-path architecture: isolated Python import module
**Decision:** Create `src/utils/python-imports.ts` that does its own tree-sitter parse. `collectImportEdges` dispatches by file extension. `extractPythonSymbols` signature is unchanged.

**Rationale:** Avoids a breaking change to `extractSymbols` return shape that would ripple through 7 extractors, `src/storage/*`, and all call sites. The 2x parse cost per Python file (symbols + imports) is acceptable (~1-5ms per file on tree-sitter). If profiling shows real cost, a parse cache is a follow-up backlog item.

**Alternatives rejected:** Modify `extractSymbols` to return `{symbols, imports}` (breaking change, out of scope for Foundation phase).

### D5. Scope: Level C (kitchen sink)
**Decision:** All 17 items from PY-1 through PY-17 ship in Phase 1. The only item deferred is grammar version verification (PY-20) which is a one-time investigation, not a shipping feature.

**Rationale:** User explicitly chose Level C. Deferring edge cases (`TYPE_CHECKING`, fallback imports, dataclass fields, dunder tagging, star imports) creates a second Phase 1.5 that would land before any Phase 2 work anyway — better to bundle them.

## Solution Overview

Three parallel tracks, each with an isolated module boundary:

**Track A — Python import graph (unblocks downstream tools)**
- `src/utils/python-imports.ts` — tree-sitter AST-based import extraction
- `src/utils/python-import-resolver.ts` — package root detection, relative import resolution, absolute import resolution against index
- `src/utils/import-graph.ts` — add language dispatch in `collectImportEdges`, extend `buildNormalizedPathMap` for `.py` + `__init__.py`

**Track B — Extractor enhancements (improves symbol quality)**
- `src/parser/extractors/python.ts` — handle `async_function_definition`, `@property`/`@classmethod`/`@staticmethod`/`@abstractmethod`/`@dataclass`, module constants, `__all__`, superclasses, dunder tagging, property setters/deleters, dataclass fields, recursion depth guard
- `src/parser/extractors/_shared.ts` — extend `makeSymbol` opts for new fields
- `src/types.ts` — add optional fields to `CodeSymbol`

**Track C — Tests (prove it works)**
- `tests/parser/python-extractor.test.ts` — new, ~25-30 test cases
- `tests/utils/python-imports.test.ts` — new, ~15 test cases
- `tests/utils/python-import-resolver.test.ts` — new, ~10 test cases

### Data Flow

```
.py file
   │
   ├─▶ parser-manager.ts ──▶ tree-sitter parse tree
   │          │
   │          ├─▶ extractPythonSymbols(tree, ...) ──▶ CodeSymbol[]
   │          │      with decorators, extends, is_async, meta
   │          │
   │          └─▶ extractPythonImports(tree, filePath, index)
   │                    │
   │                    └─▶ resolvePythonImport(rawPath, file, index)
   │                              │
   │                              └─▶ ImportEdge[]
   │
   └─▶ collectImportEdges (per-language dispatch)
           │
           └─▶ adjacency map ──▶ find_references, detect_communities,
                                  get_knowledge_map, impact_analysis
```

## Detailed Design

### Data Model

**`src/types.ts` additions to `CodeSymbol`:**

```typescript
export interface CodeSymbol extends FileLocation {
  // ... existing fields unchanged ...
  decorators?: string[];        // ["@pytest.fixture", "@classmethod"]
  extends?: string[];           // ["BaseModel", "Mixin"]
  is_async?: boolean;           // async def foo()
  meta?: Record<string, unknown>; // { is_dunder: true, dataclass_frozen: true, ... }
}
```

**New edge metadata** (on `ImportEdge` in `src/utils/import-graph.ts`):

```typescript
export interface ImportEdge {
  from: string;
  to: string;
  type_only?: boolean;    // if TYPE_CHECKING: from X import Y
  star_import?: boolean;  // from X import *
  raw?: string;           // original import text for debugging
}
```

### API Surface

**New functions:**

```typescript
// src/utils/python-imports.ts
export function extractPythonImports(
  tree: Parser.Tree,
  filePath: string,
  source: string,
): Array<{ module: string; level: number; is_type_only: boolean; is_star: boolean }>;

// src/utils/python-import-resolver.ts
export function resolvePythonImport(
  rawImport: { module: string; level: number },
  importerFile: string,
  indexedFiles: string[],
): string | null; // resolved file path or null

export function findPackageRoot(
  filePath: string,
  indexedFiles: Set<string>,
): string;

export function detectSrcLayout(
  indexedFiles: string[],
): string | null; // "src" or null
```

**Modified functions:**

```typescript
// src/utils/import-graph.ts
export async function collectImportEdges(
  index: CodeIndex,
  fileFilter?: Set<string>,
): Promise<ImportEdge[]>;
// Dispatches by file extension; .py uses python-imports, others use regex
```

**Extended helper:**

```typescript
// src/parser/extractors/_shared.ts
export function makeSymbol(
  node: Parser.SyntaxNode,
  name: string,
  kind: SymbolKind,
  filePath: string,
  source: string,
  repo: string,
  opts?: {
    parentId?: string;
    docstring?: string;
    signature?: string;
    decorators?: string[];
    extends?: string[];
    is_async?: boolean;
    meta?: Record<string, unknown>;
  },
): CodeSymbol;
```

### Integration Points

| Module | Change |
|--------|--------|
| `src/types.ts` | +4 optional fields on `CodeSymbol`; +3 optional fields on `ImportEdge` |
| `src/parser/extractors/_shared.ts` | Extend `makeSymbol` opts to accept new fields |
| `src/parser/extractors/python.ts` | All extractor enhancements land here (Level C) |
| `src/utils/python-imports.ts` | NEW — tree-sitter AST-based import extraction |
| `src/utils/python-import-resolver.ts` | NEW — package root detection, path resolution |
| `src/utils/import-graph.ts` | Add dispatch-by-extension in `collectImportEdges`; extend `buildNormalizedPathMap` for `.py` + `__init__.py` |
| `src/parser/parser-manager.ts` | No change — Python grammar already loaded |
| `src/parser/symbol-extractor.ts` | No change — routing already works |

Downstream tools that benefit automatically (zero code change):
- `src/tools/graph-tools.ts` → `find_references`, `trace_call_chain`
- `src/tools/community-tools.ts` → `detect_communities`, `get_knowledge_map`
- `src/tools/impact-tools.ts` → `impact_analysis`
- `src/tools/boundary-tools.ts` → `check_boundaries`

### Edge Cases

| # | Edge case | Handling |
|---|-----------|----------|
| E1 | `import os` (stdlib) | Drop silently — not in index |
| E2 | `import numpy` (third-party) | Drop silently — not in index |
| E3 | `from myapp.models import User` (first-party absolute) | Resolve against index top-level or `src/myapp/` |
| E4 | `from . import utils` (relative, 1 dot) | Walk to file's package root, look for `utils.py` or `utils/__init__.py` |
| E5 | `from ..pkg import X` (relative, 2 dots) | Walk 2 levels up, resolve |
| E6 | `from ...... import X` (going above repo root) | Drop with debug log |
| E7 | `from X import *` (star import) | Emit edge with `star_import: true` |
| E8 | `import a, b, c` (multi-import) | Emit one edge per target |
| E9 | `if TYPE_CHECKING: from X import Y` | Emit edge with `type_only: true` |
| E10 | `try: import X; except: import Y` | Emit both edges |
| E11 | `importlib.import_module("X")` | Skip (dynamic, unresolvable) |
| E12 | `import os.path` (dotted module) | Drop silently (stdlib) |
| E13 | String literal `"""import os"""` | Impossible — AST excludes strings |
| E14 | `__all__ = [...]` (list literal) | Extract as `kind: "constant"`, `meta.all_members: [...]` |
| E15 | `__all__ = ("X", "Y")` (tuple) | Same handling as list |
| E16 | `__all__ = BASE + ["X"]` (dynamic) | Emit symbol, set `meta.all_computed: true`, extract literals only |
| E17 | `@dataclass(frozen=True)` | Class with `meta.dataclass_frozen: true`; still emit fields |
| E18 | `@dataclass` + nested class | Handled by existing recursive walk |
| E19 | `@property` getter | `decorators: ["@property"]`, `kind: "method"` |
| E20 | `@x.setter`, `@x.deleter` | `meta.property_accessor: "setter"` or `"deleter"`, `decorators` populated |
| E21 | `@abstractmethod` | `decorators: ["@abstractmethod"]`, `meta.is_abstract: true` |
| E22 | `__init__`, `__str__`, etc. | `meta.is_dunder: true` |
| E23 | `async def __aenter__` | `is_async: true` + `meta.is_dunder: true` |
| E24 | Module constant `API_URL = "..."` | `kind: "constant"` |
| E25 | Module assignment `logger = getLogger()` | Skip (not SCREAMING_CASE) |
| E26 | Dataclass field `x: int = 5` | `kind: "field"`, parent = class |
| E27 | Malformed Python (syntax errors) | `tree.rootNode.hasError` check → extract best-effort, mark file `meta.parse_errors: true` |
| E28 | Very deeply nested functions (200+) | Iterative walk with depth cap 200; truncate beyond; log warning |
| E29 | Nested classes inside functions | Walk function bodies too (fix existing limitation) |
| E30 | Multiple decorators on one function | Collect all into `decorators` array; classify by first match |

### Failure Modes

#### Python tree-sitter grammar

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Grammar uses `async_function_definition` as separate node | Node type check in walk | async functions missing from index | Search for `async def foo` returns nothing | Belt-and-suspenders: handle both node types in walk | Complete (both paths covered) | Immediate |
| Grammar produces `ERROR` nodes (malformed Python) | `tree.rootNode.hasError === true` | Symbols after error node may be missing | Partial index for that file | Extract best-effort; flag file `meta.parse_errors: true` | Partial — documented | Immediate |
| Grammar binary not loaded | `getParser("python")` returns null | No Python files indexed | Repo indexed but 0 Python symbols | Check parser-manager init logs | None — file skipped | Immediate on index |

**Cost-benefit:** Frequency: rare (<1%) × Severity: medium (silent data loss) → Mitigation cost: trivial → **Decision: Mitigate all three.**

#### Python import resolver

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Relative import goes above repo root | Dot count exceeds ancestor count | That one edge dropped | Missing from `find_references` for that import | Skip with debug log | One edge missing | Immediate |
| `src/` layout not auto-detected | First-segment check fails | Absolute imports unresolved | Sparse graph for src-layout repos | Users can set `CODESIFT_PYTHON_SRC_PATH` env var | Many edges missing | On first index |
| `__init__.py` re-exports (`from pkg import X`) | Normal | Edge goes to `__init__.py`, not the real source | Symbol found one hop removed | Acceptable — graph correctly reflects the import chain | Complete | N/A |
| Namespace package (no `__init__.py`) | Directory exists but no `__init__.py` | Edge still resolves via bare dir fallback | None | Try `.py` → `/__init__.py` → `/` (namespace) | Complete | N/A |

**Cost-benefit:** Frequency: occasional (5-10% of repos) × Severity: medium (degraded results) × Mitigation cost: trivial → **Decision: Mitigate auto-detection of src-layout; document manual override.**

#### Extractor walk recursion

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| 10K-line file with 1000+ nested defs | Depth counter exceeds 200 | Symbols beyond depth 200 dropped | Very deep nested functions missing from that one file | Convert walk to iterative with explicit stack; log truncation | Partial — documented | Immediate |
| Stack overflow on pathologically deep file | Uncaught RangeError | Entire file extraction fails | File shows 0 symbols | Iterative walk prevents this | None | Immediate |

**Cost-benefit:** Frequency: rare (<0.1%) × Severity: medium (one file misses symbols) × Mitigation cost: moderate → **Decision: Mitigate via iterative walk.**

#### `collectImportEdges` dispatch

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Python file with no imports | Empty result from extractor | That file has no outgoing edges | Correct — no symptom | None needed | Complete | N/A |
| Python file larger than 500KB | Read + parse succeeds slowly | Indexing is slow | User waits longer | No guard needed — tree-sitter handles it | Complete | Slow |
| `CODESIFT_DISABLE_PYTHON_IMPORTS=1` set | env var check | Python imports skipped, empty graph for Python | Kill switch intentionally used | None — intentional rollback | Empty (documented) | Immediate |

**Cost-benefit:** All handled, trivial cost. **Decision: Mitigate.**

## Acceptance Criteria

### Ship criteria (must pass for release)

**Must have (core correctness):**
1. `extractPythonImports` correctly extracts edges for all 8 import syntax forms (E1-E12)
2. `resolvePythonImport` correctly resolves relative imports (1, 2, 3+ dots) and absolute imports against the indexed file tree
3. `buildNormalizedPathMap` maps `foo/__init__.py` → `foo`
4. `extractPythonSymbols` handles `async_function_definition` node type (belt-and-suspenders with `async` child check)
5. Decorator classification: `@property`, `@classmethod`, `@staticmethod`, `@abstractmethod`, `@dataclass` are detected and surfaced via `decorators` array + `meta` tags
6. `__all__` is extracted as a `constant` with `meta.all_members`
7. Module-level SCREAMING_CASE assignments extracted as `kind: "constant"`
8. Superclasses extracted into `extends` field on class symbols
9. Dunder methods tagged with `meta.is_dunder: true`
10. `@dataclass` classes emit fields as `kind: "field"` symbols with parent class
11. Property setters/deleters tagged via `meta.property_accessor`
12. All new test cases in `tests/parser/python-extractor.test.ts`, `tests/utils/python-imports.test.ts`, `tests/utils/python-import-resolver.test.ts` pass
13. **No regression** in existing test files — all 944+ existing tests still pass

**Should have (quality):**
14. Malformed Python files do not crash — `tree.rootNode.hasError` handled gracefully
15. Walk is iterative (not recursive) with depth cap 200
16. `if TYPE_CHECKING:` imports emit edges with `type_only: true`
17. `try/except ImportError` fallback imports emit both edges
18. `from X import *` emits edges with `star_import: true`

**Edge case handling:**
19. `src/` layout auto-detected when `src/<package>/` structure exists
20. Rollback kill switch: `CODESIFT_DISABLE_PYTHON_IMPORTS=1` skips Python import extraction
21. New `CodeSymbol` fields are all optional — old indexes load without schema migration

### Success criteria (must pass for value validation)

**Quality:**
1. **Import graph edge recall ≥ 80%** on a representative Python project, measured by comparing the number of emitted edges against a ground truth (manually annotated set of 50 imports from a real Django or Flask project)
2. **Symbol coverage ≥ 90%** on a representative Python file — for 5 sampled files from a real Python project, at least 90% of what a human would identify as "important" symbols appear in the extracted output
3. **Zero false-positive imports** from string literals or comments (verified by a test file containing `"""import os"""` and `# from . import x`)

**Efficiency:**
4. **Indexing performance parity**: `collectImportEdges` on a 500-file Python project completes in under 2 seconds (measured with `time` on a local clone of `pallets/flask`)
5. **Memory stability**: extractor walk on a 10K-line file completes without stack overflow

**Validation methodology:**
6. Success is measured by a benchmark script `scripts/bench-python-foundation.ts` that:
   - Indexes `pallets/flask` (or similar) fresh
   - Runs `find_references` on 10 known symbols
   - Runs `detect_communities` and verifies the result has ≥ 5 distinct clusters
   - Asserts `analyze_complexity` returns non-empty results
   - Reports counts of: total Python symbols, total import edges, edges resolved, edges dropped (stdlib/third-party), parse errors
   - Script exits non-zero if any ship criterion fails

## Validation Methodology

**Script:** `scripts/bench-python-foundation.ts`

```
Steps:
1. Clone test repo (pallets/flask) to /tmp if not present
2. Index with codesift-mcp (fresh index)
3. For each ship criterion 1-21, run a specific assertion:
   - Symbol counts by kind
   - Import edge counts
   - Edge resolution hit rate
   - Specific test cases (find_references on known symbols)
4. For each success criterion 1-5, compute the metric and compare against threshold
5. Print a summary table: criterion | expected | actual | pass/fail
6. Exit 0 if all ship criteria pass; exit 1 otherwise
```

**Per-criterion checks:**

| Criterion | Method |
|-----------|--------|
| S1 (edge recall ≥80%) | Hand-annotated ground truth in `tests/fixtures/python-imports-truth.json`; compare against extracted edges |
| S2 (symbol coverage ≥90%) | Manual review of 5 files from pallets/flask; document in benchmark output |
| S3 (zero false positives from strings) | Unit test in `tests/utils/python-imports.test.ts` with a source containing string literals and comments that look like imports |
| S4 (performance ≤ 2s) | `time` the `collectImportEdges` call in the benchmark script |
| S5 (memory stability) | Run extractor on a synthetic 10K-line file fixture |

**Unit tests are the primary ship criterion check.** The benchmark script is the success criterion check and runs in CI on demand (not blocking).

## Rollback Strategy

**Kill switch:** Environment variable `CODESIFT_DISABLE_PYTHON_IMPORTS=1`
- When set, `collectImportEdges` skips Python files entirely (emits zero edges for `.py`)
- Downstream tools (`find_references`, etc.) fall back to current behavior (empty graph for Python)
- No restart required — env var is checked on every call

**Partial rollback:** Individual extractor enhancements can be disabled by removing their detection branches. They're additive — removing them just means less metadata on symbols, not crashes.

**Full rollback:** `git revert` the Phase 1 PR. New optional fields on `CodeSymbol` remain (harmless — consumers ignore them). Re-indexing restores the old behavior.

**Fallback behavior:** If Python import extraction throws an unexpected exception, the exception is caught in `collectImportEdges`, logged, and that file's edges are dropped. The rest of indexing continues.

**Data preservation:** No migration needed. Old index files load with new `CodeSymbol` schema (fields are optional). New fields populate on re-index. Users rolling back lose the new fields on next read but no data is corrupted.

## Backward Compatibility

| Surface | Change | Compat |
|---------|--------|--------|
| `CodeSymbol` interface | +4 optional fields | Old indexes load; fields undefined |
| `ImportEdge` interface | +3 optional fields | Old edge sets load; fields undefined |
| `extractPythonSymbols` signature | No change | No callers affected |
| `collectImportEdges` signature | No change | No callers affected |
| `SymbolKind` union | **No new kinds** | No exhaustive switches break |
| Index file format (.jsonl) | Additive (new optional fields) | Old files load unchanged |
| Environment variables | +1 new (`CODESIFT_DISABLE_PYTHON_IMPORTS`) | Unset = default behavior (Python enabled) |

No migration required. Existing projects get new fields on next re-index automatically via the file watcher.

## Out of Scope

### Deferred to v2 (Phase 2 and beyond)

- **Framework-aware route tracing** — Django `urlpatterns`, Flask `@app.route`, FastAPI `@app.get` (Phase 2)
- **Python anti-patterns** — 17 patterns in `pattern-tools.ts` (Phase 2)
- **ORM model graph** — `get_model_graph` tool for Django/SQLAlchemy (Phase 2)
- **pytest fixture dependency graph** — `get_test_fixtures` tool (Phase 3)
- **Framework wiring discovery** — Django signals, Celery tasks (Phase 3)
- **Ruff/mypy integration** — `run_ruff` and `check_type_coverage` tools (Phase 4)
- **`pyproject.toml` parsing** — `parse_pyproject` tool (Phase 4)
- **Parse cache** — Shared tree-sitter parse cache to eliminate 2x parse cost for Python files (optimization backlog)

### Permanently out of scope

- **Python 2 support** — tree-sitter-python is Python 3 only; Python 2 files will produce ERROR nodes and partial results, by design
- **Runtime-resolved imports** — `importlib.import_module("name")` is unresolvable statically
- **Editable install via import hooks** — cannot be resolved without running Python
- **sys.path manipulation** — runtime changes to sys.path are not statically resolvable

## Open Questions

None — all decisions locked in Phase 2 design dialogue.

## Backlog Items (from agent reports, tracked separately)

| ID | Component | Item | Priority | Phase |
|----|-----------|------|----------|-------|
| PY-1 to PY-17 | various | See detailed backlog in agent reports | All in Phase 1 Level C | Phase 1 |
| PY-18 | tests | Python extractor test file | Required | Phase 1 |
| PY-19 | types.ts | SymbolKind decision | Resolved (no new kinds) | Phase 1 |
| PY-20 | grammar | tree-sitter-python grammar version verification | Investigation | Phase 1 |
| CLAUDE.md fix | current bug | `classifyFunction` ignores decorators on plain `function_definition` branch (line 108) | Low | Phase 1 (incidental fix) |
| Parse cache | optimization | Shared tree-sitter parse cache for symbol + import extraction | Medium | Post-Phase 1 |
