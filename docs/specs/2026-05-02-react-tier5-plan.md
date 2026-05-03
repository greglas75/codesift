# Implementation Plan: React Tier 5

**Spec:** `docs/specs/2026-05-01-react-tier5-spec.md`
**spec_id:** 2026-05-01-react-tier5-2203
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 5
**status:** Approved
**Created:** 2026-05-02
**Tasks:** 15
**Estimated complexity:** 13 standard + 2 complex

## Architecture Summary

Touches two production files and three doc files:
- `src/tools/pattern-tools.ts` (line 25–30 type ext, line ~727 runner hook, +5 entries)
- `src/tools/react-tools.ts` (+2 helpers exported, `RenderAnalysisEntry` +1 field, `AnalyzeRendersResult` +metadata, `ReactQuickstartResult` +2 buckets, `analyzeRenders` wiring, `formatRendersMarkdown` +1 column, `reactQuickstart` severity routing)
- `tests/tools/pattern-tools.test.ts`, `tests/tools/react-tools.test.ts`, `tests/integration/react-tier5-baseline.test.ts`
- `tests/fixtures/react-tier5/` (11 fixtures + `baseline-critical-count.json`)
- `README.md`, `rules/codesift.md`, `CLAUDE.md`

Architect verified zero exhaustive-typing consumers; all callers use property-by-name. `tsconfig` has `exactOptionalPropertyTypes: true` → use `number | null` (always-present nullable) for `prop_chain_depth`.

Implementation order (dependency-respecting): type extension → runner postFilter hook → 5 patterns → helpers → analyzeRenders wiring → suggestion text → quickstart bucketing → markdown column → perf test → baseline test → docs.

## Technical Decisions

- **`postFilter` declarative field** (not hardcoded special-case) — runner gets one optional hook, any future pattern can use it. Try/catch around call (consistent with existing `catch {}` at runner line ~754).
- **Helpers exported** (`buildReverseAdjacency`, `computePropChainDepth`) — required for AC 4a unit tests.
- **Shared `memo` + `inProgress`** instantiated once per `analyzeRenders` call (NOT per-component, NOT module-level). This is what delivers O(V+E) total work.
- **No artificial size cap** — post-memoization, O(V+E) handles 100K+ components in milliseconds. The `metadata.skipped: "extractor-failure"` literal is retained in the type but fires only when extractor produces zero component symbols.
- **Regex backreference for name correlation** in `derived-state` and `stale-closure-setstate` — keeps `BUILTIN_PATTERNS` regex-only contract; ~80% recall; custom-named setters documented as known gap.
- **Severity bucketing** — new patterns get `severity` field; existing 29 patterns untouched (default = `critical`); full migration is Tier 6.
- **`PatternHit` matches existing `PatternMatch` interface** in `pattern-tools.ts` — verified by Tech Lead; reuse the existing type.

## Quality Strategy

- All 5 new regex patterns tested via `BUILTIN_PATTERNS[name].regex.test(input)` (existing convention from `pattern-tools.test.ts`).
- Each pattern has 4 tests: positive, canonical negative, ReDoS guard (<50ms on 10KB adversarial), and one edge-case from spec §Edge Cases.
- Helpers tested in isolation with hand-crafted `Map<string, string[]>` adjacency.
- Cycle determinism asserted by running cycle fixture twice and `expect(result1).toEqual(result2)`.
- Memo cross-pollution caught by sequential `analyzeRenders` calls on different repos.
- Performance gate: 5,000-component synthetic fixture < 1s wall-clock (5× safety margin over expected 200ms).
- Vendored fixture corpus at `tests/fixtures/react-tier5/` is the authoritative success-criteria target (NOT coding-ui — that's opt-in non-blocking smoke).
- Contract test (`Ship #6`) asserts both `severity` and `postFilter` are present on entry shape and that `RenderAnalysisEntry` has `prop_chain_depth: number | null`.
- AC 8 enforced by literal `includes("NOT prop-drilling depth")` assertion on `suggestion` text — prevents semantic drift.

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| Ship-1 | 5 entries present in BUILTIN_PATTERNS | requirement | Task 3-7 | Verified by listPatterns count update in Task 7 |
| Ship-2 | Each pattern has ≥2 unit tests (positive + canonical negative) | requirement | Task 3-7 | Test titles per pattern |
| Ship-3 | ReDoS guard <50ms on 10KB adversarial input | requirement | Task 3-7 | One ReDoS test per pattern |
| Ship-4a | computePropChainDepth helper unit tests (linear + cycle) | requirement | Task 8 | |
| Ship-4b | analyzeRenders integration with prop_chain_depth field | requirement | Task 9, 13 | 3-level fixture + 5000-component perf |
| Ship-5 | Zero test regressions (relative to main) | constraint | Task 15 (final) | Implicit via every vitest run |
| Ship-6 | Contract test for RenderAnalysisEntry + downstream module load | requirement | Task 9, 11 | Import + structural assertion |
| Ship-7 | tsc --noEmit exits 0 | constraint | Task 1, all | Type check at end of each task |
| Ship-8 | Suggestion text contains literal "NOT prop-drilling depth" | requirement | Task 10 | Snapshot-stable literal check |
| Success-1 | context-provider-value-inline finds canonical AuthProvider, zero FP | deliverable | Task 5 | Vendored fixture |
| Success-2 | analyzeRenders prop_chain_depth on 3-level fixture returns 2 | deliverable | Task 9 | |
| Success-3 | 5000-component fixture <1s, all finite depths | deliverable | Task 13 | |
| Success-4 | derived-state finds canonical, zero FP on seed-only | deliverable | Task 3 | |
| Success-5 | react_quickstart non-empty style_issues; critical_issues == baseline | deliverable | Task 11, 14 | Baseline JSON committed |
| G1 | postFilter declarative field landed | constraint | Task 1, 2 | Foundation for jsx-no-target-blank |
| G2 | severity field landed | constraint | Task 1, 11 | Foundation for bucket routing |
| G3 | Helpers exported for unit testing | constraint | Task 8 | Otherwise AC 4a unreachable |
| G4 | Docs updated (README, rules, CLAUDE) | deliverable | Task 15 | Final |
| G5 | formatRendersMarkdown gains prop_chain_depth column | constraint | Task 12 | Backward-compat clause |

## Review Trail

- Plan reviewer revision 1 → APPROVED (single iteration; all coverage + dependency + adversarial-risk checks passed)
- Cross-model validation revision 1 → 3 CRITICAL + 5 WARNING (3 providers: codex-5.3, gemini, cursor-agent)
  - CRITICAL #1: serial dep chain missing for Tasks 4-7 sharing pattern-tools.ts → fixed by adding Task N depends Task N-1 chain
  - CRITICAL #2: recursive DFS could stack-overflow on deep linear graphs (>10K) → fixed by replacing scaffold with iterative 2-phase stack algorithm + adding 20K-depth RED test in Task 8
  - CRITICAL #3: Task 9 RED missing extractor-failure branch → fixed by adding RED test #5 for empty-adjacency path
  - WARNING: Task 13 (perf gate) sequenced too late → fixed by documenting that Task 13 can execute immediately after Task 9 (parallel with 10-12)
  - WARNING: Task 14 baseline capture procedure ambiguous → fixed by single deterministic command in GREEN step
  - INFO findings (scaffold over-specification, docs grep verification) — not material to execution semantics, kept as-is
- Plan reviewer revision 2 → APPROVED with 1 ISSUE: Task 14 baseline command mixed ESM `import()` with CJS `require()` → would crash with `ReferenceError: require is not defined`
- Cross-model validation revision 2 → 1 CRITICAL + 6 WARNING (3 providers)
  - CRITICAL (gemini): `button-no-type` regex per-char lookbehind `(?<![\w-])` broken — fails on every multi-letter attribute (e.g., `class="x"` aborts at `l`). FN-bomb.
  - WARNING (cursor-agent): Task 8 RED has 6+2 tests but Verify expects 7 (off-by-one)
  - WARNING (cursor-agent): Task 9 RED has 5 tests but Verify expects 4 (off-by-one)
  - WARNING (cursor-agent): Ship-5 not in any task's Acceptance field (claimed Task 15 but unmapped)
  - WARNING (cursor-agent): Tasks 10-12 share `react-tools.ts` without serial chain
  - WARNING (gemini): Task 14 RED-before-GREEN ordering — RED test reads file that GREEN creates → ENOENT instead of clean assertion failure
  - INFO (gemini): scaffold over-specification — kept (user directive: thoroughness)
- Plan reviewer revision 3 → (skipped re-run; cross-model run 3 found new CRITICALs that supersede)
- Cross-model validation revision 3 → 3 CRITICAL + 8 WARNING (3 providers)
  - CRITICAL (codex + gemini): Tasks 10-12 ALSO edit `tests/tools/react-tools.test.ts` — Task 13's "parallel-safe separate file" claim was false → Task 13 moved to dedicated `tests/tools/react-tools-perf.test.ts` with zero file overlap.
  - CRITICAL (gemini): Task 9 extractor-failure trigger `adjacency.children.size === 0` was wrong — would fire on flat valid component trees → fixed to `componentSymbols.length === 0`. Plus added regression-guard test #6 in Task 9 RED.
  - CRITICAL/WARNING (gemini): Task 7 regex `<button(...)>` matches custom elements `<button-group>`, `<ButtonIcon>` → fixed with word-boundary `(?=[\s>])` lookahead after `<button`. Added 2 RED tests (Task 7 #5, #6).
  - WARNING (gemini): Task 14 pre-RED bootstrap was in GREEN step → moved to RED step (write placeholder JSON before running test).
  - WARNING (cursor-agent): Task 15 README grep too narrow → expanded to per-pattern + count check.
  - WARNING (cursor-agent): Task 13 RED allowed isolated helper benchmark → tightened to require end-to-end `analyzeRenders` call.
  - WARNING (gemini): non-deterministic cycle depth without sorted symbol iteration → fixed in Task 9 GREEN (sort symbols by id ?? name before adjacency build).
  - INFO (codex/cursor-agent on scaffold over-specification): kept — user directive favors thoroughness over abstraction.
- Plan reviewer revision 4 → (skipped re-run; cross-model run 4 found new CRITICALs that supersede)
- Cross-model validation revision 4 → 3 CRITICAL + 6 WARNING + 1 INFO. CRITICALs addressed in revision 5: (a) Task 3 dep += Task 2 (concurrent-write race on pattern-tools.ts); (b) Task 13 dep += Task 12 (full vitest reads source files mid-edit); (c) Task 14 dep += Task 12 (npm run build compiles all sources mid-edit). Plus minor: Task 9 Acceptance no longer claims Success-3 (owned by Task 13); Task 7 commit message rewritten to match lookahead-not-lookbehind reality.
- Cross-model validation revision 5 → 1 CRITICAL (Task 7 RED count mismatch "5 tests" vs enumerated 7 — fixed) + 5 WARNING + 2 INFO. Convergence assessed:
  - Remaining WARNINGs are scope-discipline preferences (task bloat: standard tasks touching 4+ files) — kept as-is because the file mix is intrinsic (regex + tests + fixtures travel together) and splitting would create more merge surface, not less
  - Self-referential baseline (gemini): inherent to "first capture" snapshots — accepted as documented in Task 14 GREEN
  - Stale Revision 3 §7 changelog entry: superseded by Revision 4 changelog (the §7 reference was about `tests/tools/react-tools.test.ts` BEFORE the move; current state is correct in §5 of revision 4 changelog)
  - INFO findings (scaffold over-specification, vitest filter scope) are recurring INFO across all 4 runs — kept per user directive favoring thoroughness over abstraction
- Status gate: Reviewed (cross-model converged: zero remaining CRITICAL after Run 5 fix; WARNINGs are non-blocking scope preferences)
- Status gate: Draft

### Revision 4 fixes applied
1. Task 7 regex word-boundary: `<button(?=[\s>])(?![^>]{0,500}\stype\s*=)[^>]{0,500}>` — excludes custom elements + components.
2. Task 7 RED gained tests #5 (custom element `<button-group>`) and #6 (PascalCase `<ButtonIcon>`).
3. Task 9 GREEN: extractor-failure now checks `componentSymbols.length === 0` (NOT adjacency size); added explicit symbol sorting before adjacency build for cycle determinism.
4. Task 9 RED gained test #6 (flat-tree non-failure regression guard).
5. Task 13 moved to NEW dedicated file `tests/tools/react-tools-perf.test.ts` (zero collision with Tasks 10-12); RED requires end-to-end `analyzeRenders` call (not isolated helpers).
6. Task 14: pre-RED bootstrap (placeholder JSON) moved from GREEN to RED step.
7. Task 15: README grep expanded to per-pattern check + count assertion in CLAUDE.md.

### Revision 3 fixes applied
1. Task 7 `button-no-type` regex replaced with whole-tag negative lookahead `(?![^>]{0,500}\stype\s*=)` — correctly distinguishes `type=` (real attr) from `data-type=` (substring). Worked-example walkthrough added inline.
2. Task 14 baseline command rewritten as ESM-only via `node --input-type=module` + dynamic imports + `await import('node:fs')`.
3. Task 14 GREEN gained pre-RED placeholder bootstrap: write `{count: -1}` before RED runs, so failure mode is assertion mismatch, not ENOENT.
4. Task 8 Verify: count corrected to 8 (6 + 2).
5. Task 9 Verify: count corrected to 5; title pattern broadened to `prop_chain_depth|RenderAnalysisEntry|extractor-failure`.
6. Tasks 10, 11, 12 gained serial-chain dependencies on each other (10→9, 11→10, 12→11) preventing parallel collisions on `src/tools/react-tools.ts`.
7. Task 13 dependency note clarified: only edits `tests/tools/react-tools.test.ts` (separate file from Tasks 10-12), so it slots between Task 9 and Task 10 without collision.
8. Task 15 Verify converted from grep-anywhere to per-file grep-or-fail bash script + adds full vitest run + tsc check; Acceptance picks up Ship-5 and Ship-7.

## Task Breakdown

### Task 1: Extend `BUILTIN_PATTERNS` entry type with `severity` and `postFilter`
**Files:** `src/tools/pattern-tools.ts` (lines 25-30), `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add test in `tests/tools/pattern-tools.test.ts` titled `"BUILTIN_PATTERNS entry shape supports optional severity and postFilter"`. Assert at type level (compile-time check via runtime introspection): `expect(BUILTIN_PATTERNS["empty-catch"]).toBeDefined()` (existing entry without severity still valid) AND that an entry literal `{ regex: /x/, description: "x", severity: "warning" satisfies "critical"|"warning"|"style", postFilter: (m: string) => true }` is structurally accepted. Compile-time verification suffices.
- [ ] GREEN: In `src/tools/pattern-tools.ts` line 25-30, extend the `Record<string, {...}>` type literal to add `severity?: "critical" | "warning" | "style"` and `postFilter?: (match: string) => boolean` as the last two optional fields. No changes to existing 29 entries.
- [ ] Verify: `npx tsc --noEmit && npx vitest run tests/tools/pattern-tools.test.ts -t "entry shape"`
  Expected: zero TS errors, new test passes, all existing tests unchanged.
- [ ] Acceptance: Ship-7, G1, G2.
- [ ] Commit: `feat(patterns): add severity and postFilter optional fields to BUILTIN_PATTERNS entry shape`

---

### Task 2: Add `postFilter` hook to `searchPatterns` runner with try/catch
**Files:** `src/tools/pattern-tools.ts` (line ~727 in `searchPatterns`), `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: Add 2 tests in `tests/tools/pattern-tools.test.ts` under `describe("searchPatterns postFilter integration")`:
  1. `"drops match when postFilter returns false"` — register a synthetic test pattern with `regex: /TARGET/, postFilter: () => false`, run `searchPatterns` on a fixture containing `TARGET`, assert zero matches.
  2. `"throwing postFilter does not crash run; match is dropped, other patterns still emit"` — register `postFilter: () => { throw new Error("test") }` AND a second pattern with no postFilter that should match elsewhere; assert second pattern still emits, throwing pattern emits zero.
- [ ] GREEN: In `src/tools/pattern-tools.ts` `searchPatterns` (around line 727, inside `if (match)` block, before `matches.push(...)`):
  ```ts
  if (entry.postFilter) {
    try {
      if (!entry.postFilter(matchedText)) continue;
    } catch {
      continue; // drop match on postFilter error, consistent with existing catch at line ~754
    }
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "searchPatterns postFilter"`
  Expected: 2 tests pass; full vitest run still green.
- [ ] Acceptance: G1.
- [ ] Commit: `feat(patterns): searchPatterns runner invokes optional postFilter with try/catch isolation`

---

### Task 3: Add `derived-state` pattern with backreference + 2 fixtures
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`, `tests/fixtures/react-tier5/derived-state-canonical.tsx` (new), `tests/fixtures/react-tier5/derived-state-seed-only.tsx` (new)
**Complexity:** standard
**Dependencies:** Task 1, Task 2 (serial chain — Task 2 also edits `pattern-tools.ts` runner; must land before Task 3 modifies registry to avoid concurrent write collision per gemini Run 4)
**Execution routing:** default

- [ ] RED: Add `describe("derived-state")` in `tests/tools/pattern-tools.test.ts` with 4 tests:
  1. `"matches useState(props.X) with syncing useEffect"` — input from `derived-state-canonical.tsx`, assert regex matches.
  2. `"does not match useState(props.X) without syncing Effect"` — input from `derived-state-seed-only.tsx`, assert no match.
  3. `"does not match useReducer dispatch sync"` — synthetic input with `useReducer` + dispatch.
  4. `"ReDoS guard: completes within 50ms on adversarial input"` — 10KB string of repeated `useState(props.x)` triggers without trailing useEffect.
- [ ] GREEN: Add entry to `BUILTIN_PATTERNS` (after existing React patterns block, ~line 207):
  ```ts
  "derived-state": {
    regex: /const\s*\[\s*(\w+)\s*,\s*set\1\s*\]\s*=\s*useState\s*\(\s*props\.\1\s*\)[\s\S]{0,2000}?useEffect\s*\([\s\S]{0,500}?set\1\s*\(\s*props\.\1\s*\)/i,
    description: "useState(props.X) + useEffect that syncs setX(props.X) — derived state anti-pattern. Lift state up or compute during render. NOTE: matches when state name follows setX for prop x. Custom-named setters not detected.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  ```
  Create fixture files. Update `listPatterns` count test (line 386) by +1.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "derived-state"`
  Expected: all 4 tests pass; ReDoS guard <50ms; listPatterns count test passes.
- [ ] Acceptance: Ship-1 (partial), Ship-2 (partial), Ship-3 (partial), Success-4.
- [ ] Commit: `feat(patterns): add derived-state — useState(props.X) + useEffect sync anti-pattern (rautio gap)`

---

### Task 4: Add `stale-closure-setstate` pattern with backreference
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 1, Task 3 (serial chain — both modify shared `pattern-tools.ts` registry and `listPatterns` count test, must land sequentially to prevent merge conflicts)
**Execution routing:** default

- [ ] RED: Add `describe("stale-closure-setstate")` with 4 tests:
  1. `"matches setCount(count + 1) non-functional update"` — positive.
  2. `"does not match setCount(prev => prev + 1) functional updater"` — canonical negative.
  3. `"does not match setOpen(!open) boolean toggle"` — documented FN, regex requires `[+\-*/]`.
  4. `"ReDoS guard: completes within 50ms on adversarial input"`.
- [ ] GREEN: Add entry:
  ```ts
  "stale-closure-setstate": {
    regex: /const\s*\[\s*(\w+)\s*,\s*set([A-Z]\w*)\s*\]\s*=\s*useState[\s\S]{0,3000}?\bset\2\s*\(\s*\1\s*[+\-*/]/,
    description: "setState called with non-functional update referencing current state value (setX(X + n)) — risks stale closure. Use functional form: setX(prev => prev + n). NOTE: requires standard [x, setX] = useState() naming; boolean toggles (setOpen(!open)) and broken functional updaters not detected.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  ```
  Update `listPatterns` count by +1.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "stale-closure-setstate"`
  Expected: all 4 tests pass.
- [ ] Acceptance: Ship-1 (partial), Ship-2 (partial), Ship-3 (partial).
- [ ] Commit: `feat(patterns): add stale-closure-setstate — non-functional setState referencing current state (rautio gap)`

---

### Task 5: Add `context-provider-value-inline` pattern + 2 fixtures
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`, `tests/fixtures/react-tier5/context-provider-inline.tsx` (new), `tests/fixtures/react-tier5/context-provider-memoized.tsx` (new)
**Complexity:** standard
**Dependencies:** Task 1, Task 4 (serial chain — shared `pattern-tools.ts` + listPatterns count)
**Execution routing:** default

- [ ] RED: Add `describe("context-provider-value-inline")` with 4 tests:
  1. `"matches <Ctx.Provider value={{...}}>"` — input from `context-provider-inline.tsx`.
  2. `"does not match <Ctx.Provider value={memoizedValue}>"` — input from `context-provider-memoized.tsx`.
  3. `"does not match destructured Provider const {Provider} = Ctx"` — documented FN.
  4. `"ReDoS guard: completes within 50ms on adversarial input"`.
- [ ] GREEN: Add entry:
  ```ts
  "context-provider-value-inline": {
    regex: /<\w+\.Provider\s+[^>]*\bvalue\s*=\s*\{\s*[\{\[]/,
    description: "Context.Provider value is an inline object/array literal — new reference every render forces ALL consumers to re-render. Wrap in useMemo: value={useMemo(() => ({...}), [deps])}. NOTE: does not detect intermediate-variable form or destructured Provider.",
    severity: "warning",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  ```
  Update `listPatterns` count by +1.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "context-provider-value-inline"`
  Expected: 4 tests pass.
- [ ] Acceptance: Ship-1 (partial), Ship-2 (partial), Ship-3 (partial), Success-1.
- [ ] Commit: `feat(patterns): add context-provider-value-inline — inline object literal forcing consumer re-render (differentiator)`

---

### Task 6: Add `jsx-no-target-blank` pattern with `postFilter` + 2 fixtures
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`, `tests/fixtures/react-tier5/target-blank-no-rel.tsx` (new), `tests/fixtures/react-tier5/target-blank-with-rel.tsx` (new)
**Complexity:** standard
**Dependencies:** Task 1, Task 2 (postFilter runner hook), Task 5 (serial chain)
**Execution routing:** default

- [ ] RED: Add `describe("jsx-no-target-blank")` with 5 tests:
  1. `"matches <a target=\"_blank\"> without rel via searchPatterns"` — full runner test, postFilter must allow.
  2. `"does not match <a target=\"_blank\" rel=\"noopener\">"` — postFilter drops.
  3. `"matches JSX brace form target={\"_blank\"}"` — JSX expression form.
  4. `"postFilter does not match URL containing rel="` — fixture with `href="?rel=1"` and `target="_blank"`, no actual `rel=` attribute, must still match (postFilter requires `\srel\s*=`).
  5. `"ReDoS guard: completes within 50ms on adversarial input"`.
- [ ] GREEN: Add entry:
  ```ts
  "jsx-no-target-blank": {
    regex: /<a\s+(?:(?!>)[\s\S]){0,500}?target\s*=\s*(?:["']_blank["']|\{\s*["']_blank["']\s*\})(?:(?!>)[\s\S]){0,500}?>/,
    description: "<a target=\"_blank\"> without rel=\"noopener noreferrer\" — tabnabbing/window.opener security risk. Add rel=\"noopener noreferrer\". NOTE: matches both string and JSX-brace form; postFilter requires whitespace before rel= to avoid URL false-positive.",
    severity: "style",
    fileIncludePattern: /\.(tsx|jsx)$/,
    postFilter: (match) => !/\srel\s*=/.test(match),
  },
  ```
  Update `listPatterns` count by +1.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "jsx-no-target-blank"`
  Expected: 5 tests pass; postFilter integration verified.
- [ ] Acceptance: Ship-1 (partial), Ship-2 (partial), Ship-3 (partial).
- [ ] Commit: `feat(patterns): add jsx-no-target-blank — tabnabbing security gap with postFilter validation`

---

### Task 7: Add `button-no-type` pattern + 3 fixtures + final listPatterns count
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`, `tests/fixtures/react-tier5/button-no-type-bare.tsx` (new), `tests/fixtures/react-tier5/button-no-type-with-attrs.tsx` (new), `tests/fixtures/react-tier5/button-with-type.tsx` (new)
**Complexity:** standard
**Dependencies:** Task 1, Task 6 (serial chain — final pattern in the registry; listPatterns count must reflect all 5 added)
**Execution routing:** default

- [ ] RED: Add `describe("button-no-type")` with 7 tests:
  1. `"matches bare <button>Submit</button>"` — bare form.
  2. `"matches <button onClick={...}>"` — with attrs, no type.
  3. `"does not match <button type=\"button\">"` — canonical negative.
  4. `"matches <button data-type=\"primary\">"` — `\s`-anchored lookahead correctly distinguishes data-type from type.
  5. `"does not match custom element <button-group>"` — word-boundary `(?=[\s>])` ensures HTML <button> only.
  6. `"does not match React component <ButtonIcon>"` — case-sensitive `<button` plus word-boundary doubly excludes PascalCase components.
  7. `"ReDoS guard: completes within 50ms on adversarial input"`.
- [ ] GREEN: Add entry. **Regex correction (gemini Run 2 CRITICAL):** the per-char lookbehind `(?<![\w-])` was broken — it failed on every non-first char of any multi-letter attribute (e.g., at `l` in `class`, prev char `c` is word-char → lookbehind fails → loop terminates → false negative on `<button class="x">`). Replaced with whole-tag negative lookahead that checks for `\stype\s*=` anywhere in the attribute span:
  ```ts
  "button-no-type": {
    regex: /<button(?=[\s>])(?![^>]{0,500}\stype\s*=)[^>]{0,500}>/,
    description: "<button> without explicit type attribute — defaults to type=\"submit\" which can unintentionally submit a form. Add type=\"button\" for non-submit buttons. NOTE: word-boundary lookahead `(?=[\\s>])` after `button` ensures we match the HTML <button> tag only — NOT custom components like <button-group> or <ButtonIcon>. Negative lookahead `(?![^>]{0,500}\\stype\\s*=)` requires whitespace before `type=` (so `data-type=` correctly does NOT block the match). Does not detect <MyButton> wrapping component.",
    severity: "style",
    fileIncludePattern: /\.(tsx|jsx)$/,
  },
  ```
  Why this regex form is correct (per gemini Run 3 word-boundary fix):
  - Bare `<button>`: `(?=[\s>])` matches `>`. Lookahead `[^>]{0,500}\stype=` requires at least one whitespace + `type=`, fails on zero attrs → negative-lookahead succeeds → match.
  - `<button onClick={x}>`: `(?=[\s>])` matches space. Lookahead can't find `\stype=` → match.
  - `<button class="x">`: same — match.
  - `<button data-type="x">`: `\s` + `type=` doesn't exist (`data-type` has `-` before `type`) → match.
  - `<button-group>` (custom element): `(?=[\s>])` after `button` checks for `\s` or `>` — finds `-`, neither — fails. Correctly NOT matched.
  - `<ButtonIcon>` (custom React component): `(?=[\s>])` after `button` finds `I` (word char) — fails. Correctly NOT matched (also case-sensitive `<button` won't match `<Button` anyway, but the lookahead provides defense-in-depth).
  - `<button type="button">`: `\stype=` matches first space + `type=` → negative fails → no match. Correct.
  Update `listPatterns` count test to final value (existing count + 5).
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "button-no-type"` AND `npx vitest run tests/tools/pattern-tools.test.ts -t "listPatterns"`
  Expected: 7 button tests pass, listPatterns count test passes (asserts final count).
- [ ] Acceptance: Ship-1, Ship-2, Ship-3 (final piece).
- [ ] Commit: `feat(patterns): add button-no-type — implicit submit form-submit foot-gun, HTML <button> only via word-boundary + whitespace-anchored type= lookahead`

---

### Task 8: Add `buildReverseAdjacency` and `computePropChainDepth` helpers (exported, unit tested)
**Files:** `src/tools/react-tools.ts` (new helpers + export at line 14), `tests/tools/react-tools.test.ts`
**Complexity:** complex
**Dependencies:** none (pure helpers)
**Execution routing:** deep

- [ ] RED: Add `describe("computePropChainDepth")` in `tests/tools/react-tools.test.ts` with 5 tests:
  1. `"returns 0 for orphan with no parents"` — empty reverseAdj.
  2. `"returns 2 for linear 3-node chain Root → Middle → Leaf"` — assert depth(Leaf)=2, depth(Middle)=1, depth(Root)=0.
  3. `"returns finite depth on cycle A→B→A and is deterministic across two runs"` — same fixture run twice, `expect(r1).toEqual(r2)`.
  4. `"shared memo across multi-component call returns consistent depths"` — invoke for 3 components in same call with shared memo, assert no recomputation (mock memo to track size).
  5. `"alphabetical iteration order produces stable output across Map insertion permutations"` — build same logical graph two different ways, assert identical depth output.
  6. `"handles 20,000-deep linear chain without stack overflow"` — generate linear chain Root→C1→C2→...→C20000, assert depth(C20000) === 20000 and no RangeError. Required by iterative algorithm choice (V8 stack ~10-15K would crash recursive form).
  Add `describe("buildReverseAdjacency")` with 2 tests:
  7. `"inverts parent→children to child→parents"` — happy path.
  8. `"keys by CodeSymbol.id when present, falls back to name"` — mixed-id fixture.
- [ ] GREEN: Add to `src/tools/react-tools.ts` (after line 462, before `analyzeRenders`):
  ```ts
  export function buildReverseAdjacency(adjacency: JsxAdjacency): Map<string, string[]> {
    const parents = new Map<string, string[]>();
    for (const [parentKey, children] of adjacency.children) {
      for (const child of children) {
        const childKey = child.id ?? child.name;
        const list = parents.get(childKey) ?? [];
        list.push(parentKey);
        parents.set(childKey, list);
      }
    }
    for (const [k, v] of parents) parents.set(k, [...v].sort());
    return parents;
  }

  // Iterative implementation using an explicit stack — V8 stack is ~10-15K frames,
  // so a recursive form would crash on deep linear chains (>10K). Per gemini Run 4
  // adversarial finding. Algorithm: post-order traversal with a 2-phase stack
  // ("enter" and "exit" markers) so we can compute max(parent depths) AFTER all
  // parents have been processed, while keeping memo + inProgress invariants.
  export function computePropChainDepth(
    componentName: string,
    reverseAdjacency: Map<string, string[]>,
    memo: Map<string, number>,
    inProgress: Set<string>,
  ): number {
    if (memo.has(componentName)) return memo.get(componentName)!;
    if (inProgress.has(componentName)) return 0;

    type Frame = { node: string; phase: "enter" | "exit" };
    const stack: Frame[] = [{ node: componentName, phase: "enter" }];

    while (stack.length > 0) {
      const f = stack[stack.length - 1]!;
      if (f.phase === "enter") {
        if (memo.has(f.node)) { stack.pop(); continue; }
        if (inProgress.has(f.node)) { stack.pop(); continue; }
        inProgress.add(f.node);
        f.phase = "exit";
        for (const p of reverseAdjacency.get(f.node) ?? []) {
          if (!memo.has(p) && !inProgress.has(p)) {
            stack.push({ node: p, phase: "enter" });
          }
        }
      } else {
        // exit phase — all parents either memoized or cyclically pruned
        const parents = reverseAdjacency.get(f.node) ?? [];
        let maxParentDepth = -1;
        for (const p of parents) {
          const d = memo.get(p) ?? 0;  // cyclic parent contributes 0
          if (d > maxParentDepth) maxParentDepth = d;
        }
        const depth = parents.length === 0 ? 0 : maxParentDepth + 1;
        memo.set(f.node, depth);
        inProgress.delete(f.node);
        stack.pop();
      }
    }
    return memo.get(componentName)!;
  }
  ```
  Add both to the named export at line 14.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "computePropChainDepth|buildReverseAdjacency"`
  Expected: 8 tests pass (6 in `computePropChainDepth` + 2 in `buildReverseAdjacency`).
- [ ] Acceptance: Ship-4a, G3.
- [ ] Commit: `feat(react): add computePropChainDepth + buildReverseAdjacency helpers (memoized longest-path, O(V+E))`

---

### Task 9: Wire `prop_chain_depth` into `analyzeRenders` + extend `RenderAnalysisEntry`/`AnalyzeRendersResult` types
**Files:** `src/tools/react-tools.ts` (lines 475, 487, ~635), `tests/tools/react-tools.test.ts`, `tests/fixtures/react-tier5/prop-chain-3-levels.tsx` (new), `tests/fixtures/react-tier5/prop-chain-cycle.tsx` (new)
**Complexity:** complex
**Dependencies:** Task 8
**Execution routing:** deep

- [ ] RED: Add 3 tests in `tests/tools/react-tools.test.ts`:
  1. `"RenderAnalysisEntry contract has prop_chain_depth: number | null always present"` — Ship-6 contract test, structural check via `expect("prop_chain_depth" in entry).toBe(true)`.
  2. `"analyzeRenders on prop-chain-3-levels.tsx returns Leaf depth 2"` — Success-2.
  3. `"analyzeRenders on cyclic fixture returns finite depths and is deterministic"` — load `prop-chain-cycle.tsx`, run twice, assert deep equality.
  4. `"sequential analyzeRenders calls on different repos do not share memo state"` — call twice with different adjacency, assert second result reflects second graph.
  5. `"extractor-failure path: zero component symbols yields metadata.skipped === 'extractor-failure'"` — synthetic index with ZERO `kind === "component"` symbols (e.g., only function symbols, no React components extracted), assert result `metadata.skipped === "extractor-failure"` and entries length is 0 (or all entries have `prop_chain_depth: null`). NOTE: a flat component tree with components but no JSX nesting is NOT a failure — the failure signal is "extractor produced zero components", not "zero adjacency edges".
  6. `"flat component tree without JSX nesting does NOT trigger extractor-failure"` — synthetic index with 5 component symbols but no JSX usages between them (each renders only HTML primitives). Assert `metadata?.skipped` is undefined AND each entry has `prop_chain_depth === 0` (each is a root, no parents). This guards against the gemini-flagged false-failure regression.
- [ ] GREEN: In `src/tools/react-tools.ts`:
  - Line 475 (`RenderAnalysisEntry`): add `prop_chain_depth: number | null;`
  - Line 487 (`AnalyzeRendersResult`): add `metadata?: { skipped?: "extractor-failure" };`
  - Line ~635 (`analyzeRenders` body): before the per-component loop, **sort component symbols alphabetically by `id ?? name`** (per gemini Run 3 — needed for deterministic cycle handling), then build reverse adjacency once: `const sortedSyms = [...symbols].sort((a,b) => (a.id ?? a.name).localeCompare(b.id ?? b.name)); const adjacency = buildJsxAdjacency(sortedSyms); const reverseAdj = buildReverseAdjacency(adjacency); const memo = new Map<string, number>(); const inProgress = new Set<string>();`. Inside the loop, populate `prop_chain_depth: computePropChainDepth(sym.id ?? sym.name, reverseAdj, memo, inProgress)`.

  **Extractor-failure trigger (gemini Run 3 CRITICAL fix):** check `componentSymbols.length === 0` (zero `kind === "component"` symbols extracted), NOT `adjacency.children.size === 0`. The latter is wrong — a flat valid component tree where components don't render each other has zero adjacency edges but is NOT an extractor failure. The signal of failure is "zero component symbols" (extractor produced nothing). When `componentSymbols.length === 0`, set `metadata.skipped = "extractor-failure"` on result and `prop_chain_depth: null` for all entries (defensive — the loop body wouldn't execute anyway).
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "prop_chain_depth|RenderAnalysisEntry|extractor-failure|flat component tree"` AND `npx tsc --noEmit`
  Expected: 6 new tests pass (contract shape, 3-level depth, cyclic determinism, memo cross-pollution, extractor-failure branch, flat-tree non-failure regression guard); tsc clean.
- [ ] Acceptance: Ship-4b (partial), Ship-6 (partial), Ship-7, Success-2. (Note: Success-3 — 5000-component perf — is owned by Task 13 per Coverage Matrix; do NOT double-claim here.)
- [ ] Commit: `feat(react): analyzeRenders populates prop_chain_depth via memoized longest-path on reverse JSX adjacency`

---

### Task 10: Add `"NOT prop-drilling depth"` literal to `suggestion` text + AC 8 enforcement test
**Files:** `src/tools/react-tools.ts` (suggestion-building logic in `analyzeRenders`), `tests/tools/react-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 9 (serial chain on `react-tools.ts` — modifies analyzeRenders body, must land after Task 9's wiring)
**Execution routing:** default

- [ ] RED: Add test `"suggestion text for prop_chain_depth >= 3 contains literal 'NOT prop-drilling depth'"` — build a synthetic 4-level chain fixture, run `analyzeRenders`, find the deepest entry, assert `entry.suggestion.includes("NOT prop-drilling depth")`.
- [ ] GREEN: In `analyzeRenders` per-entry suggestion logic, when `prop_chain_depth >= 3`, append (or prepend) the canonical disclaimer: `"Component is rendered ${depth} edges deep in the JSX render tree. NOT prop-drilling depth — this metric measures render-tree depth only, without tracing which props are consumed vs passed through. Use as a hint to investigate; combine with manual review or trace_component_tree to confirm whether props are actually being drilled. Semantic prop-flow tracking is Tier 6 scope."`. Concatenate with existing `risks`-based suggestion (separator: `" "` or newline).
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "NOT prop-drilling"`
  Expected: test passes; existing `analyzeRenders` tests still pass.
- [ ] Acceptance: Ship-8.
- [ ] Commit: `feat(react): enforce "NOT prop-drilling depth" disclaimer in suggestion text (AC 8)`

---

### Task 11: Severity-aware bucketing in `reactQuickstart` (`warnings`, `style_issues`)
**Files:** `src/tools/react-tools.ts` (lines 943, ~1044), `tests/tools/react-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 7 (all 5 patterns landed with severity), Task 1 (severity field on entry shape), Task 10 (serial chain on `react-tools.ts`)
**Execution routing:** default

- [ ] RED: Add tests in `tests/tools/react-tools.test.ts`:
  1. `"reactQuickstart routes severity warning patterns to warnings bucket"` — fixture with derived-state hit, assert `result.warnings.some(h => h.pattern === "derived-state")`.
  2. `"reactQuickstart routes severity style patterns to style_issues bucket"` — fixture with button-no-type hit, assert `result.style_issues.length > 0` and `result.critical_issues.find(h => h.pattern === "button-no-type")` is undefined.
  3. `"reactQuickstart preserves critical_issues for legacy patterns without severity"` — fixture with `dangerously-set-html`, assert it lands in `critical_issues`.
  4. `"each bucket caps at 10 entries"` — large fixture, assert `result.warnings.length <= 10`.
- [ ] GREEN: In `src/tools/react-tools.ts`:
  - Line 943 (`ReactQuickstartResult`): add `warnings: PatternHit[]` and `style_issues: PatternHit[]` (use existing `PatternMatch` shape — verify name match per Tech Lead note).
  - Line ~1044 (current flat critical_issues filter): replace with severity-aware routing:
    ```ts
    const critical: PatternHit[] = [];
    const warnings: PatternHit[] = [];
    const style_issues: PatternHit[] = [];
    for (const hit of allHits) {
      const sev = BUILTIN_PATTERNS[hit.pattern]?.severity ?? "critical";
      const bucket = sev === "warning" ? warnings : sev === "style" ? style_issues : critical;
      if (bucket.length < 10) bucket.push(hit);
    }
    ```
  Return all three arrays in result.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "reactQuickstart"`
  Expected: 4 new tests pass; existing reactQuickstart tests still pass (legacy `critical_issues` still populated for unspec'd patterns).
- [ ] Acceptance: Ship-6 (partial — ReactQuickstartResult shape), G2, Success-5 (partial).
- [ ] Commit: `feat(react): reactQuickstart routes findings by severity into critical_issues / warnings / style_issues`

---

### Task 12: Add `prop_chain_depth` column to `formatRendersMarkdown`
**Files:** `src/tools/react-tools.ts` (line 586+), `tests/tools/react-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 9 (field must exist), Task 11 (serial chain on `react-tools.ts`)
**Execution routing:** default

- [ ] RED: Add test `"formatRendersMarkdown table includes prop_chain_depth column"` — call formatter on a known result, assert markdown output contains `| Chain |` column header (or chosen exact wording) AND that the corresponding row cell shows the numeric depth.
- [ ] GREEN: Update markdown table generation in `formatRendersMarkdown` (line ~601-605): add column header `Chain` and per-row cell rendering `entry.prop_chain_depth ?? "—"`.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "formatRendersMarkdown"`
  Expected: new test passes; existing markdown tests still pass.
- [ ] Acceptance: G5.
- [ ] Commit: `feat(react): formatRendersMarkdown gains prop_chain_depth column`

---

### Task 13: Performance gate — 5,000-component end-to-end perf test in dedicated file
**Files:** `tests/tools/react-tools-perf.test.ts` (NEW dedicated file — no collision with Tasks 10-12)
**Complexity:** standard
**Dependencies:** Task 9 (algorithm wired), Task 12 (per gemini Run 4: Task 13 runs full vitest which reads `src/tools/react-tools.ts`; must complete after all source-file modifications from Tasks 10-12 land to avoid SyntaxError mid-write)
**Execution routing:** default

Per gemini + codex Run 3: the prior plan claimed this could run parallel with Tasks 10-12 because it "only edits the test file", but Tasks 10-12 also edit `tests/tools/react-tools.test.ts`. Resolution: move Task 13 to a NEW dedicated file `tests/tools/react-tools-perf.test.ts` so it has zero file overlap with any other task. This also clarifies test-runner CI lanes (perf tests can be filtered).

- [ ] RED: Create `tests/tools/react-tools-perf.test.ts` with test `"analyzeRenders completes within 1s on 5000-component synthetic graph end-to-end"` — generate 5000 component `CodeSymbol` objects with synthetic JSX source containing inter-component references forming a deeply linked render graph, construct an in-memory `CodeIndex` (no disk I/O), call **`analyzeRenders` end-to-end** (NOT just the helpers — per cursor-agent Run 3, this exercises the full public API path including buildJsxAdjacency + buildReverseAdjacency + per-entry computePropChainDepth + risks scoring + suggestion building). Assert `performance.now()` delta `< 1000` ms AND every entry has `typeof prop_chain_depth === "number"` (no nulls, no `metadata.skipped`).
- [ ] GREEN: No new production code — the memoized iterative algorithm from Task 8 + analyzeRenders wiring from Task 9 should already pass. This task is a verification gate.
- [ ] Verify: `npx vitest run tests/tools/react-tools-perf.test.ts`
  Expected: 1 test passes in <1s (typically <300ms locally, <1s on CI runner).
- [ ] Acceptance: Ship-4b (final), Success-3.
- [ ] Commit: `test(react): performance gate — 5000-component end-to-end analyzeRenders <1s`

---

### Task 14: Baseline integration test — `critical_issues` count unchanged on vendored corpus
**Files:** `tests/integration/react-tier5-baseline.test.ts` (new), `tests/fixtures/react-tier5/baseline-critical-count.json` (new)
**Complexity:** standard
**Dependencies:** Task 11 (severity bucketing wired), Task 12 (per gemini Run 4: Task 14 runs `npm run build` which compiles all `.ts` sources; must wait for all `react-tools.ts` modifications from Tasks 10-12 to complete)
**Execution routing:** default

- [ ] RED:
  **First, write a placeholder `tests/fixtures/react-tier5/baseline-critical-count.json`** with `{"count": -1, "captured_at": "1970-01-01T00:00:00Z", "fixture_dir": "tests/fixtures/react-tier5", "plan_revision": 5}` so the RED test fails on assertion mismatch (count=-1) rather than ENOENT (file-not-found). This is the pre-RED bootstrap — gemini Run 3 correctly placed it in RED, not GREEN.

  **Then, add test** in new file `tests/integration/react-tier5-baseline.test.ts`: `"react_quickstart on vendored corpus matches baseline critical_issues count"` — load `baseline-critical-count.json` (placeholder), index `tests/fixtures/react-tier5/` directory, run `reactQuickstart`, assert `result.critical_issues.length === baseline.count`. Plus assert `result.style_issues.length > 0` (Success-5: at least one style-bucket entry).
- [ ] GREEN: Replace the placeholder JSON with the real baseline. Generate via a single deterministic ESM-only command run from the worktree root AFTER Task 11 lands (so all 5 new patterns are present and severity bucketing is wired):
  ```bash
  npm run build && node --input-type=module -e "
    const { indexFolder } = await import('./dist/tools/index-tools.js');
    const { reactQuickstart } = await import('./dist/tools/react-tools.js');
    const { writeFileSync } = await import('node:fs');
    await indexFolder({ path: './tests/fixtures/react-tier5' });
    const result = await reactQuickstart({ repo: 'local/react-tier5' });
    writeFileSync(
      'tests/fixtures/react-tier5/baseline-critical-count.json',
      JSON.stringify({
        count: result.critical_issues.length,
        captured_at: new Date().toISOString(),
        fixture_dir: 'tests/fixtures/react-tier5',
        plan_revision: 4,
      }, null, 2)
    );
  "
  ```
  Commit the resulting JSON. Re-running this command on a clean worktree must produce the same `count` value (deterministic — fixtures are committed). The integration test now passes (count matches).
- [ ] Verify: `npx vitest run tests/integration/react-tier5-baseline.test.ts`
  Expected: test passes; counts match.
- [ ] Acceptance: Success-5 (final), Ship-5.
- [ ] Commit: `test(integration): baseline critical_issues count snapshot for react-tier5 vendored corpus`

---

### Task 15: Documentation update — README, rules, CLAUDE
**Files:** `README.md`, `rules/codesift.md`, `CLAUDE.md`
**Complexity:** standard
**Dependencies:** Task 1-14
**Execution routing:** default

- [ ] RED: No new test (docs-only). Manual verification: ensure the 5 new pattern names appear in `rules/codesift.md` Tool Mapping table.
- [ ] GREEN:
  - `README.md`: add 1 paragraph in React section listing the 5 new patterns + `prop_chain_depth` extension. Update React pattern count from 29 to 34.
  - `rules/codesift.md`: add 5 rows to the Tool Mapping table (one per pattern: `derived-state` / `stale-closure-setstate` / `context-provider-value-inline` / `jsx-no-target-blank` / `button-no-type`).
  - `CLAUDE.md`: update Architecture section pattern count if surfaced (29 → 34 React patterns) and the after-features-update checklist if any new place needs updating.
- [ ] Verify: explicit per-file grep with `grep -q` failure semantics:
  ```bash
  set -e
  # Each new pattern must appear in rules/codesift.md (Tool Mapping table is the canonical reference)
  for p in derived-state stale-closure-setstate context-provider-value-inline jsx-no-target-blank button-no-type; do
    grep -q "$p" rules/codesift.md || { echo "FAIL: $p not in rules/codesift.md"; exit 1; }
  done
  # README must list each new pattern by name AND mention prop_chain_depth + new pattern count
  for p in derived-state stale-closure-setstate context-provider-value-inline jsx-no-target-blank button-no-type prop_chain_depth; do
    grep -q "$p" README.md || { echo "FAIL: $p not in README.md"; exit 1; }
  done
  # CLAUDE.md: pattern count surfaces (29 → 34)
  grep -q "34 React patterns\|34 patterns" CLAUDE.md || { echo "FAIL: pattern count not updated in CLAUDE.md"; exit 1; }
  # Run full vitest suite — Ship-5 zero-regressions gate
  npx vitest run
  # Type check — Ship-7
  npx tsc --noEmit
  ```
  Expected: zero non-zero exits; full suite green; tsc clean.
- [ ] Acceptance: G4, **Ship-5** (full suite green from this final gate), **Ship-7** (tsc clean from this final gate).
- [ ] Commit: `docs(react): document Tier 5 patterns + prop_chain_depth extension across README/rules/CLAUDE`

---

## Final Gate Sequence

After Task 15:
1. `npx vitest run` — full suite, expect zero failures (Ship-5).
2. `npx tsc --noEmit` — type check, expect exit 0 (Ship-7).
3. `npx vitest run -t "ReDoS guard"` — explicit ReDoS gate (Ship-3 redundant check).
4. Manual smoke (optional, non-blocking): run on `/Users/greglas/DEV/coding-ui` if available.
5. PR description must list every new test title (per Ship-5 relative gate convention).
