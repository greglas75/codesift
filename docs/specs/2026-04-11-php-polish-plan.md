# Implementation Plan: PHP/Yii2 Tools Polish Round

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 2
**status:** Completed
**Created:** 2026-04-11
**Implemented:** 2026-04-11
**Branch:** feat/php-polish (worktree: .worktrees/php-polish)
**Tasks:** 11 (all completed)
**Final test suite:** 2726/2726 passing (172 test files)
**Estimated complexity:** 9 standard, 2 complex

## Architecture Summary

5 independent gaps touching 3 production files + 4 test files. No new tools created — all changes are in-place extensions. Gaps 1–4 are independent; Gap 5 tests depend on respective gap implementations.

**Files modified:**
- `src/tools/php-tools.ts` — Gaps 1, 3, 4 (findPhpNPlusOne, findPhpGodModel, analyzeActiveRecord)
- `src/utils/import-graph.ts` — Gap 2 (extractPhpUseStatements + PHP_USE_PATTERN)
- `src/parser/extractors/php.ts` — Gap 5 (interface/trait @property synthesis)

**Test files:**
- `tests/tools/php-nplus1.test.ts` — Gap 1 (+3 tests)
- `tests/tools/php-god-model.test.ts` — Gap 3 (+4 tests)
- `tests/utils/import-graph-php.test.ts` — Gap 2 (+4 tests)
- `tests/parser/php-extractor.test.ts` — Gap 5 (+6 tests)

**New fixtures:**
- `tests/fixtures/php-n-plus-one/MethodCallController.php`
- `tests/fixtures/php-n-plus-one/ChainedController.php`
(Gap 2 grouped imports use inline string tests — no fixture directory needed)

## Technical Decisions

| Gap | Pattern | Rationale |
|---|---|---|
| N+1 method calls | Two regexes: property (`(?!\()`) + getter (`->get\w+()`) with normalization `getProfile→profile` | Separate patterns minimize FP, getter convention is Yii2 standard |
| N+1 chained | `$item->(\w+)->` captures first segment as the relation trigger | Subsequent chain is irrelevant to N+1 trigger |
| Grouped imports | Two-step: match `use Prefix\{...};`, split on comma, expand each FQCN | Regex can't handle variable-length comma lists cleanly |
| God model scope | Extend `findPhpGodModel` with `scope?: "activerecord"\|"all"`, default AR | Backward compat, no new tool registration needed |
| Relation regex | Two-pass: first capture `hasOne/hasMany`, then scan ahead for `->via()/->inverseOf()` modifiers | Existing single-pass can't match chained modifiers |
| Interface/trait synth | Copy class_declaration synthesis block to interface/trait cases | Dedup guard uses `sym.id` which is kind-agnostic |

## Quality Strategy

- **Test count:** ~57 → ~80 (+23 new tests across 5 test files)
- **CQ gates:** CQ11 (function size — findPhpNPlusOne grows but stays <100 LOC), CQ14 (no duplication in synthesis blocks — extract helper if >10 lines duplicated)
- **Risk:** N+1 false positive spike mitigated by METHOD_CALL_BLOCKLIST + restricting to `get\w+()` convention
- **Regression:** Full vitest suite run at Task 11

## Task Breakdown

### Task 1: Interface/trait @property/@method synthesis

**Files:** `src/parser/extractors/php.ts`, `tests/parser/php-extractor.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add 4 tests to `tests/parser/php-extractor.test.ts` in new describe `"extractPhpSymbols — interface/trait PHPDoc synthesis"`:
  - Test: interface with `@property int $id` → synthesizes field with `meta.synthetic=true`, parent=interface id
  - Test: trait with `@property string $name` + `@method getPosts()` → synthesizes field + method under trait
  - Test: trait with real `getPosts()` body AND `@method getPosts()` in docblock → only 1 symbol, NOT synthetic (dedup works)
  - Test: interface with no docblock → 0 synthetic symbols
- [ ] GREEN: In `src/parser/extractors/php.ts`, add PHPDoc synthesis block (identical to class_declaration, lines 224-251) to:
  - `interface_declaration` case: after `symbols.push(sym)` + body walk, add `parsePhpDocTags` + synthesis block
  - `trait_declaration` case: same addition
  - Reuse existing `parsePhpDocTags` + dedup guard pattern unchanged (parent=`sym.id` is kind-agnostic)
- [ ] Verify: `npx vitest run tests/parser/php-extractor.test.ts`
  Expected: `Tests  23 passed (23)` (was 19, +4 new)
- [ ] Acceptance: @property/@method on interfaces and traits produce synthetic symbols
- [ ] Commit: `feat(php-extractor): synthesize @property/@method for interfaces and traits`

---

### Task 2: Interface/trait synthesis edge cases

**Files:** `tests/parser/php-extractor.test.ts`
**Complexity:** standard
**Dependencies:** Task 1

- [ ] RED: Add 2 more tests:
  - Test: interface with `@property-read` and `@property-write` variants → both synthesized
  - Test: trait inheriting other trait's docblock does NOT double-synthesize (each declaration's own docblock only)
- [ ] GREEN: Should already pass from Task 1 implementation. If edge case fails, adjust synthesis block.
- [ ] Verify: `npx vitest run tests/parser/php-extractor.test.ts`
  Expected: `Tests  25 passed (25)` (was 23, +2)
- [ ] Acceptance: Edge cases for interface/trait synthesis covered
- [ ] Commit: `test(php-extractor): edge cases for interface/trait @property synthesis`

---

### Task 3: N+1 method call detection (`$user->getProfile()`)

**Files:** `src/tools/php-tools.ts`, `tests/tools/php-nplus1.test.ts`, `tests/fixtures/php-n-plus-one/MethodCallController.php`
**Complexity:** complex
**Dependencies:** none

- [ ] RED: Create fixture `tests/fixtures/php-n-plus-one/MethodCallController.php`:
  ```php
  <?php
  class MethodCallController {
      public function actionBad() {
          $users = User::find()->all();
          foreach ($users as $user) {
              echo $user->getProfile()->name; // N+1 via getter!
          }
      }
      public function actionGood() {
          $users = User::find()->with('profile')->all();
          foreach ($users as $user) {
              echo $user->getProfile()->name; // OK — eager loaded
          }
      }
      public function actionBlocklisted() {
          $users = User::find()->all();
          foreach ($users as $user) {
              $user->save(); // NOT a relation getter — should be ignored
              $user->validate();
          }
      }
  }
  ```
  Add 3 separate `it()` tests:
  - Test A: actionBad → 1 finding (relation="profile", normalized from getProfile)
  - Test B: actionGood → 0 findings (eager loaded)
  - Test C: actionBlocklisted → 0 findings (save/validate are in METHOD_CALL_BLOCKLIST)
- [ ] GREEN: In `src/tools/php-tools.ts`:
  - Add `METHOD_CALL_BLOCKLIST = new Set(["save","validate","delete","refresh","load","populate","toArray","afterSave","beforeSave"])` near SCALAR_FIELD_NAMES
  - After the existing property-access regex loop, add second pass: `\$${itemVar}->(get(\w+))\s*\(` regex
  - Normalize captured name: strip `get` prefix, lowercase first char → use for `->with()` check
  - Skip if normalized name is in SCALAR_FIELD_NAMES or raw name is in METHOD_CALL_BLOCKLIST
  - Use separate `pattern: "foreach-getter-without-with"` in finding
- [ ] Verify: `npx vitest run tests/tools/php-nplus1.test.ts`
  Expected: `Tests  8 passed (8)` (was 5, +3 for 3 actionX assertions)
- [ ] Acceptance: `$user->getProfile()` triggers N+1 finding when no ->with('profile')
- [ ] Commit: `feat(php): N+1 detector catches getRelation() method calls with normalization`

---

### Task 4: N+1 chained access detection (`$user->profile->address`)

**Files:** `src/tools/php-tools.ts`, `tests/tools/php-nplus1.test.ts`, `tests/fixtures/php-n-plus-one/ChainedController.php`
**Complexity:** standard
**Dependencies:** none (chained regex is independent of Task 3's getter normalization)

- [ ] RED: Create fixture `tests/fixtures/php-n-plus-one/ChainedController.php`:
  ```php
  <?php
  class ChainedController {
      public function actionChained() {
          $orders = Order::find()->all();
          foreach ($orders as $order) {
              echo $order->customer->address->city; // chained N+1
          }
      }
  }
  ```
  Add test: ChainedController → at least 1 finding for relation="customer" (the first access triggers the N+1).
- [ ] GREEN: In `findPhpNPlusOne`, after the property-access regex, also match pattern `\$${itemVar}->(\w+)->` to detect chained property access. Use first segment as the relation name. Check against SCALAR_FIELD_NAMES and ->with() as before.
- [ ] Verify: `npx vitest run tests/tools/php-nplus1.test.ts`
  Expected: `Tests  9 passed (9)` (+1 chained test)
- [ ] Acceptance: Chained relation access in foreach triggers N+1 finding
- [ ] Commit: `feat(php): N+1 detector catches chained property access`

---

### Task 5: Grouped use imports — basic expansion

**Files:** `src/utils/import-graph.ts`, `tests/utils/import-graph-php.test.ts`
**Complexity:** complex
**Dependencies:** none

- [ ] RED: Add unit test for `extractPhpUseStatements`:
  ```typescript
  const uses = extractPhpUseStatements(`<?php
  use App\\Models\\{User, Post, Comment};
  use App\\Services\\AuthService;
  `);
  expect(uses).toContain("App\\Models\\User");
  expect(uses).toContain("App\\Models\\Post");
  expect(uses).toContain("App\\Models\\Comment");
  expect(uses).toContain("App\\Services\\AuthService");
  expect(uses).toHaveLength(4);
  ```
- [ ] GREEN: In `src/utils/import-graph.ts`, rewrite `extractPhpUseStatements`:
  - Keep existing `PHP_USE_PATTERN` for simple `use Foo\Bar;` (fast path)
  - Add `PHP_USE_GROUP_PATTERN = /^\s*use\s+(\w+(?:\\\w+)*)\s*\\{([^}]+)}\s*;/gm`
  - For each group match: extract prefix from group 1, split group 2 on `,`, trim each fragment, strip optional `as \w+`, concatenate `prefix\fragment` for each
  - Merge results from both patterns into one Set
- [ ] Verify: `npx vitest run tests/utils/import-graph-php.test.ts`
  Expected: `Tests  5 passed (5)` (was 4, +1 new)
- [ ] Acceptance: `use App\{Foo, Bar}` expands into 2 separate FQCNs
- [ ] Commit: `feat(import-graph): expand PHP grouped use declarations into individual FQCNs`

---

### Task 6: Grouped use edge cases — aliases, nested, whitespace

**Files:** `tests/utils/import-graph-php.test.ts`
**Complexity:** standard
**Dependencies:** Task 5

- [ ] RED: Add 3 edge case tests:
  - `use App\{Foo, Bar as B};` → resolves both, alias stripped
  - `use App\Services\{Auth\LoginService, Auth\LogoutService};` → resolves deep nested paths
  - `use App\Models\{ User , Post };` → whitespace around members handled
- [ ] GREEN: Should pass from Task 5 implementation if split/trim logic is correct. If not, fix the parser.
- [ ] Verify: `npx vitest run tests/utils/import-graph-php.test.ts`
  Expected: `Tests  8 passed (8)` (+3)
- [ ] Acceptance: Aliases, nested paths, and extra whitespace in grouped imports handled
- [ ] Commit: `test(import-graph): grouped PHP use edge cases — aliases, nested paths, whitespace`

---

### Task 7: God model scope expansion (`scope: "all"`)

**Files:** `src/tools/php-tools.ts`, `tests/tools/php-god-model.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Add 2 tests to `php-god-model.test.ts`:
  - Mock index with non-AR class `ReportService` (60 methods, 800 lines, source does NOT contain `extends ActiveRecord`). Call `findPhpGodModel(repo, { scope: "all" })` → assert flagged with methods + lines reasons.
  - Same class with default call (no scope) → assert NOT flagged (AR-only default).
- [ ] GREEN: In `findPhpGodModel`:
  - Add `scope?: "activerecord" | "all"` to options type
  - When `scope === "all"`: iterate `index.symbols.filter(s => s.kind === "class" && s.file.endsWith(".php"))` directly, count child methods from `index.symbols.filter(s => s.parent === cls.id && s.kind === "method")`, compute line count from `end_line - start_line`. Set `relation_count: 0`, skip `min_relations` check.
  - Default remains `"activerecord"` — existing behavior unchanged
- [ ] Verify: `npx vitest run tests/tools/php-god-model.test.ts`
  Expected: `Tests  7 passed (7)` (was 5, +2)
- [ ] Acceptance: `scope: "all"` catches non-AR god classes
- [ ] Commit: `feat(php): god model detector gains scope=all for non-ActiveRecord classes`

---

### Task 8: God model scope edge cases

**Files:** `tests/tools/php-god-model.test.ts`
**Complexity:** standard
**Dependencies:** Task 7

- [ ] RED: Add 2 tests:
  - `scope: "all"` with `min_methods: 10` custom threshold → small class with 12 methods flagged
  - `scope: "all"` with class that has only 5 methods and 100 lines → NOT flagged (below all thresholds)
- [ ] GREEN: Should pass from Task 7. If custom thresholds don't work with `scope: "all"`, fix.
- [ ] Verify: `npx vitest run tests/tools/php-god-model.test.ts`
  Expected: `Tests  9 passed (9)` (+2)
- [ ] Acceptance: Custom thresholds interact correctly with scope=all
- [ ] Commit: `test(php): god model scope=all respects custom thresholds`

---

### Task 9: Relation regex — `->via()`, `->viaTable()`, `->inverseOf()`

**Files:** `src/tools/php-tools.ts`, `tests/tools/php-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Add test that creates fixture source with:
  ```php
  public function getOrders() { return $this->hasMany(Order::class, ['user_id' => 'id'])->inverseOf('user'); }
  public function getTags() { return $this->hasMany(Tag::class, ['id' => 'tag_id'])->viaTable('post_tag', ['post_id' => 'id']); }
  public function getComments() { return $this->hasMany(Comment::class)->via('posts'); }
  ```
  Assert `analyzeActiveRecord` returns 3 relations: `orders` (hasMany), `tags` (hasMany/manyMany), `comments` (hasMany). All should be found (not 0 due to chained modifiers).
- [ ] GREEN: In `analyzeActiveRecord` relation extraction (line ~158):
  - Change regex to first capture `hasOne|hasMany` without trying to match modifiers in the same alternation
  - Remove the `hasMany\(\)->viaTable` branch from the main alternation
  - New regex: `/->(hasOne|hasMany)\s*\(\s*([\w\\]+)(?:::class)?/`
  - After matching, optionally scan for `->via\(|->viaTable\(|->inverseOf\(` on the same line to classify `manyMany` type
- [ ] Verify: `npx vitest run tests/tools/php-tools.test.ts`
  Expected: `Tests  27 passed (27)` (was 24, +3 new relation tests)
- [ ] Acceptance: Relations with ->via(), ->viaTable(), ->inverseOf() detected correctly
- [ ] Commit: `fix(php): relation regex detects via/viaTable/inverseOf modifiers`

---

### Task 10: Malformed composer.json resilience

**Files:** `tests/utils/import-graph-php.test.ts`, `tests/tools/php-tools.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Add 2 resilience tests:
  - `resolvePhpNamespace` on a repo whose composer.json is malformed JSON → returns `exists: false`, no crash
  - `collectImportEdges` on index with PHP files but no composer.json → returns edges from non-PHP files, no PHP edges, no crash
- [ ] GREEN: Should already work (readJsonSafe returns null, code handles null). If not, add null guard.
- [ ] Verify: `npx vitest run tests/utils/import-graph-php.test.ts tests/tools/php-tools.test.ts`
  Expected: import-graph-php `Tests 9 passed (9)` (was 8, +1), php-tools `Tests 28 passed (28)` (was 27, +1)
- [ ] Acceptance: Graceful degradation on missing/malformed composer.json
- [ ] Commit: `test(php): resilience tests for malformed/missing composer.json`

---

### Task 11: Full suite verification

**Files:** none
**Complexity:** standard
**Dependencies:** all previous

- [ ] RED: N/A
- [ ] GREEN: N/A
- [ ] Verify: `npx vitest run 2>&1 | tail -10`
  Expected: all tests pass, test count increased by ~17 from baseline, zero regressions
- [ ] Acceptance: Full suite green
- [ ] Commit: N/A (verification only)

---

## Verification

Run after all tasks:
1. `npx vitest run` — full suite green
2. Re-run Mobi2 validation: `npx tsx scratch/mobi2-php-gaps-validation.ts` — expect more N+1 findings (method calls) and more import edges (grouped uses)
3. `php_project_audit` on Mobi2 — verify 9 gates all produce results

## Files to modify (all tasks)

| File | Tasks | Change type |
|---|---|---|
| `src/parser/extractors/php.ts` | 1, 2 | modify (add synthesis to interface/trait) |
| `src/tools/php-tools.ts` | 3, 4, 7, 9 | modify (N+1 regex, god model scope, relation regex) |
| `src/utils/import-graph.ts` | 5, 6 | modify (grouped use expansion) |
| `tests/parser/php-extractor.test.ts` | 1, 2 | modify (+6 tests) |
| `tests/tools/php-nplus1.test.ts` | 3, 4 | modify (+4 tests) |
| `tests/tools/php-god-model.test.ts` | 7, 8 | modify (+4 tests) |
| `tests/tools/php-tools.test.ts` | 9, 10 | modify (+3 tests) |
| `tests/utils/import-graph-php.test.ts` | 5, 6, 10 | modify (+5 tests) |
| `tests/fixtures/php-n-plus-one/MethodCallController.php` | 3 | NEW |
| `tests/fixtures/php-n-plus-one/ChainedController.php` | 4 | NEW |
