# Implementation Plan: Full Kotlin Parser Support

**Spec:** (inline — approved in conversation)
**spec_id:** 2026-04-11-kotlin-parser
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 7
**Estimated complexity:** 4 standard + 3 complex

## Architecture Summary

- **1 new file:** `src/parser/extractors/kotlin.ts` (~250 lines) — Kotlin-specific AST extractor
- **1 new test file:** `tests/parser/kotlin-extractor.test.ts` (~350 lines)
- **4 modified files:** `scripts/download-wasm.ts`, `src/parser/parser-manager.ts`, `src/parser/symbol-extractor.ts`, `src/lsp/lsp-servers.ts`
- **1 binary:** `src/parser/languages/tree-sitter-kotlin.wasm` (3.4MB from @tree-sitter-grammars/tree-sitter-kotlin)
- **Pattern:** Follows Go extractor (`go.ts`) — tree-sitter AST walk with `makeSymbol()` helper

## Technical Decisions

1. **WASM source:** `@tree-sitter-grammars/tree-sitter-kotlin` v1.1.0 (the non-scoped `tree-sitter-kotlin` 0.3.8 does NOT ship WASM)
2. **Extractor pattern:** Follow `go.ts` — recursive walk, switch on node types, `makeSymbol()` helper from `_shared.ts`
3. **KDoc extraction:** Walk backward collecting `multiline_comment` nodes starting with `/**` (similar to Go's `//` comment collection)
4. **Test detection:** `@Test` annotation → `test_case`, `@BeforeEach`/`@AfterEach`/`@BeforeAll`/`@AfterAll` → `test_hook`
5. **Extension functions:** Include receiver type in signature: `fun String.toSlug(): String`
6. **Data class fields:** Primary constructor `val`/`var` params extracted as `field` children
7. **LSP:** `kotlin-language-server` — optional external dependency, gracefully degrades if absent
8. **`.gradle.kts`:** Keep as `text_stub` for now — different semantics than regular Kotlin

## Quality Strategy

- **Test framework:** Vitest (same as all parser tests)
- **Critical CQ gates:** CQ25 (follow existing extractor patterns), CQ14 (reuse _shared.ts helpers)
- **Test strategy:** Parse real Kotlin snippets, verify symbol count/names/kinds/signatures/docstrings
- **Verification:** `npx vitest run tests/parser/kotlin-extractor.test.ts`

## Task Breakdown

### Task 1: Download Kotlin WASM grammar
**Files:** `scripts/download-wasm.ts`, `src/parser/languages/tree-sitter-kotlin.wasm`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: N/A (infrastructure task — no test needed for download script modification)
- [ ] GREEN: Add `@tree-sitter-grammars/tree-sitter-kotlin` to GRAMMARS array in `scripts/download-wasm.ts`. Run `npx tsx scripts/download-wasm.ts` to download the WASM.
- [ ] Verify: `ls -la src/parser/languages/tree-sitter-kotlin.wasm` — file exists, ~3.4MB
- [ ] Commit: `feat(kotlin): add tree-sitter-kotlin WASM grammar`

---

### Task 2: Update extension map and symbol extractor wiring
**Files:** `src/parser/parser-manager.ts`, `src/parser/symbol-extractor.ts`
**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: In existing `parser-manager.test.ts`, verify `.kt` maps to `"kotlin"` (currently fails since it maps to `"text_stub"`). Verify `.kts` maps to `"kotlin"`.
- [ ] GREEN: Change `.kt` from `"text_stub"` to `"kotlin"` and `.kts` from `"text_stub"` to `"kotlin"` in `parser-manager.ts`. Add `import { extractKotlinSymbols }` and `case "kotlin": return extractKotlinSymbols(tree, filePath, source, repo);` to `symbol-extractor.ts`.
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts`
- [ ] Commit: `feat(kotlin): wire .kt/.kts to kotlin parser pipeline`

---

### Task 3: Kotlin extractor — functions, classes, interfaces
**Files:** `src/parser/extractors/kotlin.ts`, `tests/parser/kotlin-extractor.test.ts`
**Complexity:** complex
**Dependencies:** Task 2

- [ ] RED: Write tests for:
  1. `fun greet(name: String): String` → function with signature `(name: String): String`
  2. `class UserService` → class
  3. `data class User(val name: String, val age: Int)` → class with 2 field children
  4. `sealed class Result` → class
  5. `interface Repository` → interface
  6. `abstract class Base` → class
  7. `enum class Color { RED, GREEN, BLUE }` → class with 3 field children (enum entries)
  8. Method inside class → kind=method with parent reference
  9. KDoc `/** Returns user by ID */` extracted as docstring

- [ ] GREEN: Create `src/parser/extractors/kotlin.ts` with:
  - `extractKotlinSymbols(tree, filePath, source, repo)` — main export
  - `getDocstring(node, source)` — collect `multiline_comment` (`/** ... */`) preceding node
  - `getSignature(node, source)` — extract parameter list + return type
  - Handle: `function_declaration`, `class_declaration` (with modifier inspection for data/sealed/enum/abstract/annotation), methods as `function_declaration` inside class body
  - Use `makeSymbol()`, `getNodeName()`, `extractNodeSource()` from `_shared.ts`

- [ ] Verify: `npx vitest run tests/parser/kotlin-extractor.test.ts`
- [ ] Commit: `feat(kotlin): extractor for functions, classes, interfaces, enums`

---

### Task 4: Kotlin extractor — objects, properties, type aliases
**Files:** `src/parser/extractors/kotlin.ts`, `tests/parser/kotlin-extractor.test.ts`
**Complexity:** complex
**Dependencies:** Task 3

- [ ] RED: Write tests for:
  1. `object Singleton` → class
  2. `companion object { fun create() }` → class child with method child
  3. Top-level `val config = ...` → variable
  4. Class-level `val name: String` → field with parent
  5. `const val MAX_SIZE = 100` → constant
  6. `typealias StringMap = Map<String, String>` → type
  7. Nested class → class with parent reference

- [ ] GREEN: Add to kotlin.ts:
  - `object_declaration` → class
  - `companion_object` → class (child of enclosing class)
  - `property_declaration` → variable (top-level) or field (in class). `const` modifier → constant
  - `type_alias` → type

- [ ] Verify: `npx vitest run tests/parser/kotlin-extractor.test.ts`
- [ ] Commit: `feat(kotlin): extractor for objects, properties, type aliases`

---

### Task 5: Kotlin extractor — extension functions, suspend, generics, test detection
**Files:** `src/parser/extractors/kotlin.ts`, `tests/parser/kotlin-extractor.test.ts`
**Complexity:** complex
**Dependencies:** Task 4

- [ ] RED: Write tests for:
  1. `fun String.toSlug(): String` → function, signature includes `String.` receiver
  2. `suspend fun fetchData(): Data` → function, signature includes `suspend`
  3. `fun <T> identity(x: T): T` → function, generic in signature
  4. `@Test fun testLogin()` → test_case
  5. `@BeforeEach fun setup()` → test_hook
  6. `@AfterAll fun cleanup()` → test_hook
  7. Function without annotation in test file with `test` prefix → test_case
  8. `operator fun plus(other: T): T` → method

- [ ] GREEN: Add to kotlin.ts:
  - Extension function: detect receiver type from `user_type` node before function name, include in signature
  - Suspend: detect `suspend` in modifiers, prepend to signature
  - Test detection: check annotations for `@Test` → test_case, `@BeforeEach/@AfterEach/@BeforeAll/@AfterAll` → test_hook
  - Generics: include `type_parameters` node in signature

- [ ] Verify: `npx vitest run tests/parser/kotlin-extractor.test.ts`
- [ ] Commit: `feat(kotlin): extension functions, suspend, generics, test detection`

---

### Task 6: Add Kotlin LSP server config
**Files:** `src/lsp/lsp-servers.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: N/A (config-only change — LSP availability is runtime-checked)
- [ ] GREEN: Add to `LSP_SERVERS` in `lsp-servers.ts`:
  ```typescript
  kotlin: {
    command: "kotlin-language-server",
    args: [],
    languages: ["kotlin"],
  },
  ```
- [ ] Verify: `npx vitest run` — no regressions
- [ ] Commit: `feat(kotlin): add kotlin-language-server LSP config`

---

### Task 7: Integration verification and get_extractor_versions update
**Files:** (verification only + minor update)
**Complexity:** standard
**Dependencies:** Tasks 1-6

- [ ] RED: N/A (integration verification)
- [ ] GREEN: Update `get_extractor_versions` to include `"kotlin"` in parser_languages. Run full test suite.
- [ ] Verify: `npx vitest run` — all tests pass, no regressions
- [ ] Commit: `feat(kotlin): add kotlin to extractor versions`
