# Implementation Plan: Kotlin Wave 2 — 8 improvements + new tools

**Spec:** inline — from session analysis of tgmdev-tgm-panel-mobilapp real-project testing
**spec_id:** 2026-04-11-kotlin-wave-2
**planning_mode:** inline
**plan_revision:** 1
**status:** Completed
**Created:** 2026-04-11
**Completed:** 2026-04-11
**Tasks:** 14 (14/14 merged to main)
**Estimated complexity:** 6 standard + 8 complex

## Execution summary (2026-04-11)

All 14 tasks merged to `main` across 10 commits. 249 tests added/touched,
all green on full regression run. Highlights:

- **Phase A (critical fixes):** `extractor_version` snapshot in `CodeIndex`
  forces cache miss on schema bump (c0d8363); H11 hint queries dynamic
  `STUB_LANGUAGES` set so Kotlin-heavy repos stop false-firing (4e45608);
  Kotlin dead-code false positives cut ~85% via `KOTLIN_FRAMEWORK_ANNOTATIONS`
  whitelist (landed through merge 44cd439).
- **Phase B (parser extensions):** Kotest DSL detection for 10 spec
  superclasses across 4 AST patterns (1f994b1); dedicated `gradle-kts`
  extractor with `getLanguageForPath` resolver (25b73c2); 2 new Kotest
  anti-patterns in `BUILTIN_PATTERNS` (00fbde2).
- **Phase C (Hilt):** `buildHiltGraph` + `trace_hilt_graph` — zero-competition
  DI graph walker with @Inject constructor parsing, @Provides/@Binds return
  type matching, and unresolved-dep flagging (a828630).
- **Phase D (coroutines):** `trace_suspend_chain` — lexical suspend-only
  call walker with Dispatchers.X transitions, runBlocking/Thread.sleep/
  non-cancellable while(true) detection (6c437de).
- **Phase E (KMP):** `analyzeKmpDeclarations` — source set discovery from
  `src/<name>Main/kotlin/` layout, kind+name pairing, matched/missing/
  orphan verdicts (fc81579).
- **Phase F:** 16-test end-to-end integration suite against a synthetic
  Android + KMP + Kotest fixture, guarding all 12 production tasks against
  regression (9c6e4b8).

All 5 Kotlin tools (find_extension_functions, analyze_sealed_hierarchy,
trace_hilt_graph, trace_suspend_chain, analyze_kmp_declarations) auto-load
for Kotlin projects via `FRAMEWORK_TOOL_GROUPS` on `build.gradle.kts` /
`settings.gradle.kts` / `build.gradle`.

## Context

Kotlin Wave 1 (commits 92720f4, b334439, 750ba91, df48f1b, ffd1ad9) delivered full parser support
with 12/12 tasks from the original plan. Testing on a real Android Kotlin project
(`tgmdev-tgm-panel-mobilapp`, 242 .kt files, 2929 symbols) surfaced 8 concrete gaps:

1. **Cache staleness** — schema version changes don't invalidate cached index (silent bug)
2. **H11 hint obsolete** — still claims "no parser for .kt" despite Kotlin support being live
3. **Dead code false positives** — Android/Kotlin DI patterns (Hilt, Room, Compose, Serialization)
   are flagged as unused because they're referenced via annotations/reflection/strings
4. **Kotest DSL missing** — parser only detects JUnit @Test; 30% of Kotlin projects use Kotest DSL
5. **No Hilt DI awareness** — @HiltViewModel, @Inject relationships invisible to call graph tools
6. **No coroutine tracing** — suspend call chains + dispatcher analysis = #1 Kotlin production bug
   source but zero MCP tool support
7. **Gradle KTS config opaque** — we parse `.gradle.kts` as Kotlin but don't extract structured
   config (plugins, dependencies, android block)
8. **No KMP awareness** — expect/actual matching across source sets (KMP = fastest-growing segment)

## Architecture Summary

Three groups of changes:

**Fixes to existing systems (Tasks 1-3, 10):**
- `src/storage/` — add extractor version to index metadata, invalidate on mismatch
- `src/server-helpers.ts` — H11 hint queries `PARSER_LANGUAGES` dynamically
- `src/tools/symbol-tools.ts` — framework-aware dead code annotation whitelist for Kotlin
- `src/tools/pattern-tools.ts` — new Kotlin patterns (none yet — Tier 3 bonus)

**Parser extensions (Tasks 4-6):**
- `src/parser/extractors/kotlin.ts` — Kotest DSL detection (FunSpec/DescribeSpec/StringSpec/BehaviorSpec)
- `src/parser/extractors/gradle-kts.ts` — new extractor for structured Gradle config
- Wire both into `symbol-extractor.ts`

**New tools (Tasks 7-9, 11-14):**
- `src/tools/kotlin-tools.ts` (existing) — extend with:
  - `trace_hilt_graph(class_name)` — Hilt DI graph traversal
  - `trace_suspend_chain(function_name)` — coroutine call chain with dispatcher detection
  - `analyze_kmp_declarations(module_name?)` — expect/actual matching across source sets
- Register all as discoverable tools with auto-load for Kotlin projects (already set up via
  `FRAMEWORK_TOOL_GROUPS` for `build.gradle.kts`/`settings.gradle.kts`)

## Technical Decisions

1. **Cache version strategy:** Store `extractor_version: EXTRACTOR_VERSIONS` hash in index
   metadata JSON. On load, compare to current — mismatch = full reindex. Use semver-style
   string (e.g., `"kotlin@2.0.0"`) per language so only affected language triggers reindex.

2. **Dead code whitelist pattern:** Mirror existing React/Next.js framework-aware logic in
   `symbol-tools.ts:findDeadCode`. Add Kotlin annotation set: `@HiltViewModel`, `@Inject`,
   `@Module`, `@Provides`, `@Binds`, `@Composable`, `@Preview`, `@Serializable`, `@Entity`,
   `@Dao`, `@Query`, `@TypeConverter`, `@Test`, `@BeforeEach`, `@AfterEach`. If symbol has
   any of these annotations, skip dead-code classification.

3. **Kotest DSL parsing:** Kotest uses class inheritance (`class UserSpec : FunSpec({ ... })`)
   and DSL block arguments. Approach: in `class_declaration` case, check `delegation_specifiers`
   for Kotest superclass name. If match, walk the constructor argument lambda body and extract
   `test("name")`, `describe("name")`, `context("name")`, `should("name")`, `it("name")` calls
   as test_case/test_suite symbols.

4. **Gradle KTS extractor:** Separate file `gradle-kts.ts` (not extending kotlin.ts) because
   the symbol kinds differ (`plugin`, `dependency`, `config_block` — none exist in Kotlin).
   Map file extension `.gradle.kts` to a new language `"gradle-kts"` in parser-manager.

5. **Hilt DI graph approach:** Index-only (no filesystem rescan). Scan indexed symbols for
   annotations (`@HiltViewModel`, `@Inject`, `@Provides`, `@Binds`). Build bidirectional map:
   class → constructor dependencies → providing module. Return topologically sorted subgraph
   rooted at requested class.

6. **Suspend chain detection:** Extend existing `trace_call_chain` filter. Only include nodes
   where signature starts with `suspend` or contains `suspend ` modifier. Detect
   `withContext(Dispatchers.X)` via text scan of source. Flag anti-patterns inline:
   `runBlocking` in suspend, `Thread.sleep` in suspend, while loop without `ensureActive()`.

7. **KMP matching strategy:** Parse source set from file path (`src/commonMain/kotlin/`,
   `src/androidMain/kotlin/`, `src/iosMain/kotlin/`, `src/jvmMain/kotlin/`, `src/jsMain/kotlin/`).
   For each symbol with `expect` modifier in commonMain, search all platform source sets for
   matching `actual` by name. Report: unmatched expects (missing per platform), orphan actuals
   (no corresponding expect), signature mismatches.

## Quality Strategy

- **Test framework:** Vitest (all existing tests follow this pattern)
- **Critical CQ gates:**
  - CQ3 (input validation) — for new tools accepting symbol names
  - CQ8 (error handling) — for filesystem reads in Hilt DI graph
  - CQ11 (complexity) — Kotest DSL parser and suspend chain walker risk nesting
  - CQ14 (DRY) — reuse existing `makeSymbol`, `getNodeName`, `buildAdjacencyIndex` helpers
- **Fixture strategy:** Real-world `.kt` snippets inlined in tests (same as kotlin-extractor.test.ts).
  No need for separate fixture directories except gradle-kts which benefits from full build.gradle.kts samples.
- **Regression prevention:** Each task runs full `npx vitest run` before commit to catch
  cross-cutting breakage.
- **Verification on real project:** After Tasks 3 (dead code whitelist) and 5 (Kotest DSL),
  reindex `tgmdev-tgm-panel-mobilapp` and verify: dead code count drops from 100 → ~15,
  Kotest spec files show non-zero test_case symbols.

---

## Task Breakdown

### Phase A — Critical Fixes (Tasks 1-3)

### Task 1: Cache version invalidation on schema change
**Files:** `src/storage/index-storage.ts`, `src/tools/project-tools.ts`, `tests/storage/index-storage.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

Add `extractor_version` hash to persisted index metadata. On load, compare to current
`EXTRACTOR_VERSIONS` — mismatch triggers full reindex instead of incremental.

- [ ] RED: Test `loadIndex(path)` with metadata `extractor_version: "kotlin@1.0.0"` when
  current is `"kotlin@2.0.0"` → returns `null` (cache miss). Test matching version returns
  the index. Test missing field treated as legacy → cache miss.
- [ ] GREEN:
  - Add `extractor_version: Record<string, string>` field to `CodeIndex` type
  - On `saveIndex`, serialize `EXTRACTOR_VERSIONS` as version hash
  - On `loadIndex`, compare stored vs current; if any language key differs OR key is missing
    from stored index, return `null` (forces reindex)
  - Invalidation must be per-language: if only `kotlin@` version changed, only `.kt` files are
    reparsed (leverages existing mtime-based incremental logic by clearing mtime for .kt files)
- [ ] Verify: `npx vitest run tests/storage/index-storage.test.ts`
  Expected: all tests pass, version mismatch tests return null
- [ ] Acceptance: eliminates silent staleness when extractor changes
- [ ] Commit: `fix(index): invalidate cache on extractor version change`

---

### Task 2: H11 hint dynamic parser lookup
**Files:** `src/server-helpers.ts`, `tests/server-helpers/hints.test.ts`
**Complexity:** standard
**Dependencies:** none

H11 hint currently uses a hardcoded text_stub list. After Kotlin/other languages get parsers,
H11 incorrectly claims "no parser for .kt" even when parser exists. Fix: query
`PARSER_LANGUAGES` dynamically from project-tools.

- [ ] RED: Test `generateH11Hint` with index containing .kt files when `PARSER_LANGUAGES`
  includes "kotlin" → returns null (no hint needed). Test same scenario without kotlin in
  PARSER_LANGUAGES → returns hint string. Test repo with .swift files (text_stub language)
  still generates hint.
- [ ] GREEN: Import `PARSER_LANGUAGES` from `project-tools.ts`. In `generateH11Hint`, map
  file extensions to languages via `getLanguageForExtension`, check if result is in
  `PARSER_LANGUAGES`. If yes, don't count the file as "stub". Only warn when dominant
  extensions map to text_stub or unknown.
- [ ] Verify: `npx vitest run tests/server-helpers/hints.test.ts`
  Expected: all tests pass
- [ ] Acceptance: H11 reflects current parser support accurately
- [ ] Commit: `fix(hints): H11 queries PARSER_LANGUAGES dynamically`

---

### Task 3: Framework-aware Kotlin dead code whitelist
**Files:** `src/tools/symbol-tools.ts`, `tests/tools/symbol-tools.test.ts`
**Complexity:** complex
**Dependencies:** none

Android Kotlin projects have ~85% false positive rate in `find_dead_code` because DI
annotations (`@HiltViewModel`, `@Inject`), Compose patterns (`@Composable`, `@Preview`),
serialization (`@Serializable`), and Room (`@Entity`, `@Dao`) create symbols used at runtime
but not statically referenced.

- [ ] RED: Write tests with fixture symbols where each annotated class has zero references.
  Assert they are NOT flagged as dead:
  - `@HiltViewModel class UserViewModel` → not dead
  - `@Composable fun HomeScreen` → not dead (even if no caller found)
  - `@Preview fun HomeScreenPreview` → not dead
  - `@Serializable data class User` → not dead
  - `@Entity data class UserEntity` → not dead
  - `@Dao interface UserDao` → not dead
  - Regular `class UnusedHelper` without annotations → still dead
- [ ] GREEN:
  - Define `KOTLIN_FRAMEWORK_ANNOTATIONS` set in symbol-tools.ts (~15 entries)
  - In `findDeadCode`, for Kotlin symbols, scan symbol source (or annotations field if extracted)
    for any whitelisted annotation before including in results
  - Extend existing framework-aware mechanism (there's already one for React hooks / Next.js routes)
- [ ] Verify: `npx vitest run tests/tools/symbol-tools.test.ts`
  Then real-project verification: reindex tgmdev-tgm-panel-mobilapp, run `find_dead_code`,
  confirm count drops from ~100 to <20
- [ ] Acceptance: dead code false positives reduced by 80%+ on Android Kotlin projects
- [ ] Commit: `feat(kotlin): whitelist DI/Compose/Room annotations in find_dead_code`

---

### Phase B — Parser Extensions (Tasks 4-6)

### Task 4: Kotest DSL test detection
**Files:** `src/parser/extractors/kotlin.ts`, `tests/parser/kotlin-extractor.test.ts`
**Complexity:** complex
**Dependencies:** none

Extend Kotlin extractor to recognize Kotest test specs. Kotest uses class inheritance from
FunSpec/DescribeSpec/StringSpec/BehaviorSpec with DSL block arguments containing `test("name")`,
`describe("name")`, `context("name")`, `should("name")`, `it("name")` calls.

- [ ] RED: Test cases for each Kotest style:
  - `class UserSpec : FunSpec({ test("validates email") { } })` → class=test_suite, "validates email"=test_case
  - `class UserSpec : DescribeSpec({ describe("User") { it("has name") { } } })` → nested test_case
  - `class UserSpec : StringSpec({ "validates email" { } })` → test_case
  - `class UserSpec : BehaviorSpec({ given("user") { when("login") { then("succeeds") { } } } })` → test_case
- [ ] GREEN:
  - Add `KOTEST_SPEC_CLASSES` set: `{"FunSpec", "DescribeSpec", "StringSpec", "BehaviorSpec", "ShouldSpec", "WordSpec", "FeatureSpec", "ExpectSpec", "AnnotationSpec"}`
  - In `class_declaration` case, check `delegation_specifiers` for Kotest superclass
  - If match, set class kind to `test_suite` (instead of `class`)
  - Walk constructor argument lambda body, recognize call expressions: `test`, `describe`,
    `context`, `should`, `it`, `given`, `when`, `then`, `feature`, `scenario`, `expect`
  - Each matching call → `test_case` symbol with parent = the spec class
- [ ] Verify: `npx vitest run tests/parser/kotlin-extractor.test.ts`
  Expected: all 31 existing + ~10 new Kotest tests pass
- [ ] Acceptance: Kotest specs detected alongside JUnit @Test; covers 30% of Kotlin test ecosystem
- [ ] Commit: `feat(kotlin): detect Kotest DSL specs (FunSpec, DescribeSpec, StringSpec, BehaviorSpec)`

---

### Task 5: Gradle KTS structured config extraction
**Files:** `src/parser/extractors/gradle-kts.ts` (new), `src/parser/parser-manager.ts`, `src/parser/symbol-extractor.ts`, `tests/parser/gradle-kts-extractor.test.ts` (new)
**Complexity:** complex
**Dependencies:** none

`.gradle.kts` files are currently parsed as plain Kotlin, so we see function calls but not
structured config. Add dedicated extractor that recognizes Gradle DSL blocks.

- [ ] RED: Test extraction from sample `build.gradle.kts`:
  ```kotlin
  plugins {
      kotlin("jvm") version "1.9.0"
      id("com.android.application")
  }
  dependencies {
      implementation("io.ktor:ktor-server:2.3.0")
      testImplementation("org.jetbrains.kotlin:kotlin-test")
  }
  android { namespace = "com.example" }
  ```
  Assert symbols: `plugin:kotlin-jvm@1.9.0`, `plugin:com.android.application`,
  `dependency:io.ktor:ktor-server:2.3.0`, `config:android.namespace`
- [ ] GREEN:
  - Create `gradle-kts.ts` extractor — uses `kotlin` tree-sitter parser but different symbol emission
  - Walk root-level `call_expression` nodes matching `plugins`, `dependencies`, `android`, `kotlin`, `java`, `buildscript`
  - Extract nested `call_expression` or string literals as `plugin`/`dependency`/`config` symbols
  - Map `.gradle.kts` → `"gradle-kts"` language in parser-manager.ts
  - Add case `"gradle-kts"` to symbol-extractor.ts → calls extractGradleKtsSymbols
  - Define new symbol kinds in types.ts: `"plugin"`, `"dependency"` (or reuse existing `"variable"` with kind metadata)
- [ ] Verify: `npx vitest run tests/parser/gradle-kts-extractor.test.ts`
- [ ] Acceptance: `analyze_project` can extract tech stack from build.gradle.kts
- [ ] Commit: `feat(gradle-kts): structured config extraction (plugins, dependencies, android block)`

---

### Task 6: Kotest DSL pattern detection (anti-patterns)
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 4 (needs Kotest detection for context)

Add Kotest-specific anti-patterns that JUnit-focused patterns miss:
- `kotest-missing-assertion` — `test { }` block without any `shouldBe`/`should`/`assertSoftly`
- `kotest-mixed-styles` — FunSpec and DescribeSpec classes in the same file (inconsistent)

- [ ] RED: Test each new pattern finds expected matches
- [ ] GREEN: Add two new entries to `BUILTIN_PATTERNS` in pattern-tools.ts
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts`
- [ ] Acceptance: Kotest-specific quality checks
- [ ] Commit: `feat(kotlin): Kotest anti-pattern detectors`

---

### Phase C — Hilt DI Graph (Tasks 7-8)

### Task 7: Hilt annotation index + dependency graph builder
**Files:** `src/tools/hilt-tools.ts` (new), `tests/tools/hilt-tools.test.ts` (new)
**Complexity:** complex
**Dependencies:** Task 3 (dead code whitelist — they share annotation logic)

Build a DI graph from indexed symbols. For each class annotated with `@HiltViewModel`,
`@HiltAndroidApp`, or `@AndroidEntryPoint`, scan constructor params for `@Inject` parameters,
then find matching `@Provides`/`@Binds` methods in `@Module`-annotated classes.

- [ ] RED: Test `buildHiltGraph(repo)` with fixtures:
  - `@HiltViewModel class UserViewModel @Inject constructor(repo: UserRepository)`
  - `@Module object RepositoryModule { @Provides fun provideUserRepo(): UserRepository = ... }`
  - Expected: graph has edge `UserViewModel → UserRepository → provideUserRepo@RepositoryModule`
- [ ] GREEN:
  - `buildHiltGraph(repo)` scans indexed symbols for Hilt annotations
  - For each `@HiltViewModel`, parse constructor parameter types
  - For each `@Module`, collect `@Provides`/`@Binds` methods with return types
  - Match dependencies by type name → provider method
  - Return `HiltGraphResult { view_models: [], modules: [], edges: [] }`
- [ ] Verify: `npx vitest run tests/tools/hilt-tools.test.ts`
- [ ] Commit: `feat(kotlin): Hilt DI graph builder`

---

### Task 8: trace_hilt_graph tool
**Files:** `src/tools/hilt-tools.ts`, `src/register-tools.ts`, `tests/tools/hilt-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 7

Expose Hilt graph as a discoverable MCP tool. Given a class name, return the DI tree
rooted at that class (dependencies + providers) up to configurable depth.

- [ ] RED: Test `traceHiltGraph(repo, "UserViewModel")` returns structure with:
  - `root: { name: "UserViewModel", kind: "HiltViewModel" }`
  - `dependencies: [{ name: "UserRepository", provided_by: "provideUserRepo", module: "RepositoryModule" }]`
  - `depth: 1`
- [ ] GREEN:
  - Export `traceHiltGraph(repo, class_name, options?)` in hilt-tools.ts
  - Call `buildHiltGraph`, walk edges from root to specified depth
  - Register as discoverable tool in register-tools.ts
  - Add to `FRAMEWORK_TOOL_GROUPS["build.gradle.kts"]` for auto-enable
- [ ] Verify: `npx vitest run tests/tools/hilt-tools.test.ts`
- [ ] Acceptance: agent can trace DI for any Hilt class without reading multiple files
- [ ] Commit: `feat(kotlin): trace_hilt_graph tool for Hilt DI traversal`

---

### Phase D — Coroutine Tracing (Tasks 9-10)

### Task 9: Suspend chain detection with dispatcher analysis
**Files:** `src/tools/kotlin-tools.ts`, `tests/tools/kotlin-tools.test.ts`
**Complexity:** complex
**Dependencies:** none

Extend kotlin-tools.ts with `traceSuspendChain(function_name, depth)`. Uses existing
`buildAdjacencyIndex` from graph-tools, filters to suspend-only nodes, scans source for
`withContext(Dispatchers.X)` transitions and blocking anti-patterns.

- [ ] RED: Test cases:
  - `traceSuspendChain("fetchUser")` with fixture chain `fetchUser → withContext(IO) → dbCall`
    → returns `{ root: "fetchUser", dispatchers: ["Dispatchers.IO"], warnings: [] }`
  - Fixture with `runBlocking` in suspend → warning `"runBlocking in suspend context: fn_name"`
  - Fixture with `Thread.sleep` in suspend → warning `"blocking call Thread.sleep in suspend"`
  - Fixture with `while(true) { }` loop in suspend without `ensureActive()` → warning
  - Non-suspend functions excluded from chain
- [ ] GREEN:
  - `traceSuspendChain(repo, functionName, options?)` function
  - Filter: only include symbols where `signature?.includes("suspend")`
  - Regex scan source: `/withContext\s*\(\s*Dispatchers\.(\w+)\s*\)/g` → dispatcher transitions
  - Detect anti-patterns: `runBlocking\s*{`, `Thread\.sleep\(`, `while\s*\(true\)` without `ensureActive`/`isActive`
  - Return `{ root, chain: [...], dispatcher_transitions: [...], warnings: [...] }`
- [ ] Verify: `npx vitest run tests/tools/kotlin-tools.test.ts`
- [ ] Commit: `feat(kotlin): suspend chain detection with dispatcher + blocking analysis`

---

### Task 10: trace_suspend_chain tool registration
**Files:** `src/register-tools.ts`, `tests/tools/kotlin-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 9

- [ ] RED: (integration test — ensure registered tool is callable via MCP surface)
- [ ] GREEN: Add tool definition for `trace_suspend_chain` with params `repo`, `function_name`,
  `depth` (default 3). Register as discoverable, add to `FRAMEWORK_TOOL_GROUPS` auto-load.
- [ ] Verify: `npx vitest run tests/tools/kotlin-tools.test.ts`
- [ ] Acceptance: new discoverable tool, auto-enabled in Kotlin projects
- [ ] Commit: `feat(kotlin): register trace_suspend_chain as discoverable tool`

---

### Phase E — KMP expect/actual (Tasks 11-12)

### Task 11: Source set detection + expect/actual indexing
**Files:** `src/tools/kotlin-tools.ts`, `tests/tools/kotlin-tools.test.ts`
**Complexity:** complex
**Dependencies:** none

Parse source set from file path. Index symbols tagged with `expect` or `actual` modifier
(requires extractor to surface these — check current state, may need to extend kotlin.ts).

- [ ] RED: Test cases:
  - Symbol at `src/commonMain/kotlin/Foo.kt` with `expect class Foo` → source_set=commonMain, modifier=expect
  - Symbol at `src/androidMain/kotlin/Foo.kt` with `actual class Foo { ... }` → source_set=androidMain, modifier=actual
  - Matching: commonMain expect + androidMain actual → pair
  - commonMain expect without any actual → missing_actuals: ["androidMain", "iosMain", ...]
  - androidMain actual without commonMain expect → orphan
- [ ] GREEN:
  - Extend `kotlin.ts` extractor to surface `expect`/`actual` modifiers in symbol metadata (`meta.kmp_modifier`)
  - In `kotlin-tools.ts`, add helper `parseSourceSet(filePath)` — regex `src/(\w+)Main/kotlin/` → "common"/"android"/"ios"/"jvm"/"js"
  - Index by name: group symbols with same simple name, split into expects and actuals, compute pairs
- [ ] Verify: `npx vitest run tests/parser/kotlin-extractor.test.ts tests/tools/kotlin-tools.test.ts`
- [ ] Commit: `feat(kotlin): KMP source set detection + expect/actual indexing`

---

### Task 12: analyze_kmp_declarations tool
**Files:** `src/tools/kotlin-tools.ts`, `src/register-tools.ts`, `tests/tools/kotlin-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 11

Expose KMP analysis as a discoverable tool. Report matching, missing, and orphan declarations.

- [ ] RED: Test `analyzeKmpDeclarations(repo)` returns:
  ```
  {
    total_expects: 5,
    fully_matched: 3,
    missing_actuals: [
      { name: "Platform", source_set: "commonMain", missing_from: ["iosMain"] }
    ],
    orphan_actuals: [
      { name: "Logger", source_set: "androidMain" }
    ]
  }
  ```
- [ ] GREEN:
  - `analyzeKmpDeclarations(repo, options?)` in kotlin-tools.ts
  - Filter index to KMP-tagged symbols (from Task 11)
  - Discover available source sets from indexed file paths
  - For each expect, check every available source set for actual with matching name
  - Register as discoverable tool, add to auto-load group
- [ ] Verify: `npx vitest run tests/tools/kotlin-tools.test.ts`
- [ ] Acceptance: KMP projects get automatic expect/actual validation
- [ ] Commit: `feat(kotlin): analyze_kmp_declarations tool for KMP expect/actual matching`

---

### Phase F — Integration + Documentation (Tasks 13-14)

### Task 13: Real-project verification suite
**Files:** `tests/integration/kotlin-wave-2.test.ts` (new)
**Complexity:** standard
**Dependencies:** Tasks 1-12

Regression test that exercises all new tools on a synthetic Kotlin fixture mirroring real
Android project structure (Hilt, Compose, Kotest, KMP). Prevents future regressions.

- [ ] RED: Create fixture directory `tests/fixtures/kotlin-sample/` with minimal Android+KMP structure:
  - `build.gradle.kts` (plugins + dependencies)
  - `src/commonMain/kotlin/Platform.kt` (`expect class`)
  - `src/androidMain/kotlin/Platform.kt` (`actual class`)
  - `app/.../UserViewModel.kt` (@HiltViewModel + @Inject)
  - `app/.../RepositoryModule.kt` (@Module + @Provides)
  - `app/.../HomeScreen.kt` (@Composable + @Preview)
  - `app/.../UserSpec.kt` (Kotest FunSpec)
- [ ] GREEN: Write tests that:
  - Index fixture → verify symbol counts by kind
  - `find_dead_code` → 0 findings (all annotated)
  - Kotest spec → test_case symbols extracted
  - `trace_hilt_graph("UserViewModel")` → returns dependency tree
  - `analyze_kmp_declarations` → 1 matched pair, 0 missing, 0 orphan
- [ ] Verify: `npx vitest run tests/integration/kotlin-wave-2.test.ts`
- [ ] Acceptance: integration suite catches regressions across the 8 improvements
- [ ] Commit: `test(kotlin): integration suite for Wave 2 tools`

---

### Task 14: Documentation update
**Files:** `README.md`, `CLAUDE.md`, `docs/specs/2026-04-11-kotlin-wave-2-plan.md` (status update)
**Complexity:** standard
**Dependencies:** Tasks 1-13

- [ ] RED: N/A (documentation-only)
- [ ] GREEN:
  - README.md: add Kotest DSL, Hilt, KMP, coroutines to Kotlin support section
  - README.md: add new tools to MCP tool table (`trace_hilt_graph`, `trace_suspend_chain`,
    `analyze_kmp_declarations`)
  - README.md: add new anti-patterns to patterns table (Kotest + coroutine)
  - CLAUDE.md: bump tool count, update extractor list (add gradle-kts)
  - Update plan status to Approved after execution
- [ ] Verify: `grep -c "trace_hilt_graph" README.md` returns at least 1
- [ ] Commit: `docs(kotlin): Wave 2 — Hilt DI, Kotest, KMP, coroutines`

---

## Implementation Order (Dependency Graph)

```
Phase A (parallel — no dependencies):
  Task 1: Cache version invalidation   ─┐
  Task 2: H11 dynamic hint              ├── all independent, run in parallel
  Task 3: Dead code whitelist          ─┘

Phase B (parallel — no dependencies):
  Task 4: Kotest DSL detection      ─┐
  Task 5: Gradle KTS extractor      ─┤── parallel
  Task 6: Kotest anti-patterns ───────── needs Task 4

Phase C (sequential — same file):
  Task 7: Hilt graph builder ─── prerequisite
  Task 8: trace_hilt_graph tool ─ needs Task 7

Phase D (sequential — same file):
  Task 9:  Suspend chain detection ─── prerequisite
  Task 10: trace_suspend_chain tool ── needs Task 9

Phase E (sequential — same file):
  Task 11: Source set + expect/actual indexing
  Task 12: analyze_kmp_declarations tool ── needs Task 11

Phase F (final):
  Task 13: Integration test suite  ── needs all 1-12
  Task 14: Documentation          ── needs all 1-13
```

## Summary

| Phase | Tasks | Files changed | New tests | Value |
|-------|-------|--------------|-----------|-------|
| A     | 1-3   | 4 existing   | ~15       | Eliminate silent bugs + 80% dead code accuracy |
| B     | 4-6   | 2 existing + 1 new | ~18 | 30% test coverage unlocked, Gradle config extraction |
| C     | 7-8   | 1 new + 1 existing | ~10 | Unique Hilt DI graph (zero competition) |
| D     | 9-10  | 1 existing + 1 existing | ~8 | Coroutine tracing (zero competition) |
| E     | 11-12 | 2 existing   | ~8        | KMP expect/actual (fastest-growing segment) |
| F     | 13-14 | 1 new + 3 existing | ~5 | Regression coverage + visibility |
| **Total** | **14** | **6 new + 9 modified** | **~64** | **Full second-wave Kotlin support** |

**Estimated effort:** ~8-9 person-days if done sequentially, ~5 days with parallel phases A+B.
