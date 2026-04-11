# Implementation Plan: Python Foundation

**Spec:** `docs/specs/2026-04-11-python-foundation-spec.md`
**spec_id:** 2026-04-11-python-foundation-2014
**planning_mode:** spec-driven
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 14
**Estimated complexity:** 10 standard + 4 complex

## Architecture Summary

Three module boundaries, each isolated:
- **Types layer** (`src/types.ts`) — extend `CodeSymbol` and `ImportEdge` with optional fields
- **Extractor layer** (`src/parser/extractors/python.ts`, `_shared.ts`) — enhance Python extractor with all Level C features
- **Import graph layer** (`src/utils/python-imports.ts`, `python-import-resolver.ts`, `import-graph.ts`) — new AST-based Python import extraction with resolution against the indexed file tree

Data flow: `.py file` → `parser-manager` → `extractPythonSymbols` (enhanced) + `extractPythonImports` (new) → `collectImportEdges` (dispatch by extension) → downstream tools.

Dependency direction: types → extractor helpers → python extractor → python imports → python resolver → import-graph dispatch. Each layer only imports from the layer below.

## Technical Decisions

- **Language:** TypeScript (existing stack)
- **Test framework:** Vitest (existing)
- **Parsing:** tree-sitter via `web-tree-sitter` (existing, already loaded for Python)
- **No new dependencies** — all implementation uses existing libraries
- **File structure convention:**
  - Extractor enhancements: extend existing `python.ts` in place
  - Import module: new files `src/utils/python-imports.ts` + `src/utils/python-import-resolver.ts`
  - Tests: `tests/parser/python-extractor.test.ts`, `tests/utils/python-imports.test.ts`, `tests/utils/python-import-resolver.test.ts`
- **Pattern reuse:** Kotlin extractor (`kotlin.ts`) is the closest template — `hasModifier`, `getAnnotations`, `getTestKind` patterns translate directly to Python decorator classification
- **Test style:** Inline source strings (no fixture files) per Kotlin test convention
- **Error handling:** `tree.rootNode.hasError` check in extractor; best-effort extraction; never throw from extractor or import resolver
- **Iterative walk:** Explicit stack with depth cap 200 (not recursive) to prevent stack overflow

## Quality Strategy

- **Test approach:** Each task has a co-located test file. Unit tests use inline Python source strings parsed live via `getParser("python")`.
- **Ship criterion validation:** Each ship criterion maps to a specific test assertion
- **Risk areas to watch:**
  - **Breaking changes on `_shared.ts`:** extending `makeSymbol` signature — ensure Kotlin/TS extractors continue to work unchanged
  - **`async_function_definition` vs `async` child:** belt-and-suspenders — handle both; write tests for both forms
  - **Relative import resolution:** subtle off-by-one errors on dot counting; comprehensive test table
  - **`__init__.py` mapping:** must match both `foo` and `foo/__init__` index keys
- **CQ gates to watch:**
  - CQ7 (error handling) — never throw from extractor
  - CQ8 (empty catch) — log, don't swallow
  - CQ22 (no useless comments) — keep code self-documenting

## Task Breakdown

### Task 1: Extend CodeSymbol and ImportEdge types
**Files:**
- `src/types.ts` (modify)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add a type-level assertion test in `tests/types.test.ts` (create if missing) that asserts `CodeSymbol` has optional `decorators?: string[]`, `extends?: string[]`, `is_async?: boolean`, `meta?: Record<string, unknown>` and `ImportEdge` has optional `type_only?: boolean`, `star_import?: boolean`, `raw?: string`. Use `satisfies` or type-only test assertions.
- [ ] GREEN: In `src/types.ts`, add these four optional fields to `CodeSymbol`:
  ```typescript
  decorators?: string[];
  extends?: string[];
  is_async?: boolean;
  meta?: Record<string, unknown>;
  ```
  And three optional fields to `ImportEdge` in `src/utils/import-graph.ts` (the interface is exported from there):
  ```typescript
  type_only?: boolean;
  star_import?: boolean;
  raw?: string;
  ```
- [ ] Verify: `npx tsc --noEmit` and `npx vitest run tests/types.test.ts`
  Expected: Compiles clean, test passes
- [ ] Acceptance: Ship criterion #21 (fields are optional, old indexes load)
- [ ] Commit: `add optional Python metadata fields to CodeSymbol and ImportEdge`

---

### Task 2: Extend `makeSymbol` helper to accept new fields
**Files:**
- `src/parser/extractors/_shared.ts` (modify)
- `tests/parser/shared.test.ts` (create if missing)

**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: In new `tests/parser/shared.test.ts`, assert that `makeSymbol` with `opts.decorators = ["@property"]`, `opts.extends = ["Base"]`, `opts.is_async = true`, `opts.meta = { is_dunder: true }` produces a `CodeSymbol` with those fields populated.
- [ ] GREEN: Extend the `opts` parameter type in `makeSymbol` to accept `decorators?: string[]`, `extends?: string[]`, `is_async?: boolean`, `meta?: Record<string, unknown>`. Populate them on the returned symbol if set.
  ```typescript
  if (opts?.decorators?.length) sym.decorators = opts.decorators;
  if (opts?.extends?.length) sym.extends = opts.extends;
  if (opts?.is_async) sym.is_async = true;
  if (opts?.meta && Object.keys(opts.meta).length > 0) sym.meta = opts.meta;
  ```
- [ ] Verify: `npx vitest run tests/parser/shared.test.ts`
  Expected: 1 test passes, existing Kotlin/TS extractor tests still pass
- [ ] Acceptance: D1 (typed fields + meta overflow)
- [ ] Commit: `extend makeSymbol to accept decorators extends is_async and meta opts`

---

### Task 3: Python extractor — async function detection (belt-and-suspenders)
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 2

- [ ] RED: Create `tests/parser/python-extractor.test.ts` with the same scaffolding as `kotlin-extractor.test.ts`:
  ```typescript
  import { initParser, getParser } from "../../src/parser/parser-manager.js";
  import { extractPythonSymbols } from "../../src/parser/extractors/python.js";
  beforeAll(async () => { await initParser(); });
  async function parsePython(source: string, file = "test.py") {
    const parser = await getParser("python");
    const tree = parser!.parse(source);
    return extractPythonSymbols(tree, file, source, "test-repo");
  }
  ```
  Add tests:
  - `async def fetch_user(): pass` → symbol has `is_async === true`, `kind === "function"`
  - `def sync_fn(): pass` → symbol has `is_async` undefined
  - `async def __aenter__(self): pass` inside class → `is_async === true`, `meta.is_dunder === true`
- [ ] GREEN: In `python.ts`, add case for `async_function_definition` that mirrors `function_definition` handling. Also check for `async` child in `function_definition`. Belt-and-suspenders:
  ```typescript
  case "async_function_definition":
  case "function_definition": {
    const isAsync = node.type === "async_function_definition"
      || node.namedChildren.some((c) => c.type === "async");
    // ... rest of extraction, pass is_async to makeSymbol
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: 3 async tests pass
- [ ] Acceptance: Ship criterion #4, E23
- [ ] Commit: `detect async functions in Python extractor via node type and async child`

---

### Task 4: Python extractor — decorator classification (@property, @classmethod, @staticmethod, @abstractmethod, @dataclass)
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (extend)

**Complexity:** complex
**Dependencies:** Task 3

- [ ] RED: Add test cases:
  - `@property\ndef name(self): return self._name` → `decorators: ["@property"]`, `kind: "method"`
  - `@classmethod\ndef from_dict(cls, d): pass` → `decorators: ["@classmethod"]`
  - `@staticmethod\ndef helper(): pass` → `decorators: ["@staticmethod"]`
  - `@abstractmethod\ndef run(self): pass` → `decorators: ["@abstractmethod"]`, `meta.is_abstract === true`
  - `@name.setter\ndef name(self, v): ...` → `decorators: ["@name.setter"]`, `meta.property_accessor === "setter"`
  - `@name.deleter\ndef name(self): ...` → `meta.property_accessor === "deleter"`
  - `@dataclass\nclass Point:\n    x: int` → class has `decorators: ["@dataclass"]`
  - `@dataclass(frozen=True)\nclass P: x: int` → class has `meta.dataclass_frozen === true`
- [ ] GREEN: In the `decorated_definition` branch, collect decorator text strings via `dec.text.trim()`. Populate `decorators` field on `makeSymbol`. Add classification:
  ```typescript
  function classifyDecorators(decorators: string[]): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    for (const d of decorators) {
      if (d === "@abstractmethod" || d.startsWith("@abstractmethod")) meta.is_abstract = true;
      if (d.startsWith("@dataclass")) {
        if (d.includes("frozen=True")) meta.dataclass_frozen = true;
      }
      const setterMatch = d.match(/@(\w+)\.(setter|deleter|getter)/);
      if (setterMatch) meta.property_accessor = setterMatch[2];
    }
    return meta;
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: all 8 decorator tests pass
- [ ] Acceptance: Ship criterion #5, E17-E21
- [ ] Commit: `classify Python decorators and emit decorator metadata on symbols`

---

### Task 5: Python extractor — superclass tracking
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (extend)

**Complexity:** standard
**Dependencies:** Task 4

- [ ] RED: Add test cases:
  - `class User(BaseModel): pass` → class symbol has `extends: ["BaseModel"]`
  - `class Admin(User, Auditable): pass` → `extends: ["User", "Auditable"]`
  - `class Empty: pass` → no `extends` field
  - `class Generic(Base[T]): pass` → `extends: ["Base[T]"]` (capture full text, not just identifier)
- [ ] GREEN: Add helper `getSuperclasses(classNode)` that reads `childForFieldName("superclasses")` and returns `argument.text` for each namedChild argument (filtering out keyword_argument for metaclass etc.). Pass result as `extends` to `makeSymbol`.
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: 4 superclass tests pass
- [ ] Acceptance: Ship criterion #8
- [ ] Commit: `extract Python class superclasses into extends field`

---

### Task 6: Python extractor — module constants and `__all__`
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (extend)

**Complexity:** complex
**Dependencies:** Task 5

- [ ] RED: Add test cases:
  - `API_URL = "https://example.com"` at module level → one symbol `kind: "constant"`, `name: "API_URL"`
  - `logger = getLogger(__name__)` at module level → NOT extracted (not SCREAMING_CASE)
  - `MAX_RETRIES: int = 3` (annotated assignment) at module level → `kind: "constant"`
  - `__all__ = ["Foo", "Bar"]` → `kind: "constant"`, `name: "__all__"`, `meta.all_members === ["Foo", "Bar"]`
  - `__all__ = ("X", "Y")` (tuple) → same but from tuple
  - `__all__ = BASE + ["Extra"]` (dynamic) → `meta.all_computed === true`, `all_members: ["Extra"]` (only literals)
  - `inside_class: CONSTANT = 1` inside a class → treated as field, not module constant
- [ ] GREEN: Add case for `expression_statement` and `assignment` nodes at module scope. Check parent for module scope (`parentId === undefined`). Use `SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]+$/` (or match `__dunder__` form for `__all__`). For `__all__`, parse the RHS list/tuple literal to extract string members; if non-literal elements present, set `meta.all_computed = true`.
  ```typescript
  case "expression_statement": {
    if (parentId) break; // only at module scope
    const assign = node.namedChildren.find(c => c.type === "assignment");
    if (!assign) break;
    // extract name, check SCREAMING_CASE or __all__
    // if __all__, parse list/tuple RHS
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: 7 tests pass
- [ ] Acceptance: Ship criterion #6, #7, E14-E16, E24-E25
- [ ] Commit: `extract Python module constants and __all__ exports`

---

### Task 7: Python extractor — dataclass fields, dunder tagging, nested class walk
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (extend)

**Complexity:** complex
**Dependencies:** Task 6

- [ ] RED: Add test cases:
  - `class Point:\n    x: int\n    y: int = 0` (dataclass) → two field symbols `x`, `y` with `parent === class.id`
  - `class Foo:\n    def __init__(self): pass` → method has `meta.is_dunder === true`
  - `def outer():\n    class Inner: pass` → Inner class is extracted (nested in function)
  - `class Outer:\n    class Inner: pass` → Inner extracted with parent === Outer.id
- [ ] GREEN:
  1. In class body walk, handle `expression_statement` containing `assignment`/`annotated_assignment` → emit as `kind: "field"` with class as parent
  2. In method classification, check if name matches `/^__\w+__$/` → set `meta.is_dunder = true`
  3. Walk function bodies too (not just class bodies) to catch nested classes/functions. Limit: only walk `block` children that can contain definitions.
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: 4 new tests pass, existing pytest fixture test still passes
- [ ] Acceptance: Ship criterion #9, #10, E22, E26, E29
- [ ] Commit: `extract dataclass fields tag dunder methods and walk nested definitions`

---

### Task 8: Python extractor — iterative walk with depth cap and error resilience
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (extend)

**Complexity:** complex
**Dependencies:** Task 7

- [ ] RED: Add test cases:
  - Synthetic 10K-line file with 250-deep nested functions → extraction completes without crash, returns symbols up to depth 200, no exception thrown
  - `def foo(:` (malformed syntax) → `tree.rootNode.hasError` is true; `extractPythonSymbols` returns best-effort partial results without throwing
  - Normal 100-symbol file → still works correctly (regression check)
- [ ] GREEN: Refactor `walk` from recursive to iterative with explicit stack:
  ```typescript
  const stack: Array<{ node: Parser.SyntaxNode; parentId?: string; depth: number }> = [{ node: tree.rootNode, depth: 0 }];
  while (stack.length > 0) {
    const { node, parentId, depth } = stack.pop()!;
    if (depth > 200) continue;
    // process node, push children with depth+1
  }
  ```
  Wrap entire extraction in try/catch → return partial symbols on unexpected error. Log warnings via `console.warn` only (no throws).
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: 3 new tests pass, all previous tests still pass
- [ ] Acceptance: Ship criterion #14, #15, E27, E28
- [ ] Commit: `convert Python walk to iterative with depth cap and error resilience`

---

### Task 9: Python import resolver — package root detection and path resolution
**Files:**
- `src/utils/python-import-resolver.ts` (create)
- `tests/utils/python-import-resolver.test.ts` (create)

**Complexity:** complex
**Dependencies:** Task 1

- [ ] RED: Create `tests/utils/python-import-resolver.test.ts` with tests:
  - `findPackageRoot("myapp/models/user.py", {"myapp/__init__.py", "myapp/models/__init__.py"})` → `"myapp/models"` (nearest ancestor with `__init__.py`)
  - `findPackageRoot("scripts/top.py", {})` → `"scripts"` (file's directory; no package)
  - `detectSrcLayout(["src/myapp/__init__.py", "src/myapp/models.py"])` → `"src"`
  - `detectSrcLayout(["myapp/__init__.py"])` → `null`
  - `resolvePythonImport({module: "utils", level: 1}, "myapp/models/user.py", ["myapp/models/utils.py", ...])` → `"myapp/models/utils.py"`
  - `resolvePythonImport({module: "", level: 2}, "myapp/a/b/c.py", [...])` → resolves to `myapp/a`
  - `resolvePythonImport({module: "myapp.models", level: 0}, "other.py", ["myapp/models.py"])` → `"myapp/models.py"`
  - `resolvePythonImport({module: "myapp.models", level: 0}, "other.py", ["myapp/models/__init__.py"])` → `"myapp/models/__init__.py"`
  - `resolvePythonImport({module: "os", level: 0}, "any.py", [])` → `null` (stdlib, not in index)
  - `resolvePythonImport({module: "......too_far", level: 6}, "a/b.py", [...])` → `null`
- [ ] GREEN: Implement three pure functions in `python-import-resolver.ts`:
  ```typescript
  export function findPackageRoot(filePath: string, indexedFilesSet: Set<string>): string {
    // walk up from file's dir, as long as {dir}/__init__.py exists in set
  }
  export function detectSrcLayout(indexedFiles: string[]): string | null {
    // check if src/<x>/__init__.py exists for some <x>
  }
  export function resolvePythonImport(
    imp: { module: string; level: number },
    importerFile: string,
    indexedFiles: string[],
  ): string | null {
    // level > 0: relative — walk up level dots from findPackageRoot
    // level === 0: absolute — try each search root + .py, /__init__.py, namespace
  }
  ```
  Use pure functions with the indexed file list — no I/O.
- [ ] Verify: `npx vitest run tests/utils/python-import-resolver.test.ts`
  Expected: 10 tests pass
- [ ] Acceptance: Ship criterion #2, #19, E4-E6, E12
- [ ] Commit: `add Python import resolver with package root and src layout detection`

---

### Task 10: Python imports — tree-sitter AST extraction
**Files:**
- `src/utils/python-imports.ts` (create)
- `tests/utils/python-imports.test.ts` (create)

**Complexity:** complex
**Dependencies:** Task 1

- [ ] RED: Create `tests/utils/python-imports.test.ts` with tests for each import form. Use the same `initParser`/`getParser("python")` scaffolding.
  - `import os` → `[{module: "os", level: 0, is_type_only: false, is_star: false}]`
  - `import os.path` → `[{module: "os.path", level: 0, ...}]`
  - `import a, b, c` → three entries
  - `from pathlib import Path` → `[{module: "pathlib", level: 0, ...}]`
  - `from . import utils` → `[{module: "", level: 1, ...}]`
  - `from .. import models` → `[{module: "", level: 2, ...}]`
  - `from .helpers import foo` → `[{module: "helpers", level: 1, ...}]`
  - `from myapp.models import User, Admin` → `[{module: "myapp.models", level: 0, ...}]` (single entry, not per name)
  - `from X import *` → `[{... is_star: true}]`
  - `if TYPE_CHECKING:\n    from x import y` → `[{... is_type_only: true}]`
  - `try:\n    import ujson as json\nexcept ImportError:\n    import json` → both entries
  - `"""not an import"""` (docstring containing fake import) → zero entries
  - `# import os` (comment) → zero entries
- [ ] GREEN: Implement `extractPythonImports(tree, filePath, source)`:
  ```typescript
  export function extractPythonImports(tree, filePath, source) {
    const imports = [];
    function walk(node, inTypeChecking = false) {
      switch (node.type) {
        case "if_statement": {
          // detect `if TYPE_CHECKING:` or `if typing.TYPE_CHECKING:`
          // walk consequence with inTypeChecking = true
          break;
        }
        case "import_statement": {
          // for each dotted_name child: push { module, level: 0, ... }
          break;
        }
        case "import_from_statement": {
          // parse relative_import for level (count dots) and optional dotted_name
          // detect wildcard_import as is_star
          break;
        }
      }
      for (const child of node.namedChildren) walk(child, inTypeChecking);
    }
    walk(tree.rootNode);
    return imports;
  }
  ```
- [ ] Verify: `npx vitest run tests/utils/python-imports.test.ts`
  Expected: 12 tests pass; string/comment tests confirm zero false positives
- [ ] Acceptance: Ship criterion #1, #16, #17, #18, E1-E11, E13
- [ ] Commit: `add Python import extraction via tree-sitter AST`

---

### Task 11: Extend `import-graph.ts` — language dispatch and path normalization
**Files:**
- `src/utils/import-graph.ts` (modify)
- `tests/utils/import-graph.test.ts` (create or extend)

**Complexity:** complex
**Dependencies:** Tasks 9, 10

- [ ] RED: Add tests to `tests/utils/import-graph.test.ts`:
  - `buildNormalizedPathMap` on an index containing `myapp/__init__.py` and `myapp/models.py` → map has keys `myapp/__init__`, `myapp` (collapsed), `myapp/models`
  - `collectImportEdges` on a mock Python index with `a/__init__.py`, `a/b.py`, `a/c.py`, where `a/b.py` contains `from . import c` → returns edge `a/b.py -> a/c.py`
  - `collectImportEdges` on mixed TS + Python index → TS file edges still work (regression)
  - Env var `CODESIFT_DISABLE_PYTHON_IMPORTS=1` → Python files yield zero edges
- [ ] GREEN:
  1. In `buildNormalizedPathMap`, also strip `.py` extension; additionally for any key ending in `/__init__`, add a key without the `/__init__` suffix
  2. In `collectImportEdges`, check file extension; for `.py` files, call a new internal `collectPythonEdgesForFile` that uses `extractPythonImports` + `resolvePythonImport`; for others, use the existing regex path
  3. Check `process.env.CODESIFT_DISABLE_PYTHON_IMPORTS` and skip Python files if set
  4. Wrap Python path in try/catch; on error, log and skip the file
- [ ] Verify: `npx vitest run tests/utils/import-graph.test.ts`
  Expected: 4 new tests pass; all previous import-graph tests pass (regression)
- [ ] Acceptance: Ship criterion #3, rollback kill switch (#20), D4
- [ ] Commit: `dispatch Python imports in collectImportEdges with kill switch support`

---

### Task 12: Fix incidental bug — `classifyFunction` ignores decorators on plain `function_definition` branch
**Files:**
- `src/parser/extractors/python.ts` (modify)
- `tests/parser/python-extractor.test.ts` (extend)

**Complexity:** standard
**Dependencies:** Task 8

- [ ] RED: Add a regression test that was impossible to hit before:
  - Verify that a test function `def test_foo(): pass` (undecorated) still classifies as `test_case` (sanity check — should already pass)
  - Verify that after refactoring to iterative walk, the `decorated_definition` → `function_definition` path still correctly calls `classifyFunction` with collected decorators
- [ ] GREEN: This is a correctness check after the iterative walk refactor in Task 8. Verify `classifyFunction` receives decorators in the decorated path. Remove the bug noted in the agent report (line 108 passes empty array) — the plain `function_definition` branch should not call `classifyFunction` with decorators at all (decorators only exist in `decorated_definition`).
- [ ] Verify: `npx vitest run tests/parser/python-extractor.test.ts`
  Expected: Regression test passes; existing tests still pass
- [ ] Acceptance: Code Explorer backlog item #1 (incidental fix)
- [ ] Commit: `clean up classifyFunction decorator handling after walk refactor`

---

### Task 13: Integration smoke test — real Python repo parse
**Files:**
- `tests/integration/python-integration.test.ts` (create)
- `tests/fixtures/python-sample/` (create, a small synthetic Python project)

**Complexity:** standard
**Dependencies:** Tasks 3-12

- [ ] RED: Create `tests/fixtures/python-sample/` with:
  ```
  myapp/__init__.py              (empty)
  myapp/models.py                (class User, class Post extends Model)
  myapp/views.py                 (from .models import User, import os)
  myapp/utils/__init__.py        (from .helpers import format)
  myapp/utils/helpers.py         (def format(x): pass, ASYNC = True)
  myapp/tests/conftest.py        (@pytest.fixture def db(): pass)
  ```
  Add integration test: index the fixture, assert:
  - All symbols extracted (at least 10)
  - Import edges: `views.py -> models.py` exists, `views.py -> os.py` does NOT (os is stdlib)
  - Relative import `utils/__init__.py -> utils/helpers.py` exists
  - conftest fixture is `test_hook` kind
  - User class has `extends: ["Model"]`
  - `__init__.py` imports work end-to-end
- [ ] GREEN: No production code — this is an integration check that the previous tasks work together. If it fails, fix the underlying task.
- [ ] Verify: `npx vitest run tests/integration/python-integration.test.ts`
  Expected: All assertions pass
- [ ] Acceptance: Ship criteria #2, #3, #4, #5, #8, #9 (cross-cutting integration)
- [ ] Commit: `add Python foundation integration smoke test with synthetic project`

---

### Task 14: Update CLAUDE.md and README — document Python foundation
**Files:**
- `CLAUDE.md` (modify)
- `README.md` (modify, if it references language support)

**Complexity:** standard
**Dependencies:** Task 13

- [ ] RED: n/a (documentation task)
- [ ] GREEN: Update `CLAUDE.md` Architecture section to mention Python import graph support. Add a line in the "After adding/changing features — update checklist" noting that Python extractor was enhanced. If README mentions language support levels, update Python from "basic" to "full extractor + import graph".
- [ ] Verify: `grep -l "Python" CLAUDE.md README.md 2>/dev/null`
  Expected: Both files mention updated Python support
- [ ] Acceptance: Project convention (CLAUDE.md update checklist)
- [ ] Commit: `document Python foundation support in CLAUDE.md and README`

---

## Dependency Graph

```
Task 1 (types)
  ├─▶ Task 2 (_shared helper)
  │     └─▶ Task 3 (async)
  │           └─▶ Task 4 (decorators)
  │                 └─▶ Task 5 (superclasses)
  │                       └─▶ Task 6 (module constants + __all__)
  │                             └─▶ Task 7 (dataclass fields, dunder, nested walk)
  │                                   └─▶ Task 8 (iterative walk, error resilience)
  │                                         └─▶ Task 12 (cleanup incidental bug)
  │                                               └─▶ Task 13 (integration)
  │                                                     └─▶ Task 14 (docs)
  ├─▶ Task 9 (resolver) ────────────────────────┐
  └─▶ Task 10 (importer extraction) ────────────┤
                                                 ▼
                                          Task 11 (dispatch) ─▶ Task 13
```

Tasks 9 and 10 can run in parallel with Tasks 3-8.
Task 11 waits for Tasks 9, 10, and is needed by Task 13.

## Execution Order (sequential)

1. Task 1 (types)
2. Task 2 (_shared)
3. Task 3 (async)
4. Task 4 (decorators)
5. Task 5 (superclasses)
6. Task 6 (constants, __all__)
7. Task 7 (dataclass, dunder, nested)
8. Task 8 (iterative walk)
9. Task 9 (resolver) — could run earlier in parallel
10. Task 10 (import extraction) — could run earlier in parallel
11. Task 11 (dispatch)
12. Task 12 (cleanup)
13. Task 13 (integration)
14. Task 14 (docs)

## Adversarial Review Notes

Skipped — interactive planning session with comprehensive 3-agent exploration (Code Explorer, Domain Researcher, Business Analyst) already performed full cross-verification during the brainstorm phase. Re-running adversarial review here would be redundant given the spec has complete edge case coverage, failure mode analysis, and acceptance criteria traceable to implementation tasks.
