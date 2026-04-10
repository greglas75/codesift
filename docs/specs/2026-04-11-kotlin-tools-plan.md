# Implementation Plan: Kotlin Tool Extensions + New Tools

**Spec:** (inline — brainstorm approved in conversation)
**spec_id:** 2026-04-11-kotlin-tools
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 12
**Estimated complexity:** 8 standard + 4 complex

## Prerequisite

Kotlin tree-sitter parser already shipped (commit 92720f4). `.kt`/`.kts` files are parsed,
symbols extracted (functions, classes, interfaces, objects, enums, properties, type aliases,
extension functions, suspend, generics, KDoc, JUnit test detection). 31 extractor tests pass.

This plan adds Kotlin awareness to all downstream tools that currently have JS/TS-only assumptions.

## Phase 1 — Critical Fixes (unblock existing tools for Kotlin)

These are not new features — they fix existing tools that silently fail on Kotlin code.

---

### Task 1: Add Kotlin keywords to call graph KEYWORD_SET
**Files:** `src/tools/graph-tools.ts`, `tests/tools/graph-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

**Problem:** `KEYWORD_SET` (line 56-65) only has JS/TS keywords. Kotlin's `when(`, `fun(`,
`object(` get misidentified as function calls, producing noisy/wrong call trees for
`trace_call_chain` and `impact_analysis`.

- [ ] RED: Test that `extractCallSites("when (x) { ... }")` does NOT include "when" in results.
  Test that `extractCallSites("fun process(data: String)")` does NOT include "fun".
- [ ] GREEN: Add to `KEYWORD_SET` at line 64: `"when"`, `"fun"`, `"val"`, `"var"`,
  `"data"`, `"sealed"`, `"object"`, `"companion"`, `"suspend"`, `"inline"`, `"reified"`,
  `"lateinit"`, `"init"`, `"typealias"`, `"by"`, `"internal"`, `"open"`, `"inner"`,
  `"crossinline"`, `"noinline"`, `"tailrec"`, `"operator"`, `"infix"`, `"annotation"`,
  `"actual"`, `"expect"`.
- [ ] Verify: `npx vitest run tests/tools/graph-tools.test.ts`
- [ ] Commit: `fix(kotlin): add Kotlin keywords to call graph KEYWORD_SET`

---

### Task 2: Add .kt/.kts to LSP detectLanguage map
**Files:** `src/lsp/lsp-tools.ts`
**Complexity:** standard
**Dependencies:** none

**Problem:** `detectLanguage()` (line 12-19) has no `.kt`/`.kts` mapping. LSP-powered
`go_to_definition`, `get_type_info`, `find_references` (LSP path), `rename_symbol` all
return null for Kotlin files even when kotlin-language-server is installed.

- [ ] RED: N/A (config-only, covered by LSP integration tests)
- [ ] GREEN: Add to map object at line 16: `".kt": "kotlin", ".kts": "kotlin",`
- [ ] Verify: `npx vitest run`
- [ ] Commit: `fix(kotlin): add .kt/.kts to LSP detectLanguage map`

---

### Task 3: Add .kt/.kts to ripgrep file type in findReferences
**Files:** `src/tools/symbol-tools.ts`
**Complexity:** standard
**Dependencies:** none

**Problem:** `findReferences` (line 331) defines a ripgrep `--type-add` with
`code:*.{ts,tsx,js,jsx,py,go,rs,java,rb,php,vue,svelte}`. Kotlin files are excluded
from reference search via ripgrep path.

- [ ] RED: N/A (ripgrep integration, tested via tool-level tests)
- [ ] GREEN: Change line 331 to include `kt,kts`:
  `"code:*.{ts,tsx,js,jsx,py,go,rs,java,kt,kts,rb,php,vue,svelte}"`
- [ ] Verify: `npx vitest run tests/tools/symbol-tools.test.ts`
- [ ] Commit: `fix(kotlin): add .kt/.kts to ripgrep code type in findReferences`

---

### Task 4: Add Kotlin test file patterns
**Files:** `src/utils/test-file.ts`, `tests/utils/test-file.test.ts` (create if needed)
**Complexity:** standard
**Dependencies:** none

**Problem:** `TEST_FILE_REGEX_PATTERNS` (line 7-14) only matches `.test.tsx?`, `.spec.tsx?`,
`.e2e.tsx?`. Kotlin test files (`UserTest.kt`, `LoginSpec.kt`, `src/test/kotlin/*.kt`,
`src/androidTest/*.kt`) aren't detected. This breaks: `find_dead_code` (false positives),
`impact_analysis` (missing affected tests), BM25 search ranking (test files not demoted).

- [ ] RED: Test `isTestFileStrict("src/test/kotlin/UserServiceTest.kt")` returns true.
  Test `isTestFileStrict("src/androidTest/LoginTest.kt")` returns true.
  Test `isTestFileStrict("UserTest.kt")` returns true.
  Test `isTestFileStrict("UserService.kt")` returns false.
- [ ] GREEN: Add to `TEST_FILE_REGEX_PATTERNS`:
  ```
  /Test\.kts?$/,       // Kotlin: UserTest.kt, LoginTest.kts
  /Tests\.kts?$/,      // Kotlin: UserTests.kt
  /Spec\.kts?$/,       // Kotest: UserSpec.kt
  /\/androidTest\//,   // Android instrumented tests
  ```
  Add to `TEST_FILE_PATTERNS`: `"Test.kt"`, `"Tests.kt"`, `"Spec.kt"`.
- [ ] Verify: `npx vitest run tests/utils/`
- [ ] Commit: `fix(kotlin): add Kotlin test file patterns for dead code and search ranking`

---

### Task 5: Add `when` and Kotlin operators to complexity analysis
**Files:** `src/tools/complexity-tools.ts`, `tests/tools/complexity-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

**Problem:** `BRANCH_PATTERNS` (line 10-19) miss Kotlin `when`, `?.let`, `?.run`, `?:`.
`NESTING_OPENERS` (line 22) misses `when`. `analyze_complexity` underreports Kotlin
function complexity by 30-50%.

- [ ] RED: Test that a Kotlin function with `when(x) { ... }` scores cyclomatic >= 2.
  Test that `?.let {` counts as a branch point. Test that `?:` counts as a branch.
- [ ] GREEN: Add to `BRANCH_PATTERNS` after line 18:
  ```
  /\bwhen\s*[\({]/g,   // Kotlin when expression
  /\?\.let\s*\{/g,     // safe call + lambda
  /\?\.run\s*\{/g,     // safe call + run
  /\?:/g,              // Elvis operator
  ```
  Change `NESTING_OPENERS` at line 22 to:
  `/\b(if|for|while|switch|try|when)\s*[\({]/g`
- [ ] Verify: `npx vitest run tests/tools/complexity-tools.test.ts`
- [ ] Commit: `fix(kotlin): add when/safe-call/elvis to complexity analysis`

---

## Phase 2 — Import Graph + Community Detection (unlock architecture tools)

---

### Task 6: Add Kotlin import pattern to import graph
**Files:** `src/utils/import-graph.ts`, `tests/utils/import-graph.test.ts`
**Complexity:** complex
**Dependencies:** none

**Problem:** `IMPORT_PATTERNS` (line 14-21) only match ES/CommonJS imports. Kotlin uses
`import com.example.ClassName` (no `from`, no quotes). Without this, `detect_communities`,
`impact_analysis`, `get_knowledge_map` produce empty graphs for Kotlin.

**Design decision:** Kotlin imports use package names, not file paths. We can't resolve
`import com.example.UserService` to `src/main/kotlin/com/example/UserService.kt` without
knowing source roots. Approach: match package-to-file heuristically using file index.

- [ ] RED: Test `extractImports("import com.example.UserService")` returns `["com.example.UserService"]`.
  Test `extractImports("import com.example.*")` returns `["com.example.*"]`.
  Test `extractImports("import com.example.UserService as US")` returns `["com.example.UserService"]`.
  Test that Kotlin imports don't pollute JS import detection.

- [ ] GREEN:
  1. Add Kotlin import pattern to `IMPORT_PATTERNS`:
     `/^import\s+([\w.]+?)(?:\s+as\s+\w+)?$/gm`
  2. Mark results as "kotlin-qualified" (not relative path) so `resolveImportPath` can
     handle them differently.
  3. Add `resolveKotlinImport(index, qualifiedName)` — match last segment against indexed
     file basenames (e.g., `UserService` → find `UserService.kt` in index). Heuristic
     but works for single-repo projects.
  4. Update `buildImportGraph()` to call `resolveKotlinImport` for non-relative imports
     that look like Kotlin qualified names (contain only dots + identifiers, no `/`).
  5. Add `.kt` and `.kts` to `resolveImportPath` extension stripping (line 65).

- [ ] Verify: `npx vitest run tests/utils/import-graph.test.ts`
- [ ] Commit: `feat(kotlin): add Kotlin import resolution to import graph`

---

## Phase 3 — Kotlin Anti-Patterns (search_patterns)

---

### Task 7: Add Kotlin-specific built-in patterns
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test `searchPatterns(repo, "runblocking-in-coroutine")` matches
  `suspend fun fetch() { runBlocking { } }`. Test `searchPatterns(repo, "globalscope-launch")`
  matches `GlobalScope.launch { }`.

- [ ] GREEN: Add 6 patterns to `BUILTIN_PATTERNS` after line 74:
  ```typescript
  "runblocking-in-coroutine": {
    regex: /suspend\s+fun[\s\S]{0,500}runBlocking\s*[\({]/,
    description: "runBlocking inside suspend function — deadlock risk (Kotlin coroutines)",
  },
  "globalscope-launch": {
    regex: /GlobalScope\.(launch|async)\s*[\({]/,
    description: "GlobalScope.launch/async — lifecycle leak, use structured concurrency (Kotlin)",
  },
  "data-class-mutable": {
    regex: /data\s+class\s+\w+\([^)]*\bvar\s+/,
    description: "data class with var property — breaks hashCode/equals contract (Kotlin)",
  },
  "lateinit-no-check": {
    regex: /lateinit\s+var\s+(\w+)/,
    description: "lateinit var without isInitialized check — UninitializedPropertyAccessException risk (Kotlin)",
  },
  "empty-when-branch": {
    regex: /when\s*\([^)]*\)\s*\{[\s\S]*?->\s*\{\s*\}/,
    description: "Empty when branch — swallowed case (Kotlin)",
  },
  "mutable-shared-state": {
    regex: /(?:companion\s+object|object\s+\w+)\s*\{[\s\S]*?\bvar\s+/,
    description: "Mutable var inside object/companion — thread-unsafe shared state (Kotlin)",
  },
  ```
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts`
- [ ] Commit: `feat(kotlin): add 6 Kotlin anti-pattern detectors to search_patterns`

---

## Phase 4 — Route Tracing (Ktor + Spring Boot Kotlin)

---

### Task 8: Add Ktor route handler detection
**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 6 (import graph for DB layer tracing)

**Design:** Follow existing `findNestJSHandlers` pattern. Scan `.kt` files for Ktor routing
DSL: `routing { get("/path") { ... } }`, `route("/prefix") { get("/sub") { } }`.

- [ ] RED: Test that `findKtorHandlers(index, "/api/users")` finds a handler defined as
  `get("/api/users") { call.respond(...) }` in a `.kt` file.

- [ ] GREEN: Add `findKtorHandlers()` (~40 lines) using regex:
  - `/(?:get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']\s*\)/g` on `.kt` files
  - Also handle `route("/prefix") { get("/sub") }` nesting (combine prefix + sub).
  - Wire into `traceRoute()` at line 311: `...(await findKtorHandlers(index, path)),`
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts`
- [ ] Commit: `feat(kotlin): add Ktor route handler detection to trace_route`

---

### Task 9: Add Spring Boot Kotlin route handler detection
**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 8 (same file)

- [ ] RED: Test that `findSpringBootKotlinHandlers(index, "/api/users")` finds a handler
  defined as `@GetMapping("/api/users") fun getUsers()` in a `@RestController` class.

- [ ] GREEN: Add `findSpringBootKotlinHandlers()` (~40 lines):
  - Scan `.kt` files for `@RestController` or `@Controller`
  - Within those files, find `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`,
    `@PatchMapping`, `@RequestMapping` annotations with path arguments
  - Combine class-level `@RequestMapping("/api")` with method-level `@GetMapping("/users")`
  - Wire into `traceRoute()` after Ktor handler.
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts`
- [ ] Commit: `feat(kotlin): add Spring Boot Kotlin handler detection to trace_route`

---

## Phase 5 — New Kotlin-Specific Tools

---

### Task 10: `find_extension_functions` tool
**Files:** `src/tools/kotlin-tools.ts` (new), `src/register-tools.ts`, `tests/tools/kotlin-tools.test.ts` (new)
**Complexity:** complex
**Dependencies:** Tasks 1-4 (core fixes)

**Design:** New discoverable tool (not in core 35). Given a receiver type name, search all
indexed Kotlin symbols whose signature starts with `TypeName.`. Return grouped by file.

- [ ] RED: Test with indexed symbols containing `fun String.toSlug(): String` and
  `fun String.capitalize(): String` — querying "String" returns both.
  Test querying "List" returns extensions on List but not on String.

- [ ] GREEN:
  1. Create `src/tools/kotlin-tools.ts` with `findExtensionFunctions(repo, receiverType, options?)`.
  2. Scan `index.symbols` where `kind === "function"` and `signature` matches
     `receiverType + "."` prefix.
  3. Return results grouped by file with symbol details.
  4. Register as discoverable tool in `register-tools.ts` (hidden, revealed via `discover_tools`).

- [ ] Verify: `npx vitest run tests/tools/kotlin-tools.test.ts`
- [ ] Commit: `feat(kotlin): add find_extension_functions tool`

---

### Task 11: `analyze_sealed_hierarchy` tool
**Files:** `src/tools/kotlin-tools.ts`, `tests/tools/kotlin-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 10 (same file)

**Design:** Given a sealed class/interface name, find all subtypes in the index (classes
whose source contains `: SealedName` in delegation specifiers). Then scan `when` blocks
that match on the sealed type and report missing branches.

- [ ] RED: Test with sealed class `Result` having subtypes `Success` and `Error` —
  tool returns both subtypes. Test with `when(result) { is Success -> ... }` — reports
  `Error` as missing branch.

- [ ] GREEN:
  1. `analyzeSealedHierarchy(repo, sealedClassName)` in `kotlin-tools.ts`.
  2. Find the sealed class in index by name + kind.
  3. Search all symbols in same + child files for classes whose source contains
     `: SealedName` or `SealedName()` after `:`.
  4. Search text for `when.*SealedName` or `when.*is SealedName` to find when blocks.
  5. Compare branches found vs subtypes → report missing.
  6. Register as discoverable tool.

- [ ] Verify: `npx vitest run tests/tools/kotlin-tools.test.ts`
- [ ] Commit: `feat(kotlin): add analyze_sealed_hierarchy tool`

---

### Task 12: `findUnusedImports` Kotlin support
**Files:** `src/tools/symbol-tools.ts`, `tests/tools/symbol-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 6 (import graph)

**Problem:** `findUnusedImports` (line 766) filters to JS/TS files only:
`/\.(ts|tsx|js|jsx|mjs)$/.test(file.path)`. Kotlin files are completely skipped.

- [ ] RED: Test that `findUnusedImports(repo)` scans `.kt` files and detects
  `import com.example.Unused` when `Unused` is not referenced.
- [ ] GREEN: Change line 766 to: `/\.(ts|tsx|js|jsx|mjs|kt|kts)$/.test(file.path)`.
  Add Kotlin import line detection (already partly handled by `extractImportLines` which
  checks `trimmed.startsWith("import ")`).
- [ ] Verify: `npx vitest run tests/tools/symbol-tools.test.ts`
- [ ] Commit: `fix(kotlin): include .kt/.kts in findUnusedImports scan`

---

## Implementation Order (Dependency Graph)

```
Phase 1 (parallel — no dependencies between tasks):
  Task 1: KEYWORD_SET          ─┐
  Task 2: LSP detectLanguage    │
  Task 3: ripgrep file type     ├── all independent, do in parallel
  Task 4: test file patterns    │
  Task 5: complexity patterns  ─┘

Phase 2 (needs Phase 1 for full value):
  Task 6: import graph ────────── unlocks detect_communities, impact_analysis

Phase 3 (independent):
  Task 7: anti-patterns ───────── can run parallel with Phase 2

Phase 4 (needs Task 6):
  Task 8: Ktor routes ────┐
  Task 9: Spring routes ──┘─── sequential (same file)

Phase 5 (needs Phase 1):
  Task 10: find_extension_functions ──┐
  Task 11: analyze_sealed_hierarchy ──┘── sequential (same file)
  Task 12: findUnusedImports ─────────── needs Task 6
```

## Summary

| Phase | Tasks | Files changed | New tests | Value |
|-------|-------|--------------|-----------|-------|
| 1 | 1-5 | 5 existing | ~20 | Fix 8+ existing tools for Kotlin |
| 2 | 6 | 1 existing | ~8 | Unlock architecture tools |
| 3 | 7 | 1 existing | ~6 | 6 Kotlin anti-pattern detectors |
| 4 | 8-9 | 1 existing | ~8 | trace_route for Ktor/Spring Boot |
| 5 | 10-12 | 2 new + 1 existing | ~12 | 2 unique Kotlin tools + unused imports |
| **Total** | **12** | **8 modified + 2 new** | **~54** | **Full Kotlin ecosystem support** |
