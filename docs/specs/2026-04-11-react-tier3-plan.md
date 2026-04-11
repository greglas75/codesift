# Implementation Plan: React Infrastructure Tier 3

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 16
**Estimated complexity:** 14 standard + 2 complex

## Context

This plan closes out the React infrastructure work that was scoped during the same session as Waves 1-4 + Tiers 1-1.5. Real-world smoke testing on `/Users/greglas/DEV/coding-ui` (React 19 + Vite, 591 files, 7672 symbols) revealed four regex bugs plus gaps in detection coverage. This plan fixes those bugs, adds the missing detections, and wires the React tools into audit/review/report pipelines so React projects get zero-config coverage.

**Why now:** CodeSift already ships React tools that auto-enable on React projects. Without these fixes, users see false positives (bug #1) and miss real issues (bugs #2, #3) — a worse experience than not shipping at all. The 4 bugs are the minimum; tiers 3a-detections and 3b-integration multiply the value of the existing infrastructure.

**Out of scope:** Tier 3c advanced items 16, 17, 18, 20 (props interface linking, hook dep validation Phase 2, RSC prop serializability, JSX props usage). These require cross-file type resolution / interprocedural analysis — they belong in a separate spec. Item 10 (context graph) is included at basic level without cycle detection. Item 19 (React 19 features) is included as two simple detection patterns.

## Architecture Summary

Work touches 8 files in 4 module clusters:

- **Pattern detection** — `src/tools/pattern-tools.ts` (regex fixes + new patterns) + its test file
- **React analysis** — `src/tools/react-tools.ts` (threshold fix, new helpers, markdown format) + its test file
- **Symbol context** — `src/tools/symbol-tools.ts` (CQ14 consolidation, forwardRef generics)
- **Project conventions** — `src/tools/project-tools.ts` (shadcn, Tailwind, forms, alias detection)
- **Integration** — `src/tools/audit-tools.ts`, `src/tools/review-diff-tools.ts`, `src/tools/report-tools.ts`

Dependencies (from Architect report): `searchPatterns` is called by both `audit-tools` and `review-diff-tools`, so regex fixes cascade automatically once applied. `analyzeHooks`/`analyzeRenders` are called only by their MCP tools + tests, so threshold changes are isolated.

## Technical Decisions

**Regex vs tree-sitter:** Stay with regex for all pattern fixes. Tree-sitter was considered for nested-component-def (item 1) but adds dispatch complexity and a new fallback path. Instead, fix the regex by requiring an outer `function`/`const` context before the inner component declaration.

**REACT_STDLIB_HOOKS consolidation (CQ14):** Single export from `react-tools.ts`, import in `symbol-tools.ts`. Adds a regression test asserting both references are the same Set.

**analyzeRenders threshold formula:** Factor `children_count` into risk_level. New thresholds: `high = (risks ≥ 3 && children ≥ 3) || risks ≥ 5`, `medium = risks ≥ 2 || (risks ≥ 1 && children ≥ 1)`, else `low`. Verified against coding-ui smoke test data (all 5 found components had `risks=4, children≥4` — all should classify as `high`, not `medium`).

**Detection strategy (items 5-9):** Dependency-first then import-scan fallback. Path heuristics for shadcn (`components/ui/`). Heuristic alias resolution for `@/` (check `src/`, then `lib/`, then root).

**Context graph (item 10):** Simple one-pass helper `buildContextGraph` in `react-tools.ts` — no cycle detection (Phase 2). Returns `{ contexts: [{name, created_in_file, providers: [{file, line}], consumers: [{file, name, line}]}] }`.

**Markdown output (item 14):** New formatter helper `formatRendersMarkdown(result)` in `react-tools.ts`. Added as `format?: "json" | "markdown"` parameter to `analyzeRenders` with JSON default for backward compat.

**Integration strategy (items 11-13):** Extend existing functions rather than create new tools. `audit_scan` gains a React gate that calls React-specific patterns. `review_diff` gains `.tsx` filter that runs React patterns on changed symbols. `generate_report` gains a React section when `kind=component` symbols exist.

## Quality Strategy

**Active CQ gates:**
- **CQ14 (duplication):** CRITICAL — REACT_STDLIB_HOOKS duplicated in two files. Fixed first (Task 1).
- **CQ8 (errors):** HIGH — regex ReDoS risk on items 1-2. Mitigation: bounded file size via existing searchPatterns truncation.
- **CQ11 (structure):** MEDIUM — react-tools.ts currently ~620 LOC. Adding contextGraph + formatters approaches 750. Split considered but deferred (single-file keeps imports simple; split = separate refactor task).
- **CQ25 (consistency):** MEDIUM — new BUILTIN_PATTERNS entries must match existing `{regex, description, fileExcludePattern?, fileIncludePattern?}` shape.

**Critical Q gates:**
- **Q7 (error paths):** Every regex task gets positive + negative tests
- **Q11 (branches):** Task 5 (threshold) must test all 4 branches of risk_level formula
- **Q17 (computed output):** Task 6 (markdown) verifies formatted output structure not input echo

**Test strategy:**
- Unit tests via direct regex access (BUILTIN_PATTERNS is exported)
- Integration validation via smoke test on `/Users/greglas/DEV/coding-ui` at Task 16
- Regression protection: before/after assertions in test names (`it("matches hook after multiline if — fixes Bug #2")`)

**Risk flags for implementer:**
1. Task 2 (hook-in-condition multiline): `[\s\S]*?` with no upper bound could match across unrelated blocks. Mitigation: test with multiple if-blocks in same function.
2. Task 5 (threshold): smoke test data shows every component with `risks=4`. New formula must NOT over-classify as high. Mitigation: test medium case with `risks=2, children=0`.
3. Task 12 (context graph): no cycle detection. If recursive component references exist, infinite loop risk. Mitigation: visited set even without full cycle detection + explicit max-depth param.

## Task Breakdown

### Task 1: Consolidate REACT_STDLIB_HOOKS (CQ14 fix)
**Files:**
- `src/tools/symbol-tools.ts` (modify — remove local REACT_STDLIB_HOOKS_SET, import from react-tools.js)
- `tests/tools/react-tools.test.ts` (modify — add regression assertion)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add test in `tests/tools/react-tools.test.ts` asserting `symbol-tools` uses the same `REACT_STDLIB_HOOKS` set exported from `react-tools`. Test name: `"symbol-tools imports REACT_STDLIB_HOOKS from react-tools (CQ14 — no duplication)"`. Assert via dynamic import that both modules reference the same Set instance.
- [ ] GREEN: In `src/tools/symbol-tools.ts`, remove local `REACT_STDLIB_HOOKS_SET` constant (~line 619). Import `REACT_STDLIB_HOOKS` from `./react-tools.js`. Update `buildReactContext` to use the imported set.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts`
  Expected: all existing tests plus the new regression test pass (0 failures).
- [ ] Acceptance: CQ14 duplication eliminated; single source of truth for React stdlib hook names.
- [ ] Commit: `refactor(react): consolidate REACT_STDLIB_HOOKS to single source (CQ14)`

---

### Task 2: Fix hook-in-condition regex (Bug #2, multiline support)
**Files:**
- `src/tools/pattern-tools.ts` (modify BUILTIN_PATTERNS entry)
- `tests/tools/pattern-tools.test.ts` (modify — add multiline fixture tests)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: In `tests/tools/pattern-tools.test.ts`, add three tests:
  1. Positive: `"matches useState inside multiline if block"` with source where the hook call appears 3 lines after the `{`. Assert regex matches.
  2. Negative: `"does not match hook at function top-level"` — hook NOT inside any conditional (top-level of function body) must not match.
  3. Performance/ReDoS guard: `"completes within 50ms on 10KB adversarial input"` — synthetic fixture with 500 `if (x) {` prefixes and no matching hook. Assert regex completes in under 50ms (`performance.now()` around `regex.test()` call).
- [ ] GREEN: In `src/tools/pattern-tools.ts`, change `hook-in-condition` regex from `/\b(?:if|for|while|switch)\s*\([^)]*\)\s*\{[^}]*\buse[A-Z]\w*\s*\(/` to `/\b(?:if|for|while|switch)\s*\([^)]*\)\s*\{[\s\S]{0,500}?\buse[A-Z]\w*\s*\(/`. The `[\s\S]{0,500}?` supports newlines but bounds scope to prevent ReDoS and cross-block matches.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "hook-in-condition"`
  Expected: all hook-in-condition tests pass including the new multiline case.
- [ ] Acceptance: Bug #2 closed. Hook called inside multi-line if/for/while/switch now detected.
- [ ] Commit: `fix(react): hook-in-condition matches multiline blocks (Bug #2)`

---

### Task 3: Fix useEffect-async regex (Bug #3, more variants)
**Files:**
- `src/tools/pattern-tools.ts` (modify)
- `tests/tools/pattern-tools.test.ts` (modify — add variant tests)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add tests for: (a) `useEffect(async () => { ... })` (current case), (b) `useEffect(async function() { ... })`, (c) `useEffect(\n  async () => {...}\n)` with whitespace/newlines. All must match. Negative: `useEffect(() => { async function load() { ... } load(); }, [])` must NOT match (that's the correct pattern).
- [ ] GREEN: Replace regex `/useEffect\s*\(\s*async\s/` with `/useEffect\s*\(\s*(?:async\s+(?:function\b|\([^)]*\)\s*=>))/`. The alternation covers async arrow AND async function expression.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "useEffect-async"`
  Expected: all 4 new variant tests pass; existing tests unchanged.
- [ ] Acceptance: Bug #3 closed. Async variants of useEffect detected; proper inner-async-wrapper not flagged.
- [ ] Commit: `fix(react): useEffect-async matches function expression and multiline (Bug #3)`

---

### Task 4: Fix nested-component-def regex (Bug #1, false positives)
**Files:**
- `src/tools/pattern-tools.ts` (modify)
- `tests/tools/pattern-tools.test.ts` (modify — add FP regression test)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add FP test `"does NOT match top-level function component"` with source `function VirtualizedTable({ items }) { return <div/>; }` (a module-level component declaration). Assert regex does NOT match. Keep existing positive test.
- [ ] GREEN: The current regex `/(?:function|const)\s+[A-Z]\w*\s*(?:=\s*(?:\([^)]*\)\s*=>|\(\)\s*=>)|(?:\([^)]*\)\s*\{))[\s\S]{0,2000}?(?:function|const)\s+[A-Z]\w*\s*(?:=\s*\(|[\s\S]{0,50}?return\s*(?:<|\())/` matches ANY file with two PascalCase functions in sequence. Replace with a scoped pattern that requires an outer function body: `/(?:function\s+[A-Z]\w*\s*\([^)]*\)\s*\{|const\s+[A-Z]\w*\s*=\s*(?:\([^)]*\)|[\w$]*)\s*=>\s*\{)[\s\S]{0,1500}?\n\s{2,}(?:function\s+[A-Z]\w*\s*\(|const\s+[A-Z]\w*\s*=\s*\()/`. The `\n\s{2,}` requires indentation (inner function), preventing module-level matches.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "nested-component-def"`
  Expected: FP test passes (no match on top-level), existing positive test still matches nested case.
- [ ] Acceptance: Bug #1 closed. Top-level components no longer flagged; genuine nested components still detected.
- [ ] Commit: `fix(react): nested-component-def requires indented inner function (Bug #1)`

---

**Early smoke checkpoint after Task 4:** After completing Task 4's nested-component-def regex fix, run `npx vitest run tests/tools/pattern-tools.test.ts` and also invoke `searchPatterns(repo="local/coding-ui", pattern="nested-component-def")` manually to verify no more top-level false positives on real code before proceeding. If FPs remain, fix before Task 5.

### Task 5: Fix analyzeRenders threshold with children_count factor (Bug #4)
**Files:**
- `src/tools/react-tools.ts` (modify analyzeRenders risk_level logic)
- `tests/tools/react-tools.test.ts` (modify — add threshold branch tests)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add tests asserting all 3 risk levels:
  1. `"classifies as high when risks=3 and children=3 (new formula)"` — synthetic component with 3 inline props + 3 child JSX elements.
  2. `"classifies as high when risks=5 (legacy formula still works)"` — 5+ inline props regardless of children.
  3. `"classifies as medium when risks=2 and children=0 (below children threshold)"` — 2 risks, no children.
  4. `"classifies as low when risks=0"` — clean component.
- [ ] GREEN: In `src/tools/react-tools.ts` `analyzeRenders`, locate the `risk_level` ternary (around line 585 after construction of `risks` and `children_count`). Replace with:
  ```ts
  const risk_level: "low" | "medium" | "high" =
    ((risks.length >= 3 && children_count >= 3) || risks.length >= 5) ? "high"
    : (risks.length >= 2 || (risks.length >= 1 && children_count >= 1)) ? "medium"
    : "low";
  ```
  The new formula weights components that render many children (amplification factor) as higher risk.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "analyzeRenders"`
  Expected: 4 new branch tests pass; existing analyzeRenders tests unchanged.
- [ ] Acceptance: Bug #4 closed. Threshold formula now produces `high` results on realistic components (coding-ui smoke test: 5 components with risks=4, children≥4 will classify as high).
- [ ] Commit: `fix(react): analyzeRenders threshold factors children_count (Bug #4)`

---

**Early smoke checkpoint after Task 5:** After completing Task 5's threshold fix, run `analyzeRenders(repo="local/coding-ui")` manually and verify at least 1 component classifies as `high` (smoke test baseline: 5 components with risks=4, children≥4 should now be high). If threshold is too strict/loose, tune before moving on.

### Task 6: Add shadcn/ui detection to ReactConventions (Item 5)
**Files:**
- `src/tools/project-tools.ts` (modify extractReactConventions)
- `tests/tools/project-tools.test.ts` (modify — add shadcn detection tests)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add test `"detects shadcn when components/ui files exist"`. Create fake files list `[{ path: "src/components/ui/button.tsx" }, { path: "src/components/ui/dialog.tsx" }]`. Assert `ui_library === "shadcn"` in the result. Add negative test: `components/ui/button.ts` (no .tsx) should not count.
- [ ] GREEN: In `extractReactConventions`, before the existing `ui_library` detection block, add:
  ```ts
  // shadcn/ui detection: canonical path pattern is components/ui/*.tsx
  const hasShadcnFiles = files.some((f) =>
    /(^|\/)components\/ui\/[a-z-]+\.(tsx|jsx)$/.test(f.path)
  );
  if (hasShadcnFiles) ui_library = "shadcn";
  ```
  Place BEFORE the existing `if (deps["@mui/material"])` chain so shadcn takes precedence when paths match. Fall through to existing logic if no shadcn files.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts -t "shadcn"`
  Expected: both new tests pass; existing ui_library tests unchanged.
- [ ] Acceptance: shadcn/ui detected from file structure. Most popular React UI kit in 2025 now surfaced in ReactConventions.
- [ ] Commit: `feat(react): detect shadcn/ui via components/ui path pattern (Item 5)`

---

### Task 7: Detect Tailwind as ui_library when other libs absent (Item 6)
**Files:**
- `src/tools/project-tools.ts` (modify)
- `tests/tools/project-tools.test.ts` (modify — add Tailwind test)

**Complexity:** standard
**Dependencies:** Task 6
**Execution routing:** default

- [ ] RED: Add test `"detects tailwind as ui_library when tailwindcss dep present and no other UI lib"` — deps = `{ tailwindcss: "^3.4.0" }`. Assert `ui_library === "tailwind"`. Negative: when shadcn is detected (from Task 6), `ui_library` stays `"shadcn"` even if tailwind is also in deps.
- [ ] GREEN: The existing code already checks `deps["tailwindcss"]` but marks it as the last fallback. Reorder so shadcn (Task 6) takes precedence, then mui/chakra/antd/radix, then tailwind. Verify the existing `else if (deps["tailwindcss"])` line remains — if not, add it.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts -t "tailwind"`
  Expected: tailwind test passes; shadcn precedence preserved.
- [ ] Acceptance: Tailwind-only projects now show `ui_library: "tailwind"` instead of `null`.
- [ ] Commit: `feat(react): detect tailwind as ui_library fallback (Item 6)`

---

### Task 8: Detect form libraries in ReactConventions (Item 7)
**Files:**
- `src/tools/project-tools.ts` (modify — add form_library field)
- `tests/tools/project-tools.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Task 6, Task 7 (all three mutate extractReactConventions — sequential chain prevents merge conflicts and test fixture drift)
**Execution routing:** default

- [ ] RED: Add tests for each detection:
  - `"detects react-hook-form when dep present"` → `form_library: "react-hook-form"`
  - `"detects formik when dep present"` → `form_library: "formik"`
  - `"detects final-form when dep present"` → `form_library: "final-form"`
  - `"form_library null when no form lib"` → `form_library: null`
- [ ] GREEN: In `ReactConventions` interface, add field `form_library: string | null`. In `extractReactConventions`, after the state_management block, add:
  ```ts
  let form_library: string | null = null;
  if (deps["react-hook-form"]) form_library = "react-hook-form";
  else if (deps["formik"]) form_library = "formik";
  else if (deps["final-form"] || deps["react-final-form"]) form_library = "final-form";
  ```
  Include `form_library` in the returned object.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts -t "form_library"`
  Expected: 4 new tests pass; existing ReactConventions tests unchanged (additive field).
- [ ] Acceptance: Form library detection added to ReactConventions. Popular libs detected.
- [ ] Commit: `feat(react): detect form libraries in ReactConventions (Item 7)`

---

### Task 9: Fix forwardRef generics detection (Item 9)
**Files:**
- `src/tools/symbol-tools.ts` (modify buildReactContext wrapper detection)
- `src/tools/project-tools.ts` (modify extractReactConventions component_patterns counter)
- `tests/tools/react-tools.test.ts` (modify — add generics test)

**Complexity:** standard
**Dependencies:** Task 1 (also edits symbol-tools.ts — must run after CQ14 consolidation to avoid conflict with import statements), Task 8 (also edits project-tools.ts — sequential after Tasks 6-8 prevents merge conflicts on extractReactConventions)
**Execution routing:** default

- [ ] RED: Add test `"detects forwardRef with TypeScript generics as component wrapper"`. Source: `const Button = forwardRef<HTMLButtonElement, Props>((props, ref) => <button ref={ref}/>)`. Build a component symbol fixture, call buildReactContext, assert `react_context.wrapper === "forwardRef"`. Same for `React.forwardRef<...>(...)`.
- [ ] GREEN: In `src/tools/symbol-tools.ts` around line 670, change `/\b(?:React\.)?forwardRef\s*\(/` to `/\b(?:React\.)?forwardRef\s*(?:<[^>]+>)?\s*\(/`. Apply the same update to the `memo` pattern (future-proofing). In `src/tools/project-tools.ts` `extractReactConventions`, update the `component_patterns.forwardRef` counter regex with the same fix.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "forwardRef"` and `npx vitest run tests/tools/project-tools.test.ts -t "component_patterns"`
  Expected: generics test passes on both; existing non-generic tests still pass.
- [ ] Acceptance: TypeScript `forwardRef<T, P>(...)` now detected as component wrapper. Pattern extraction count accurate.
- [ ] Commit: `fix(react): forwardRef detection supports TS generics (Item 9)`

---

### Task 10: Add @/ alias resolution heuristic (Item 8)
**Files:**
- `src/utils/react-alias.ts` (new — small utility)
- `tests/utils/react-alias.test.ts` (new)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Create `tests/utils/react-alias.test.ts`. Test cases:
  1. `"resolves @/components/Foo to src/components/Foo when src exists"` — given repo files `["src/components/Foo.tsx"]`, `resolveAlias("@/components/Foo", files)` returns `"src/components/Foo.tsx"`.
  2. `"resolves to lib/ as fallback"` — files `["lib/util.ts"]`, resolve `"@/util"` returns `"lib/util.ts"`.
  3. `"resolves to root when neither src nor lib"` — files `["components/Foo.tsx"]`, resolve `"@/components/Foo"` returns `"components/Foo.tsx"`.
  4. `"returns null for non-alias imports"` — `"react"` returns null.
- [ ] GREEN: Create `src/utils/react-alias.ts` exporting:
  ```ts
  export function resolveAlias(
    importPath: string,
    files: { path: string }[],
  ): string | null {
    if (!importPath.startsWith("@/")) return null;
    const rest = importPath.slice(2);
    const candidates = [`src/${rest}`, `lib/${rest}`, rest];
    const extensions = [".tsx", ".jsx", ".ts", ".js", "/index.tsx", "/index.ts"];
    for (const base of candidates) {
      for (const ext of extensions) {
        const target = base + ext;
        if (files.some((f) => f.path === target)) return target;
      }
    }
    return null;
  }
  ```
- [ ] Verify: `npx vitest run tests/utils/react-alias.test.ts`
  Expected: all 4 cases pass.
- [ ] Acceptance: @/ aliases (Vite, Next.js convention) can be resolved heuristically. Unblocks future trace_component_tree enhancement.
- [ ] Commit: `feat(react): heuristic @/ alias resolution utility (Item 8)`

---

### Task 11: Add markdown output format to analyzeRenders (Item 14)
**Files:**
- `src/tools/react-tools.ts` (modify — add format parameter + formatter)
- `tests/tools/react-tools.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Task 5
**Execution routing:** default

- [ ] RED: Add test `"analyzeRenders returns markdown when format='markdown'"`. Call with a fixture component having 2 risks. Assert result is a string starting with `"# Render Analysis"` and contains `"| Component |"` (markdown table header) and the component name.
- [ ] GREEN: Add new function `formatRendersMarkdown(result: AnalyzeRendersResult): string` that produces:
  ```
  # Render Analysis
  
  Total components: N | High risk: M
  
  ## Summary
  - inline_objects: N
  - inline_arrays: N
  ...
  
  ## Entries
  
  | Component | File | Risk | Issues | Children |
  |-----------|------|------|--------|----------|
  | Foo       | ...  | high | 4      | 3        |
  ```
  Add `format?: "json" | "markdown"` to `analyzeRenders` options. Change return type to `Promise<AnalyzeRendersResult | string>` (discriminated union). When `format === "markdown"`, return `formatRendersMarkdown(jsonResult)`. No `as any` cast — type-check must pass. Also add a type-discrimination test: `"returns object when format='json'"` and `"returns string when format='markdown'"` using `typeof result === "string"` assertion.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "markdown"`
  Expected: markdown test passes; default JSON tests unchanged.
- [ ] Acceptance: Markdown output available for agents/CLIs that prefer human-readable. JSON remains default.
- [ ] Commit: `feat(react): analyzeRenders markdown output format (Item 14)`

---

### Task 12: Add buildContextGraph helper for React context mapping (Item 10)
**Files:**
- `src/tools/react-tools.ts` (modify — new helper)
- `tests/tools/react-tools.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 11 (sequential because both modify react-tools.ts; prevents merge conflicts on shared file)
**Execution routing:** deep

**De-risking note (handle in two passes):** Because this is the only `complex` task and is scheduled at position 12/16, the implementer SHOULD complete the spike pass BEFORE starting Tasks 6-11 to surface feasibility risk early:
1. **Spike pass (≤30 min, do after Task 5):** Implement only the regex extraction part — given a fixture with `const AuthContext = createContext(...)`, can `extractContextDefs(symbols)` find it? Stub return type, write 1 happy-path test, run it. If it works, full Task 12 is safe. If not, escalate before more code lands.
2. **Full implementation:** Resume normal task order (Task 12 comes after Task 11 as planned). The spike code can be promoted directly into the helper.

This addresses risk concentration: the highest-uncertainty work gets touched at position 5.5 instead of 12.

**Spike note (done during planning):** Verified `CodeSymbol.source` is populated for component symbols (see `extractReactConventions` already scanning `sym.source` for hook calls at project-tools.ts). Cross-file detection works by iterating all component symbols and regex-scanning each `.source` string — same pattern as `buildReactContext` in symbol-tools.ts. No new extraction API needed.

**Safety guard:** Helper has hard iteration cap of 500 component symbols max (same as existing `MAX_TREE_NODES` in graph-tools) and uses a `visited: Set<string>` to avoid re-processing the same context name. No recursion — single linear scan.

- [ ] RED: Add tests for context graph construction:
  1. `"builds graph from createContext call"` — fixture with `const AuthContext = createContext<User | null>(null)`, Provider usage in one file, useContext consumer in another. Assert result has one context named `AuthContext` with one provider and one consumer.
  2. `"handles multiple contexts in one repo"` — two createContext calls, assert both in `contexts[]`.
  3. `"returns empty when no context usage"` — plain components, result `contexts: []`.
- [ ] GREEN: Export new function + interface:
  ```ts
  export interface ReactContextInfo {
    name: string;
    created_in: { file: string; line: number };
    providers: { file: string; line: number }[];
    consumers: { file: string; component: string; line: number }[];
  }
  export interface ContextGraph {
    contexts: ReactContextInfo[];
  }
  export function buildContextGraph(symbols: CodeSymbol[]): ContextGraph {
    // 1. Scan symbols for createContext calls — extract context name via
    //    regex /const\s+(\w+)\s*=\s*(?:React\.)?createContext/ on source
    // 2. For each context name X, scan component symbols for <X.Provider>
    // 3. For each context name X, scan component symbols for useContext(X)
    // 4. Assemble ReactContextInfo entries
    // Do NOT recurse. No cycle detection (Phase 2).
  }
  ```
  Use a Map<string, ReactContextInfo> keyed by context name while building.
- [ ] Verify: `npx vitest run tests/tools/react-tools.test.ts -t "buildContextGraph"`
  Expected: 3 tests pass.
- [ ] Acceptance: Context graph helper available. No competitor has context flow tracking. Foundation for future "find components re-rendered by X context change" query.
- [ ] Commit: `feat(react): buildContextGraph for createContext→Provider→useContext mapping (Item 10)`

---

### Task 13: Integrate React patterns into audit_scan (Item 11)
**Files:**
- `src/tools/audit-tools.ts` (modify — add React gate)
- `tests/tools/audit-tools.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Tasks 2, 3, 4
**Execution routing:** default

**Precondition (verified during planning):** `dangerously-set-html` (pattern-tools.ts line 63) and `index-as-key` (pattern-tools.ts line 50) already exist in BUILTIN_PATTERNS from Wave 2. No new pattern registration needed — only Tasks 2/3/4 regex fixes are required.

- [ ] RED: Add three tests:
  1. Precondition guard: `"BUILTIN_PATTERNS contains dangerously-set-html and index-as-key (Task 13 prerequisite)"` — import `BUILTIN_PATTERNS` and assert both keys exist. Fail loudly if Wave 2 patterns were removed.
  2. Positive: `"audit_scan includes React pattern checks when React files present"` — indexed fixture repo with a component containing `dangerouslySetInnerHTML`, assert result has a `react` category or React patterns in findings.
  3. Negative: `"audit_scan on empty repo returns no React findings"` — non-React fixture, assert empty React category and no errors thrown.
- [ ] GREEN: In `src/tools/audit-tools.ts` `auditScan`, after the existing CQ8/11/13/14/17 gate sections, add a React gate that calls `searchPatterns` with the new React patterns bundled:
  ```ts
  // React gate — run only if .tsx/.jsx files are present
  const hasReactFiles = index.files.some((f) => /\.(tsx|jsx)$/.test(f.path));
  if (hasReactFiles) {
    const reactPatterns = ["hook-in-condition", "useEffect-async", "dangerously-set-html", "index-as-key", "nested-component-def"];
    for (const p of reactPatterns) {
      const matches = await searchPatterns(repo, p, { max_results: 10 });
      // accumulate into findings
    }
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/audit-tools.test.ts -t "React"`
  Expected: React gate runs on React repos; findings include new patterns. Non-React repos unaffected.
- [ ] Acceptance: `audit_scan` now surfaces React issues by default. React projects get 5+ new categories of audit checks automatically.
- [ ] Commit: `feat(react): audit_scan gate runs React pattern checks on .tsx files (Item 11)`

---

### Task 14: Make review_diff React-aware (Item 12)
**Files:**
- `src/tools/review-diff-tools.ts` (modify checkBugPatterns)
- `tests/tools/review-diff-tools.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Tasks 2, 3, 4
**Execution routing:** default

- [ ] RED: Add two tests:
  1. Positive: `"review_diff flags React anti-patterns on changed .tsx files"` — fixture diff with `dangerouslySetInnerHTML` in a .tsx file, assert React pattern appears in findings.
  2. Negative: `"review_diff skips React checks when only .py files changed"` — fixture diff with Python file only, assert no React patterns fire and existing Python/generic checks still run.
- [ ] GREEN: In `checkBugPatterns` (around line 400 of review-diff-tools.ts), extend the pattern list with React patterns when changed files include `.tsx`/`.jsx`:
  ```ts
  const changedFiles = /* existing logic */;
  const hasReactChanges = changedFiles.some((f) => /\.(tsx|jsx)$/.test(f));
  const patternsToCheck = [
    "empty-catch", "any-type", "await-in-loop", /* existing */
  ];
  if (hasReactChanges) {
    patternsToCheck.push("hook-in-condition", "useEffect-async", "dangerously-set-html", "index-as-key");
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/review-diff-tools.test.ts -t "React"`
  Expected: React fixture triggers pattern findings; non-React diffs unchanged.
- [ ] Acceptance: Code review diff runs React pattern checks on .tsx changes. PR review gains React-specific insights.
- [ ] Commit: `feat(react): review_diff runs React patterns on .tsx changes (Item 12)`

---

### Task 15: Add React section to generate_report HTML output (Item 13)
**Files:**
- `src/tools/report-tools.ts` (modify — add React section builder)
- `tests/tools/report-tools.test.ts` (modify — or create if missing)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add test `"generate_report includes React section when component symbols exist"`. Create fixture with 3 component symbols. Call `generateReport`, assert the HTML output contains `<section` id `react`, component count, and at least one component name. Negative: non-React repo report does NOT contain React section.
- [ ] GREEN: In `src/tools/report-tools.ts`, add function `buildReactSection(index: CodeIndex): string` that returns an HTML fragment when `index.symbols.some((s) => s.kind === "component")`. Fragment includes:
  - Component count (total kind=component)
  - Hook count (total kind=hook)
  - Top 5 components by source length (as complexity proxy)
  - Empty string when no components present.
  
  Call `buildReactSection(index)` from `buildHtml` and inject the result into the generated HTML after the existing stats sections.
- [ ] Verify: `npx vitest run tests/tools/report-tools.test.ts -t "React"`
  Expected: positive and negative cases pass.
- [ ] Acceptance: `generate_report` HTML output shows React stats for React projects. PR reviewers and team leads get React-specific visibility.
- [ ] Commit: `feat(react): generate_report HTML includes React section for component projects (Item 13)`

---

### Task 16: Smoke test on real React repo + README docs update
**Files:**
- `README.md` (modify — document Tier 3 features)
- `docs/review-queue.md` (modify — mark React Tier 3 done)

**Complexity:** standard
**Dependencies:** Tasks 1-15
**Execution routing:** default

- [ ] RED: No new test — this task is verification. Create shell script at `scripts/smoke-react-tier3.sh` (git-tracked, not /tmp):
  ```bash
  # scripts/smoke-react-tier3.sh — Re-index coding-ui, run analyzeRenders,
  # searchPatterns on all Tier 3a patterns, analyze_project, assert expected findings.
  # Also add a vitest integration test at tests/integration/react-tier3-smoke.test.ts
  # that validates against a small in-repo React fixture (not coding-ui, kept for
  # reproducibility in CI).
  ```
- [ ] GREEN: Run the smoke script against coding-ui. Expected results:
  1. `nested-component-def` hits drop from 3 (false positives) to 0 or real nested cases only
  2. `hook-in-condition` hits stay 0 or find legitimate cases (no new false positives)
  3. `useEffect-async` hits stay 0 (clean code)
  4. `analyzeRenders` summary: at least 1 `high` risk component (current: 0)
  5. `analyze_project` shows `ui_library: "shadcn"` or `"tailwind"` for coding-ui (currently null)
  6. `form_library` field populated if coding-ui uses forms
  
  Update `README.md`: add a sentence to the React paragraph (around supported languages section) noting "Tier 3: bug fixes, shadcn/Tailwind/form detection, context graph, audit/review/report integration." Update tool count if new helpers changed it.
- [ ] Verify: `bash scripts/smoke-react-tier3.sh` — manual inspection of output against the 6 criteria above.
- [ ] Acceptance: All 4 bugs fixed on real project; all 5 detections work; integration flows through audit/review/report. README updated.
- [ ] Commit: `docs(react): Tier 3 smoke test validated on coding-ui — update README`

---

## Phase 2 Deferred (separate spec needed)

The following items were descoped from this plan:

- **Item 16**: Props interface linking in get_context_bundle (requires TS type resolution)
- **Item 17**: Hook dependency validation Phase 2 (cross-file analysis)
- **Item 18**: RSC boundary prop serializability (requires TS type checking)
- **Item 19**: React 19 features deep detection (Actions, Server Components patterns)
- **Item 20**: JSX props usage analysis (requires interprocedural flow)
- **Tree-sitter AST query** for nested-component-def (current regex fix is sufficient for now)
- **Fuzzy match on component-not-found errors** (Item 15 — low impact, nice to have)
- **Context graph cycle detection** (Task 12 stubs simple version)

Recommendation: Create `docs/specs/2026-04-XX-react-phase2-spec.md` covering these items as a separate effort focused on deep semantic analysis.

## Acceptance Criteria Summary

| # | Task | Fixes/Adds |
|---|------|------------|
| 1 | CQ14 consolidation | Single REACT_STDLIB_HOOKS source |
| 2 | hook-in-condition | Bug #2 — multiline matching |
| 3 | useEffect-async | Bug #3 — variant coverage |
| 4 | nested-component-def | Bug #1 — false positives eliminated |
| 5 | analyzeRenders threshold | Bug #4 — realistic high-risk classification |
| 6 | shadcn detection | Item 5 |
| 7 | Tailwind detection | Item 6 |
| 8 | Form library detection | Item 7 |
| 9 | forwardRef generics | Item 9 |
| 10 | @/ alias resolution | Item 8 |
| 11 | analyzeRenders markdown | Item 14 |
| 12 | buildContextGraph | Item 10 |
| 13 | audit_scan React gate | Item 11 |
| 14 | review_diff React | Item 12 |
| 15 | generate_report React | Item 13 |
| 16 | Smoke test + docs | Validation + release notes |

## Verification Plan

After all 16 tasks: run `npx vitest run` expecting green across all React-related test files. Manual smoke test on coding-ui (Task 16). Commit each task separately so that bisection works cleanly if any regression surfaces.

<!-- Evidence Map
| Section | Source |
|---------|--------|
| Context | Session memory: Wave 1-4 + Tier 1-1.5 plans + smoke test on /Users/greglas/DEV/coding-ui |
| Architecture Summary | Architect agent report (Phase 1.1) |
| Technical Decisions | Tech Lead agent report (Phase 1.2) |
| Quality Strategy | QA Engineer agent report (Phase 1.3) |
| Task 1 (CQ14) | QA report flagged REACT_STDLIB_HOOKS duplication; symbol-tools.ts:619 REACT_STDLIB_HOOKS_SET + react-tools.ts:21 REACT_STDLIB_HOOKS |
| Tasks 2-5 (bugs) | Smoke test findings: nested-component-def 3 FP, hook-in-condition 0 hits, useEffect-async 0 hits, all analyzeRenders risks=4 |
| Tasks 6-10 (detections) | Project analysis gaps: shadcn/tailwind/forms missing in extractReactConventions |
| Task 12 (context graph) | Tech Lead identified as differentiator; QA flagged cycle risk → simple version without cycle detection |
| Tasks 13-15 (integration) | Tech Lead extension strategy — no new tools, extend audit_scan/review_diff/generate_report |
| Phase 2 Deferred | Tech Lead defer recommendations for items 16-20 |
-->
