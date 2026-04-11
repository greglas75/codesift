# Implementation Plan: PHP/Yii2 Gaps — Priority 5

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 2
**status:** Completed
**Created:** 2026-04-11
**Implemented:** 2026-04-11
**Tasks:** 18 (all implemented and verified)
**Final test suite:** 1933/1933 passing (117 test files)
**Estimated complexity:** 12 standard, 6 complex

## Context

After validating PHP/Yii2 support on Mobi2 (Yii2 production app, 7596 PHP files), 5 gaps
surfaced that materially block intelligence quality. This plan closes all five via TDD.

**Gaps (priority order):**
1. Parser WASM crashes on ~20 files — lose symbols, break indexing mid-run
2. `*copy.php` backup files double the index on Mobi2 (7978 → ~4000 real files)
3. PSR-4 `use` statements don't create import edges — PHP is per-file, not cross-file
4. PHPDoc `@property`/`@method` invisible — Yii2 magic properties missing
5. No N+1 query detection or god-model checker — Survey.php has 175 methods

## Architecture Summary

**Component touches:**
- `src/parser/parser-manager.ts` — error recovery around `parser.parse()`
- `src/utils/walk.ts` — default backup-file exclusion
- `src/utils/import-graph.ts` — PHP branch in `collectImportEdges` that calls `resolvePhpNamespace`
- `src/parser/extractors/php.ts` — `parsePhpDocTags()` helper + synthesis in walk
- `src/tools/php-tools.ts` — two new tools `find_php_n_plus_one`, `find_php_god_model`
- `src/register-tools.ts` — register new tools, add to `FRAMEWORK_TOOL_GROUPS` for PHP auto-load

**Interfaces (new/changed):**
```typescript
// Gap 1
async function parseFile(filePath, source): Promise<Parser.Tree | null>  // now try/catch wrapped

// Gap 2
const BACKUP_FILE_PATTERNS: RegExp[];  // new export
interface WalkOptions { excludeBackupFiles?: boolean }  // default true

// Gap 3
// import-graph.ts gains:
import { resolvePhpNamespace } from "../tools/php-tools.js";
// PHP branch in collectImportEdges

// Gap 4
function parsePhpDocTags(docstring?: string): Array<{tag: "property"|"method", name: string, type?: string}>;
// synthetic symbols get meta: { synthetic: true }

// Gap 5
interface NPlusOneFinding { file, method, line, relation, pattern }
interface GodModelFinding { name, file, method_count, relation_count, line_count, reasons[] }
export async function findPhpNPlusOne(repo, opts?): Promise<{ findings: NPlusOneFinding[], total: number }>;
export async function findPhpGodModel(repo, opts?): Promise<{ models: GodModelFinding[], total: number }>;
```

**Dependency order:** Gap 1 (error recovery) → Gap 2 (exclusion) are independent.
Gap 3 (use edges) depends on `resolvePhpNamespace` (exists). Gap 4 is independent.
Gap 5 depends on `analyzeActiveRecord` (exists) for god-model counts.

## Technical Decisions

| Area | Decision | Reason |
|---|---|---|
| Error logging | `console.warn("[parser] Parse error in ${path}: ${msg}")` | Matches index-tools pattern |
| Backup exclusion | Default ON, env `CODESIFT_INCLUDE_BACKUPS=1` to disable | Safe default, CI-friendly opt-out |
| PSR-4 cache | Hoisted composer.json read once per `collectImportEdges` call | Avoids re-reading composer for every file |
| PHPDoc parser | Single regex (no tree-sitter-phpdoc) | Lightweight, ~85% coverage is enough |
| Synthetic dedup | Real method wins, synthetic skipped if name collides | Avoid duplicate find_references hits |
| N+1 detection | Regex on foreach body + relation access | Discovery tool, FPs acceptable |
| God-model thresholds | `{ min_methods: 50, min_relations: 15, min_lines: 500 }` configurable | Covers Survey.php at 175/30/?? |
| New tools registration | Hidden/discoverable + auto-loaded via `FRAMEWORK_TOOL_GROUPS[composer.json]` | Consistent with existing 7 PHP tools |

## Quality Strategy

**Test types:**
- Unit tests for `parsePhpDocTags`, backup file regex, N+1/god-model detection logic
- Integration tests for `parseFile` error path (use real malformed PHP), `collectImportEdges` PHP branch (real composer.json + PSR-4 fixture)

**Critical CQ gates:**
- CQ3 — validate composer.json structure before reading psr-4
- CQ8 — all parse errors caught (Gap 1's whole purpose)
- CQ11 — thresholds configurable, not hardcoded (Gap 5)
- CQ13 — synthetic symbols deduped against real (Gap 4)

**Critical Q gates:**
- Q7 — error paths tested (missing composer.json, malformed PHPDoc, unclosed PHP)
- Q8 — null/undefined inputs (empty docstring, missing parent symbol)
- Q11 — all branches covered (@property + @method, env var toggle, has/missing composer.json)
- Q15 — assertions verify content (synthetic symbol name+kind+parent+meta, edge from→to correctness)

**Risk areas:**
- Regex PHPDoc parser may miss edge cases (union types, generics) — acceptable for discovery tool
- N+1 regex has ~15% false positive rate on nested loops — document as known limitation
- PSR-4 resolution performance on large repos (Mobi2 has 5748 namespaces) — use cache

## Task Breakdown

### Task 1: Gap 1 RED — test for parser error recovery

**Files:** `tests/parser/parser-manager.test.ts` (create)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Write test in `tests/parser/parser-manager.test.ts`:
  - `describe("parseFile error recovery")`
  - Test 1: `parseFile("test.php", "<?php invalid {{{ syntax")` should NOT throw. Result can be either a Parser.Tree (tree-sitter error recovery) or null (on WASM abort). The key assertion is no uncaught exception.
  - Test 2: Mock `getParser` via `vi.mock` to return a parser whose `.parse()` throws `Error("Aborted()")`. Call `parseFile("test.php", "source")` — expect return `null` AND `console.warn` called with message containing `"test.php"` and `"Aborted"`.
  - Use `vi.spyOn(console, "warn")` in `beforeEach`, restore in `afterEach`.
- [ ] GREEN: Wrap `parser.parse(source)` in try/catch inside `parseFile` (src/parser/parser-manager.ts:102). On catch: `console.warn("[parser] Parse error in ${filePath}: ${err.message}")`, return `null`.
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts`
  Expected: `Tests  2 passed (2)`
- [ ] Acceptance: Parser crash no longer breaks indexing (Gap 1)
- [ ] Commit: `fix(parser): catch WASM parse errors in parseFile, log and return null`

---

### Task 2: Gap 1 integration test — real malformed PHP file

**Files:** `tests/fixtures/php-malformed/unclosed-class.php` (create), `tests/parser/parser-manager.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: Create fixture `tests/fixtures/php-malformed/unclosed-class.php` with:
  ```php
  <?php
  class Broken {
      public function foo() {
          return "no closing brace
  ```
  Add integration test: `parseFile(fixturePath, source)` on this content. Expect either a tree (tree-sitter error recovery) or null + console.warn. Test that no uncaught exception propagates.
- [ ] GREEN: Should already pass from Task 1's implementation. If tree-sitter returns a tree (with error nodes), still count as success — the goal is "no uncaught throw".
- [ ] Verify: `npx vitest run tests/parser/parser-manager.test.ts`
  Expected: `Tests  3 passed (3)`
- [ ] Acceptance: Real malformed PHP doesn't crash indexing
- [ ] Commit: `test(parser): add integration test for malformed PHP recovery`

---

### Task 3: Gap 2 RED — test for backup file exclusion in walk

**Files:** `tests/utils/walk-backup-exclusion.test.ts` (create)
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Write two tests. **Pattern-level unit test** (preferred, no filesystem):
  - Test A: `BACKUP_FILE_PATTERNS.some(re => re.test("Real copy.php"))` → true
  - Test A: `BACKUP_FILE_PATTERNS.some(re => re.test("User.php"))` → false
  - Test all 7 patterns: `*copy.php`, `*.bak`, `*.orig`, `*~`, `*.swp`, `*.swo`, `.DS_Store` each match, `User.php` doesn't.
  - **Integration test** (filesystem, one end-to-end case):
  - Test B: Creates tmp dir via `fs.mkdtempSync(join(tmpdir(), "walk-test-"))`, creates files: `Real.php`, `Real copy.php`, `config.bak`. Calls `walkDirectory(tmpDir)`. Asserts result is `[Real.php]` only.
  - Test C: Same tmpDir, set `process.env.CODESIFT_INCLUDE_BACKUPS = "1"`, call `walkDirectory(tmpDir)`, assert all 3 files returned.
  - Use `afterEach` to `delete process.env.CODESIFT_INCLUDE_BACKUPS` and `fs.rmSync(tmpDir, {recursive: true, force: true})`.
- [ ] GREEN: In `src/utils/walk.ts`:
  - Add `export const BACKUP_FILE_PATTERNS: RegExp[] = [/copy\.php$/i, /\.bak$/i, /\.orig$/i, /~$/, /\.swp$/i, /\.swo$/i, /\.DS_Store$/]`
  - In `walkDirectory` file loop (near the size/filter check), add:
    ```typescript
    if (process.env.CODESIFT_INCLUDE_BACKUPS !== "1" &&
        BACKUP_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
    ```
- [ ] Verify: `npx vitest run tests/utils/walk-backup-exclusion.test.ts`
  Expected: pattern tests + fs integration tests all pass
- [ ] Acceptance: Backup files auto-excluded by default at walk level (Gap 2 — unit level; end-to-end impact verified in Task 4)
- [ ] Commit: `feat(walk): auto-exclude backup files (*copy.php, *.bak, *.orig, *~, *.swp, .DS_Store)`

---

### Task 4: Gap 2 verify on Mobi2 — count reduction

**Files:** none (manual verification)
**Complexity:** standard
**Dependencies:** Task 3

- [ ] RED: N/A (verification task)
- [ ] GREEN: N/A
- [ ] Verify: `node -e "const {indexFolder, invalidateCache} = require('./dist/tools/index-tools.js'); (async () => { await invalidateCache('local/Mobi2'); const r = await indexFolder('/Users/greglas/DEV/Mobi2', {}); console.log(r.file_count, r.symbol_count); })().catch(e=>console.error(e))"`
  Expected: file_count drops from ~7978 to ~4000 (copy files excluded). Document numbers in commit message.
- [ ] Acceptance: Mobi2 index is ~50% smaller (Gap 2 impact)
- [ ] Commit: `chore(verify): Mobi2 index drops from 7978 to N files after backup exclusion`

---

### Task 5: Gap 3 RED — test for PSR-4 use statement → edge

**Files:** `tests/utils/import-graph-php.test.ts` (create), `tests/fixtures/php-psr4/composer.json`, `tests/fixtures/php-psr4/src/Models/User.php`, `tests/fixtures/php-psr4/src/Controllers/PostController.php` (create)
**Complexity:** complex
**Dependencies:** none (gaps 1-2 don't block this)

- [ ] RED: Write test that:
  - Creates fixture composer.json: `{"autoload": {"psr-4": {"App\\": "src/"}}}`
  - Creates `src/Models/User.php`: `<?php namespace App\Models; class User {}`
  - Creates `src/Controllers/PostController.php`: `<?php namespace App\Controllers; use App\Models\User; class PostController {}`
  - Mocks CodeIndex with both files
  - Calls `collectImportEdges(index)`
  - Asserts edges array contains `{from: "src/Controllers/PostController.php", to: "src/Models/User.php"}`
- [ ] GREEN: In `src/utils/import-graph.ts`:
  - **Note:** `extractPhpUseStatements` already exists in import-graph.ts (line 93) — no need to create. Similarly verified: `src/tools/php-tools.ts` does NOT import from import-graph.ts → no circular dep risk when importing `resolvePhpNamespace`.
  - Add import at top: `import { resolvePhpNamespace } from "../tools/php-tools.js"`
  - Hoist PSR-4 cache: before file loop, read composer.json once via `readJsonSafe(join(index.root, "composer.json"))` into local const
  - In file loop, after existing JS/Kotlin branches, add PHP branch:
    ```typescript
    if (file.path.endsWith(".php")) {
      const uses = extractPhpUseStatements(source);
      for (const fqcn of uses) {
        const resolved = await resolvePhpNamespace(index.repo, fqcn);
        if (resolved.exists && resolved.file_path) {
          const targetFile = normalizedPaths.get(resolved.file_path.replace(/\.php$/, "")) ?? resolved.file_path;
          if (targetFile && targetFile !== file.path) {
            addEdge(file.path, targetFile);
          }
        }
      }
    }
    ```
- [ ] Verify: `npx vitest run tests/utils/import-graph-php.test.ts`
  Expected: `Tests  1 passed (1)` with the edge assertion green
- [ ] Acceptance: `use App\Models\User` creates `PostController → User` edge (Gap 3)
- [ ] Commit: `feat(import-graph): resolve PHP use statements via PSR-4 to create cross-file edges`

---

### Task 6: Gap 3 edge case — missing composer.json, vendor skip

**Files:** `tests/utils/import-graph-php.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 5

- [ ] RED: Add two tests:
  - Test: repo without composer.json → `collectImportEdges` returns edges from non-PHP files only, no errors thrown for PHP files
  - Test: `use Vendor\Package\Class` (vendor FQCN not in PSR-4 map) → no edge added, no crash
- [ ] GREEN: Existing code should handle both via `resolved.exists === false` short-circuit. If missing composer.json causes `resolvePhpNamespace` to throw, wrap the call in try/catch and treat as no-edge.
- [ ] Verify: `npx vitest run tests/utils/import-graph-php.test.ts`
  Expected: `Tests  3 passed (3)`
- [ ] Acceptance: Graceful handling of missing composer.json and vendor imports
- [ ] Commit: `test(import-graph): verify PHP import edge handling for missing composer.json and vendor paths`

---

### Task 7: Gap 4 RED — test for parsePhpDocTags

**Files:** `tests/parser/php-phpdoc-tags.test.ts` (create)
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Write unit tests for new exported helper `parsePhpDocTags(docstring)`:
  - Test: `"/** @property int $id */"` → `[{tag: "property", name: "id", type: "int"}]`
  - Test: `"/** @property string $name\n * @property Profile $profile */"` → 2 entries
  - Test: `"/** @method getPosts() */"` → `[{tag: "method", name: "getPosts", type: undefined}]`
  - Test: `"/** @method ActiveQuery getUser(int $id) */"` → `[{tag: "method", name: "getUser", type: "ActiveQuery"}]`
  - Test: `parsePhpDocTags(undefined)` → `[]`
  - Test: `parsePhpDocTags("")` → `[]`
  - Test: mixed tags, order preserved
- [ ] GREEN: In `src/parser/extractors/php.ts`:
  - Export new function:
    ```typescript
    export function parsePhpDocTags(docstring?: string): Array<{tag: "property" | "method", name: string, type?: string}> {
      if (!docstring) return [];
      const results: Array<{tag: "property" | "method", name: string, type?: string}> = [];
      const propRe = /@property\s+(\S+)\s+\$(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = propRe.exec(docstring)) !== null) {
        results.push({ tag: "property", name: m[2]!, type: m[1] });
      }
      const methodRe = /@method\s+(?:(\S+)\s+)?(\w+)\s*\(/g;
      while ((m = methodRe.exec(docstring)) !== null) {
        results.push({ tag: "method", name: m[2]!, type: m[1] });
      }
      return results;
    }
    ```
- [ ] Verify: `npx vitest run tests/parser/php-phpdoc-tags.test.ts`
  Expected: `Tests  7 passed (7)`
- [ ] Acceptance: parsePhpDocTags correctly extracts @property/@method (Gap 4 half done)
- [ ] Commit: `feat(php-extractor): add parsePhpDocTags helper for @property/@method extraction`

---

### Task 8: Gap 4 RED — synthetic symbols in extractPhpSymbols

**Files:** `tests/parser/php-extractor.test.ts` (extend), `src/types.ts` (add optional field)
**Complexity:** complex
**Dependencies:** Task 7

- [ ] RED: Add test to php-extractor.test.ts:
  - Parse PHP source:
    ```php
    <?php
    /**
     * @property int $id
     * @property string $email
     * @method ActiveQuery getPosts()
     */
    class User {
        public function realMethod() {}
    }
    ```
  - Assert symbols include `User` (class) + `realMethod` (method, not synthetic) + synthetic `$id` (field) + `$email` (field) + `getPosts` (method, synthetic)
  - Assert synthetic symbols have `meta.synthetic === true` and `parent === User.id`
- [ ] GREEN:
  - In `src/types.ts`, add optional field to CodeSymbol (if not exists): `meta?: Record<string, unknown>`
  - In `src/parser/extractors/php.ts`, in the `class_declaration` case: **walk body FIRST, then process docstring AFTER** so real methods are already in `symbols` when dedup runs:
    ```typescript
    // 1. push class symbol
    symbols.push(sym);
    // 2. walk class body FIRST — real methods get pushed
    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) walk(child, sym.id, isTest);
    }
    // 3. NOW parse docstring for synthetic symbols (real members already in array)
    const docstring = getDocstring(node, source);
    if (docstring) {
      const tags = parsePhpDocTags(docstring);
      for (const tag of tags) {
        const targetKind: SymbolKind = tag.tag === "property" ? "field" : "method";
        // dedup: real member with same name + kind + parent already exists?
        const realExists = symbols.some(s =>
          s.parent === sym.id && s.name === tag.name && s.kind === targetKind && !s.meta?.synthetic
        );
        if (realExists) continue;
        const synthetic = makeSymbol(node, tag.name, targetKind, filePath, source, repo, {
          parentId: sym.id,
          ...(tag.type ? { signature: tag.type } : {}),
        });
        synthetic.meta = { synthetic: true };
        symbols.push(synthetic);
      }
    }
    return; // don't fall through to generic walk
    ```
- [ ] Verify: `npx vitest run tests/parser/php-extractor.test.ts`
  Expected: `Tests  17 passed (17)` (was 16, +1 new synthetic test)
- [ ] Acceptance: @property/@method appear as synthetic symbols (Gap 4 complete)
- [ ] Commit: `feat(php-extractor): synthesize @property/@method symbols with meta.synthetic flag`

---

### Task 9: Gap 4 dedup verification — real method wins

**Files:** `tests/parser/php-extractor.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 8

- [ ] RED: Add test — PHP class with both `@method getPosts()` in docblock AND real `public function getPosts() {}` in body. Expect only ONE `getPosts` symbol, with `meta.synthetic` undefined (real wins). Assert `symbols.filter(s => s.name === "getPosts").length === 1`.
- [ ] GREEN: Either restructure walk order (walk body first, then process docstring for non-collisions) OR post-process `symbols` array at end of walk: filter out synthetic symbols whose name+parent collides with a real one.
- [ ] Verify: `npx vitest run tests/parser/php-extractor.test.ts`
  Expected: `Tests  18 passed (18)`
- [ ] Acceptance: Dedup logic prevents synthetic duplicates
- [ ] Commit: `fix(php-extractor): dedup synthetic symbols when real method exists`

---

### Task 10: Gap 5a RED — find_php_n_plus_one test

**Files:** `tests/tools/php-nplus1.test.ts` (create), `tests/fixtures/php-n-plus-one/` (create)
**Complexity:** complex
**Dependencies:** none (gaps 1-4 don't block)

- [ ] RED: Create fixture files:
  - `tests/fixtures/php-n-plus-one/BadController.php`:
    ```php
    <?php
    class BadController {
        public function actionIndex() {
            $users = User::find()->all();
            foreach ($users as $user) {
                echo $user->profile->name; // N+1!
            }
        }
    }
    ```
  - `tests/fixtures/php-n-plus-one/GoodController.php`:
    ```php
    <?php
    class GoodController {
        public function actionIndex() {
            $users = User::find()->with('profile')->all();
            foreach ($users as $user) {
                echo $user->profile->name; // OK, eager loaded
            }
        }
    }
    ```
  - Add a third fixture `tests/fixtures/php-n-plus-one/ScalarAccess.php`:
    ```php
    <?php
    class ScalarAccess {
        public function actionIndex() {
            $users = User::find()->all();
            foreach ($users as $user) {
                echo $user->id; // scalar — NOT a relation, should not be flagged
                echo $user->name;
            }
        }
    }
    ```
  - Test: index fixture dir, call `findPhpNPlusOne(repo)`:
    - BadController: 1 finding, method `actionIndex`, relation `profile`
    - GoodController: 0 findings (has `->with('profile')`)
    - ScalarAccess: 0 findings (id/name are common scalar field names in SCALAR_FIELD_NAMES allowlist)
- [ ] GREEN: In `src/tools/php-tools.ts`, add new function. Filter out common scalar field names to reduce false positives:
  ```typescript
  // Common ActiveRecord scalar fields — access is not a N+1 risk
  const SCALAR_FIELD_NAMES = new Set([
    "id", "name", "title", "created_at", "updated_at", "deleted_at", "status",
    "email", "slug", "code", "type", "value", "label", "description", "enabled",
    "active", "position", "sort", "order", "count", "total", "amount", "price",
  ]);

  export interface NPlusOneFinding { file: string; method: string; line: number; relation: string; pattern: string; }
  export async function findPhpNPlusOne(repo: string, opts?: { limit?: number }): Promise<{ findings: NPlusOneFinding[]; total: number }> {
    const index = await getCodeIndex(repo);
    if (!index) throw new Error(`Repository "${repo}" not found.`);
    const findings: NPlusOneFinding[] = [];
    const limit = opts?.limit ?? 100;
    // Walk PHP methods
    for (const sym of index.symbols) {
      if (sym.kind !== "method" || !sym.file.endsWith(".php") || !sym.source) continue;
      // Find foreach ... as $var
      const foreachRe = /foreach\s*\(\s*\$(\w+)\s+as\s+\$(\w+)\s*\)/g;
      let fm: RegExpExecArray | null;
      while ((fm = foreachRe.exec(sym.source)) !== null) {
        const collectionVar = fm[1]!;
        const itemVar = fm[2]!;
        // Look in subsequent lines for $itemVar->relation
        const after = sym.source.slice(fm.index);
        const relRe = new RegExp(`\\$${itemVar}->(\\w+)(?!\\()`, "g");
        const relMatch = relRe.exec(after);
        if (!relMatch) continue;
        const relation = relMatch[1]!;
        // Skip common scalar field names (not relations)
        if (SCALAR_FIELD_NAMES.has(relation.toLowerCase())) continue;
        // Check if source earlier has ->with('relation') for same collection
        const hasWith = new RegExp(`\\bwith\\s*\\(\\s*['"]${relation}['"]`).test(sym.source.slice(0, fm.index));
        if (!hasWith) {
          const lineOffset = sym.source.slice(0, fm.index).split("\n").length - 1;
          findings.push({ file: sym.file, method: sym.name, line: sym.start_line + lineOffset, relation, pattern: "foreach-access-without-with" });
          if (findings.length >= limit) return { findings, total: findings.length };
        }
      }
    }
    return { findings, total: findings.length };
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/php-nplus1.test.ts`
  Expected: `Tests  1 passed (1)` with 1 finding in BadController, 0 in GoodController
- [ ] Acceptance: N+1 pattern detected in foreach + relation access without `with()` (Gap 5a)
- [ ] Commit: `feat(php): add find_php_n_plus_one tool — detects foreach+relation without eager loading`

---

### Task 11: Gap 5a edge cases — nested loops, methods vs properties

**Files:** `tests/tools/php-nplus1.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 10

- [ ] RED: Add edge case tests:
  - Nested foreach — only outer flagged if applicable
  - `$user->getProfile()` (method call) — should NOT be flagged (only property access)
  - `$user->id` (scalar field, not relation) — acceptable FPs OK, but test that common properties like `id`, `name` don't spam
  - Method with `->with('profile')` earlier in same method → not flagged
- [ ] GREEN: Refine regex if needed. Accept that the tool is a "discovery" (flagged for review), not a gate.
- [ ] Verify: `npx vitest run tests/tools/php-nplus1.test.ts`
  Expected: `Tests  5 passed (5)`
- [ ] Acceptance: Known false-positive cases documented, scalar access not flagged
- [ ] Commit: `test(php): n+1 detector handles nested loops, method calls, scalar fields`

---

### Task 12: Gap 5b RED — find_php_god_model test

**Files:** `tests/tools/php-god-model.test.ts` (create)
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Write test using mocked index with fake models:
  - Model A: 60 methods, 5 relations, 400 lines → FLAG (methods > 50)
  - Model B: 20 methods, 20 relations, 300 lines → FLAG (relations > 15)
  - Model C: 30 methods, 5 relations, 600 lines → FLAG (lines > 500)
  - Model D: 20 methods, 5 relations, 300 lines → OK
  - Test custom thresholds: `findPhpGodModel(repo, { min_methods: 10 })` → A and D both flagged
- [ ] GREEN: In `src/tools/php-tools.ts` — compute line_count from symbol index in one pass:
  ```typescript
  export interface GodModelFinding { name: string; file: string; method_count: number; relation_count: number; line_count: number; reasons: string[]; }
  export async function findPhpGodModel(repo: string, opts?: { min_methods?: number; min_relations?: number; min_lines?: number }): Promise<{ models: GodModelFinding[]; total: number }> {
    const index = await getCodeIndex(repo);
    if (!index) throw new Error(`Repository "${repo}" not found.`);
    const ar = await analyzeActiveRecord(repo);
    const minM = opts?.min_methods ?? 50;
    const minR = opts?.min_relations ?? 15;
    const minL = opts?.min_lines ?? 500;
    const models: GodModelFinding[] = [];
    for (const m of ar.models) {
      // Look up class symbol for accurate line count
      const classSym = index.symbols.find(s => s.name === m.name && s.kind === "class" && s.file === m.file);
      const lineCount = classSym ? classSym.end_line - classSym.start_line : 0;
      const reasons: string[] = [];
      if (m.methods.length > minM) reasons.push(`methods: ${m.methods.length} > ${minM}`);
      if (m.relations.length > minR) reasons.push(`relations: ${m.relations.length} > ${minR}`);
      if (lineCount > minL) reasons.push(`lines: ${lineCount} > ${minL}`);
      if (reasons.length > 0) {
        models.push({ name: m.name, file: m.file, method_count: m.methods.length, relation_count: m.relations.length, line_count: lineCount, reasons });
      }
    }
    return { models, total: models.length };
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/php-god-model.test.ts`
  Expected: `Tests  2 passed (2)`
- [ ] Acceptance: God models flagged with reasons array (Gap 5b)
- [ ] Commit: `feat(php): add find_php_god_model tool — flags oversized AR models`

---

### Task 13: Gap 5b dedup — multiple classes same name

**Files:** `src/tools/php-tools.ts` (extend), `tests/tools/php-god-model.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 12

- [ ] RED: Add test: mock index with two `Survey` classes (different files — same issue Mobi2 had with `*copy.php` duplicates). Assert each is reported separately with its own `file` path, not deduped/merged.
- [ ] GREEN: Current implementation already filters by `s.file === m.file`, so each model with unique file path reports separately. Verify in test.
- [ ] Verify: `npx vitest run tests/tools/php-god-model.test.ts`
  Expected: `Tests  3 passed (3)` — both Survey instances flagged independently
- [ ] Acceptance: Duplicate classes in different files reported separately
- [ ] Commit: `test(php): god model handles duplicate class names in different files`

---

### Task 14: Register new tools

**Files:** `src/register-tools.ts` (extend), `tests/tools/php-tools.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Tasks 10, 12

- [ ] RED: Extend `tests/tools/php-tools.test.ts`:
  - Test: module exports `findPhpNPlusOne` and `findPhpGodModel`
  - Test: `FRAMEWORK_TOOL_GROUPS["composer.json"]` array (in register-tools.ts source read) contains `"find_php_n_plus_one"` and `"find_php_god_model"` — 9 tools total
- [ ] GREEN:
  - In `src/register-tools.ts`, add to `FRAMEWORK_TOOL_GROUPS["composer.json"]`: `"find_php_n_plus_one"`, `"find_php_god_model"`
  - Add two new tool definitions to `TOOL_DEFINITIONS`:
    ```typescript
    // Pattern matches existing tools: getCodeIndex(repo) auto-detects when repo is undefined
    { name: "find_php_n_plus_one", category: "analysis", searchHint: "php n+1 query foreach activerecord with eager loading",
      description: "Detect N+1 query patterns: foreach loops accessing relations without eager loading via with()",
      schema: {
        repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
        limit: z.number().optional().describe("Max findings to return (default: 100)"),
      },
      handler: async (args) => {
        const { findPhpNPlusOne } = await import("./tools/php-tools.js");
        const opts: { limit?: number } = {};
        if (typeof args.limit === "number") opts.limit = args.limit;
        return findPhpNPlusOne(args.repo as string, opts);
      } },
    { name: "find_php_god_model", category: "analysis", searchHint: "php god model god class anti-pattern too many methods relations",
      description: "Find oversized ActiveRecord models (configurable thresholds for method, relation, line counts)",
      schema: {
        repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
        min_methods: z.number().optional(),
        min_relations: z.number().optional(),
        min_lines: z.number().optional(),
      },
      handler: async (args) => {
        const { findPhpGodModel } = await import("./tools/php-tools.js");
        const opts: { min_methods?: number; min_relations?: number; min_lines?: number } = {};
        if (typeof args.min_methods === "number") opts.min_methods = args.min_methods;
        if (typeof args.min_relations === "number") opts.min_relations = args.min_relations;
        if (typeof args.min_lines === "number") opts.min_lines = args.min_lines;
        return findPhpGodModel(args.repo as string, opts);
      } },
    ```
- [ ] Verify: `npx vitest run tests/tools/php-tools.test.ts`
  Expected: `Tests  23 passed (23)` (was 21, +2 new)
- [ ] Acceptance: Both tools registered and auto-loaded on composer.json
- [ ] Commit: `feat(register-tools): register find_php_n_plus_one and find_php_god_model + auto-load`

---

### Task 15: Docs update — README, CLAUDE.md, instructions.ts

**Files:** `README.md`, `CLAUDE.md`, `src/instructions.ts`, `rules/codesift.md`, `rules/codex.md`, `rules/gemini.md`
**Complexity:** standard
**Dependencies:** Task 14

- [ ] RED: Write a verification test in `tests/tools/php-tools.test.ts` that reads CLAUDE.md and asserts it mentions `find_php_n_plus_one` and `find_php_god_model`.
- [ ] GREEN:
  - README: add both tools to the PHP/Yii2 tools table, bump tool count (+2)
  - CLAUDE.md: update "82 tools" / "43 core" if count changed; add note about N+1 detector
  - instructions.ts: bump tool count in CODESIFT_INSTRUCTIONS header
  - rules/*.md: bump count, add tools to relevant sections
- [ ] Verify: `npx vitest run tests/tools/php-tools.test.ts -t "docs"` then `grep -l "find_php_n_plus_one" README.md CLAUDE.md`
  Expected: Both files contain the tool name
- [ ] Acceptance: Docs consistent with new tools
- [ ] Commit: `docs: add find_php_n_plus_one and find_php_god_model to rules + README`

---

### Task 16: Integration verification on Mobi2 — all 5 gaps

**Files:** none (manual + node script)
**Complexity:** complex
**Dependencies:** Tasks 1, 3, 5, 8, 10, 12, 14 (one per gap + registration)

- [ ] RED: N/A
- [ ] GREEN: N/A
- [ ] Verify: Run on Mobi2:
  ```bash
  # Rebuild dist
  npx esbuild src/tools/php-tools.ts src/parser/extractors/php.ts src/utils/walk.ts src/utils/import-graph.ts src/parser/parser-manager.ts --outdir=dist --format=esm --platform=node --target=es2022 --packages=external --sourcemap

  # Gap 1+2: re-index Mobi2, expect no crashes + file count ~50% smaller
  node -e "const {indexFolder, invalidateCache} = require('./dist/tools/index-tools.js'); (async () => { await invalidateCache('local/Mobi2'); const r = await indexFolder('/Users/greglas/DEV/Mobi2', {}); console.log('files:', r.file_count, 'symbols:', r.symbol_count); })().catch(console.error)"

  # Gap 4: verify synthetic symbols from Yii2 ActiveRecord @property docs
  node -e "const {getCodeIndex} = require('./dist/tools/index-tools.js'); (async () => { const idx = await getCodeIndex('local/Mobi2'); const syn = idx.symbols.filter(s => s.meta?.synthetic); console.log('synthetic symbols:', syn.length); console.log('first 5:', syn.slice(0,5).map(s=>s.name+' ('+s.kind+') in '+s.file)); })()"

  # Gap 5a: N+1 detection
  node -e "const {findPhpNPlusOne} = require('./dist/tools/php-tools.js'); (async () => { const r = await findPhpNPlusOne('local/Mobi2'); console.log('N+1 findings:', r.total); for (const f of r.findings.slice(0,5)) console.log('  '+f.file+':'+f.line+' '+f.method+' → '+f.relation); })()"

  # Gap 5b: god models
  node -e "const {findPhpGodModel} = require('./dist/tools/php-tools.js'); (async () => { const r = await findPhpGodModel('local/Mobi2'); console.log('god models:', r.total); for (const m of r.models.slice(0,5)) console.log('  '+m.name+': '+m.reasons.join(', ')); })()"
  ```
  Expected:
  - file_count drops significantly (Gap 2)
  - synthetic symbols > 0 (Gap 4, Yii2 models have @property)
  - N+1 findings > 0 (Gap 5a — likely finds some in complex controllers)
  - `Survey` flagged as god model with `methods: 175 > 50, relations: 30 > 15` (Gap 5b)
- [ ] Acceptance: All 5 gaps visible in real-world Mobi2 audit
- [ ] Commit: `chore(verify): end-to-end validation of all 5 PHP gaps on Mobi2`

---

### Task 17: Extend php_project_audit with new gates

**Files:** `src/tools/php-tools.ts`, `tests/tools/php-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 14

- [ ] RED: Extend existing `php_project_audit` tests — add `n_plus_one` and `god_model` to the gates list. Expect 9 gates total (was 7).
- [ ] GREEN: In `phpProjectAudit`:
  - Add to `allChecks`: `"n_plus_one"`, `"god_model"`
  - Add task registration for each via dynamic import of the new functions
  - Handle results in the switch: `count = (result as {findings?: unknown[]})?.findings?.length ?? (result as {models?: unknown[]})?.models?.length ?? 0`
- [ ] Verify: `npx vitest run tests/tools/php-tools.test.ts`
  Expected: All tests pass, audit runs 9 gates
- [ ] Acceptance: N+1 and god model integrated into audit meta-tool
- [ ] Commit: `feat(php): add n_plus_one and god_model gates to php_project_audit`

---

### Task 18: Final full-suite run + commit

**Files:** none
**Complexity:** standard
**Dependencies:** All previous

- [ ] RED: N/A
- [ ] GREEN: N/A
- [ ] Verify: `npx vitest run 2>&1 | tail -20`
  Expected: Test count increased by ~15 from previous baseline, zero new regressions
- [ ] Acceptance: Full suite green
- [ ] Commit: N/A (no code, just verification)

---

## Verification (end-to-end)

Run after all tasks complete:
1. `npx vitest run` — full suite passes
2. Manual: `cd /Users/greglas/DEV/Mobi2` then test all tools via node script (Task 16)
3. `php_project_audit` on Mobi2 shows 9 gates with N+1 and god model findings

## Files to modify (all tasks)

| File | Tasks touching | Status |
|---|---|---|
| `src/parser/parser-manager.ts` | 1 | modify |
| `src/utils/walk.ts` | 3 | modify |
| `src/utils/import-graph.ts` | 5, 6 | modify |
| `src/parser/extractors/php.ts` | 7, 8, 9 | modify |
| `src/tools/php-tools.ts` | 10, 12, 13, 17 | modify |
| `src/register-tools.ts` | 14 | modify |
| `src/types.ts` | 8 | modify (add meta field) |
| `README.md`, `CLAUDE.md`, `src/instructions.ts`, `rules/*.md` | 15 | modify |
| `tests/parser/parser-manager.test.ts` | 1, 2 | NEW |
| `tests/utils/walk-backup-exclusion.test.ts` | 3 | NEW |
| `tests/utils/import-graph-php.test.ts` | 5, 6 | NEW |
| `tests/parser/php-phpdoc-tags.test.ts` | 7 | NEW |
| `tests/parser/php-extractor.test.ts` | 8, 9 | modify |
| `tests/tools/php-nplus1.test.ts` | 10, 11 | NEW |
| `tests/tools/php-god-model.test.ts` | 12, 13 | NEW |
| `tests/tools/php-tools.test.ts` | 14, 15, 17 | modify |
| `tests/fixtures/php-malformed/unclosed-class.php` | 2 | NEW |
| `tests/fixtures/php-psr4/composer.json`, `src/Models/User.php`, `src/Controllers/PostController.php` | 5 | NEW |
| `tests/fixtures/php-n-plus-one/BadController.php`, `GoodController.php` | 10 | NEW |
