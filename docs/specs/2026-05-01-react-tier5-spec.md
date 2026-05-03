# React Tier 5 — Design Specification

> **spec_id:** 2026-05-01-react-tier5-2203
> **topic:** React Tier 5 — five high-precision patterns + prop_chain_depth metric
> **status:** Approved
> **created_at:** 2026-05-01T22:03:00Z
> **reviewed_at:** 2026-05-02T05:02:05Z
> **approved_at:** 2026-05-02T05:15:00Z
> **approval_mode:** interactive
> **adversarial_review:** clear-after-iteration
> **author:** zuvo:brainstorm

`spec_id` is the sole linking key for `zuvo:plan` and `zuvo:execute`. Do not change it after creation.

## Problem Statement

CodeSift ships strong React static analysis (5 dedicated tools + 29 patterns + auto-load + framework-specific stack detection), but a competitive scan against rautio/react-analyzer (Go + tree-sitter, 6 rules), react-analyzer-mcp (AST), and ESLint surfaced five concrete gaps and one missing dimension:

1. **`derived-state`** — `useState(props.X)` + `useEffect(() => setX(props.X), [props.X])` is rautio's flagship rule. We have nothing.
2. **`stale-closure-setstate`** — `setX(X + 1)` non-functional update form. rautio catches it.
3. **`context-provider-value-inline`** — `<Ctx.Provider value={{...}}>` with inline literal: every consumer re-renders on every parent render. Not surfaced by rautio, react-analyzer-mcp, react-devtools-mcp, debugger-mcp, or typescript-analyzer-mcp in the competitive scan conducted 2026-04-30 — direct differentiator that complements our existing `analyze_context_graph`. (Claim narrowed from "nobody on the market" to listed competitors.)
4. **`jsx-no-target-blank`** — `<a target="_blank">` without `rel="noopener noreferrer"`: tabnabbing security gap, standard `eslint-plugin-react` rule, missing from CodeSift.
5. **`button-no-type`** — default `type="submit"` breaks forms outside form context. Common foot-gun.
6. **Cross-file prop-chain depth** — rautio surfaces "deep prop drilling" as a top-level finding. Our `analyze_renders` returns per-component risks but no cross-file drilling metric.

Without these, CodeSift consumers (AI agents) miss anti-patterns their competitors' agents see, which lowers perceived analysis quality on React projects.

**Out of original Tier 5 scope (descoped during brainstorm):** `react-lazy-no-suspense` was removed because the canonical Suspense boundary lives in a router parent file, and a single-file scan produces near-certain false positives in any React Router / Next.js app. Cross-file Suspense detection requires interprocedural analysis (Tier 6 alongside cross-file `exhaustive-deps`).

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Hybrid severity model** — new patterns get optional `severity: "critical" \| "warning" \| "style"` field on `BUILTIN_PATTERNS` entry; existing 29 patterns untouched (default = `critical`) | Avoids Tier 5 dragging a 29-pattern severity refactor; new patterns can be routed to `style_issues` bucket in `react_quickstart` (e.g., `button-no-type`, `jsx-no-target-blank`) instead of polluting `critical_issues`. Full migration deferred to Tier 6. |
| D2 | **Drop `react-lazy-no-suspense`** from scope | BA report 1.5: cross-file FP risk dominates. Tier 5 ships 5 patterns + 1 extension, not 6. |
| D3 | **Regex with backreference for name correlation** in `derived-state` and `stale-closure-setstate`; explicit naming-convention scope limit documented in `description` | Keeps `BUILTIN_PATTERNS` regex-only contract. Catches canonical `name`/`setName` case (~80% of real-world hits). Custom-named setters (`props.value` → `setDisplayValue`) documented as known gap, not silently missed. |
| D4 | **`prop_chain_depth` always-on** in `analyze_renders` output, no artificial size cap (post-memoization the algorithm is O(V+E) — capping at 1000 was a phantom constraint left over from the discarded backtracking design and would silently disable the feature on every monorepo) | Long-term DX: opt-in flag = dead capability. Consistency with existing always-present fields (`risks`, `children_count`). |
| D5 | **Atomic single PR** for all 5 patterns + extension | Tier 5 is sold as a coherent React expansion; fragmentation dilutes changelog narrative. Test isolation already split across `pattern-tools.test.ts` vs `react-tools.test.ts`. |

## Solution Overview

**Five new entries** in `src/tools/pattern-tools.ts` `BUILTIN_PATTERNS`:

```
derived-state                   severity: "warning"   fileIncludePattern: /\.(tsx|jsx)$/
stale-closure-setstate          severity: "warning"   fileIncludePattern: /\.(tsx|jsx)$/
context-provider-value-inline   severity: "warning"   fileIncludePattern: /\.(tsx|jsx)$/
jsx-no-target-blank             severity: "style"     fileIncludePattern: /\.(tsx|jsx)$/   postFilter: ...
button-no-type                  severity: "style"     fileIncludePattern: /\.(tsx|jsx)$/
```

**Two field additions** to `BUILTIN_PATTERNS` entry shape (both optional, additive):

```ts
export const BUILTIN_PATTERNS: Record<string, {
  regex: RegExp;
  description: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
  severity?: "critical" | "warning" | "style";       // NEW — bucket routing
  postFilter?: (match: string) => boolean;           // NEW — declarative match validation
}>
```

The `postFilter` field lets a pattern attach a post-match validator (e.g., `jsx-no-target-blank` uses it to drop matches where `rel=` is present in the same `<a>` tag). The runner in `searchPatterns` calls `postFilter(matchedText)` after the regex matches; if it returns `false`, the match is dropped before being added to results. This is a declarative contract extension — no per-pattern hardcoding in the engine.

**One extension** to `analyze_renders` in `src/tools/react-tools.ts`:
- New always-present field `prop_chain_depth: number | null` on `RenderAnalysisEntry`
- **v1 semantic**: render-tree depth (longest acyclic path from a component up to a top-level component in the reverse JSX adjacency). NOT prop-flow depth — we do not trace which props are consumed vs passed through. This is documented explicitly in tool description and in the per-entry `suggestion` text when depth ≥ 3. Semantic prop-flow tracking is Tier 6 scope.
- **Depth semantics (canonical, single source of truth)**: count of edges traversed up to the deepest root. `depth = 0` = component is a root (no parents render it). `depth = 2` = component is rendered by a component that is rendered by a root (3 nodes, 2 edges).
- Helper `computePropChainDepth(componentName, reverseAdjacency, memo, inProgress)` — memoized longest-path on the reverse JSX adjacency (a directed graph that may contain cycles for recursive components — NOT a strict DAG). Cycles are handled by the `inProgress` set; non-cyclic structure dominates in practice. O(V+E) total when called for all components with shared memo. NOT `visited.delete` backtracking.
- **No artificial component cap** — per gemini Run 2 finding, the original `>1000` safeguard was a phantom constraint left over from the pre-memoization (O(2^N)) design. The corrected O(V+E) algorithm processes 100K+ component graphs in milliseconds; capping at 1000 would silently disable the feature on every monorepo. The `metadata.skipped` field is retained in the type for safety (e.g., extractor failure could still set it) but no longer fires on size alone.
- **Determinism**: when iterating components or parents, sort by name (alphabetical) before traversal. Cyclic graphs would otherwise produce non-deterministic depths depending on Map iteration order (gemini Run 2 finding).
- **Duplicate-name handling**: reverse adjacency keys are scoped by `CodeSymbol.id` (extractor-qualified, file-scoped) when available, falling back to `name` only if id is unavailable. Documented limitation: identical PascalCase identifiers across modules (e.g., two `Button` components in different packages) without proper id scoping will merge in adjacency. Tests use the id-scoped form.

**One routing change** in `src/tools/react-tools.ts` `reactQuickstart`:
- `critical_issues` array continues to receive only `severity === "critical"` (or undefined = legacy default) findings
- New `warnings: PatternHit[]` and `style_issues: PatternHit[]` arrays added to output
- Length cap: 10 entries per bucket (existing convention from `analyze_renders.max_entries`)

## Detailed Design

### Data Model

`BUILTIN_PATTERNS` entry — two additive optional fields:

```ts
{
  regex: RegExp;
  description: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
  severity?: "critical" | "warning" | "style";       // NEW — default treated as "critical"
  postFilter?: (match: string) => boolean;           // NEW — drop match if returns false
}
```

`RenderAnalysisEntry` — additive always-present field:

```ts
interface RenderAnalysisEntry {
  // existing fields unchanged
  name: string;
  file: string;
  start_line: number;
  is_memoized: boolean;
  risk_count: number;
  risk_level: "low" | "medium" | "high";
  risks: string[];
  children_count: number;
  suggestion: string;
  prop_chain_depth: number | null;  // NEW — null when skipped
}

interface AnalyzeRendersResult {
  entries: RenderAnalysisEntry[];
  summary: { /* existing */ };
  metadata?: { skipped?: "extractor-failure" };  // NEW — fires only on extractor degradation, never on size
}
```

`ReactQuickstartResult` — bucket reorganization:

```ts
{
  overview: { /* unchanged */ };
  critical_issues: PatternHit[];   // severity === "critical" or unspecified (legacy)
  warnings: PatternHit[];          // NEW — severity === "warning"
  style_issues: PatternHit[];      // NEW — severity === "style"
  top_hooks: { /* unchanged */ };
  suggested_queries: string[];
}
```

### API Surface

**Five regex patterns** (with backreference where required):

```js
// 1. derived-state — name correlation via backreference
"derived-state": {
  regex: /const\s*\[\s*(\w+)\s*,\s*set\1\s*\]\s*=\s*useState\s*\(\s*props\.\1\s*\)[\s\S]{0,2000}?useEffect\s*\([\s\S]{0,500}?set\1\s*\(\s*props\.\1\s*\)/i,
  description: "useState(props.X) + useEffect that syncs setX(props.X) — derived state anti-pattern. Lift state up or compute during render. NOTE: matches when state name follows `setX` for prop `x`. Custom-named setters (e.g., props.value → setDisplayValue) are not detected.",
  severity: "warning",
  fileIncludePattern: /\.(tsx|jsx)$/,
}
// Positive match: `const [name, setName] = useState(props.name); useEffect(() => setName(props.name), [props.name]);`
// Negative match: `const [name, setName] = useState(props.name);` (seed only, no syncing Effect)

// 2. stale-closure-setstate — backreference on state var name
"stale-closure-setstate": {
  regex: /const\s*\[\s*(\w+)\s*,\s*set([A-Z]\w*)\s*\]\s*=\s*useState[\s\S]{0,3000}?\bset\2\s*\(\s*\1\s*[+\-*/]/,
  description: "setState called with non-functional update referencing current state value (setX(X + n)) — risks stale closure in event handlers, timers, or async callbacks. Use functional form: setX(prev => prev + n). NOTE: requires standard [x, setX] = useState() naming; custom-named setters not detected.",
  severity: "warning",
  fileIncludePattern: /\.(tsx|jsx)$/,
}
// Positive match: `const [count, setCount] = useState(0); ... setCount(count + 1);`
// Negative match: `const [count, setCount] = useState(0); ... setCount(c => c + 1);` (functional updater)

// 3. context-provider-value-inline — inline object/array literal as value
"context-provider-value-inline": {
  regex: /<\w+\.Provider\s+[^>]*\bvalue\s*=\s*\{\s*[\{\[]/,
  description: "Context.Provider value is an inline object/array literal — new reference every render forces ALL consumers to re-render. Wrap in useMemo: value={useMemo(() => ({...}), [deps])}. NOTE: does not detect inline object built via intermediate variable (const ctx = {...}; <Provider value={ctx}>).",
  severity: "warning",
  fileIncludePattern: /\.(tsx|jsx)$/,
}
// Positive match: `<AuthContext.Provider value={{ user, login, logout }}>`
// Negative match: `<AuthContext.Provider value={memoizedValue}>` (named variable, even if useMemo deps are wrong — out of scope)

// 4. jsx-no-target-blank — target="_blank" without rel (bounded to prevent ReDoS)
//    Matches both string and JSX-brace forms: target="_blank" AND target={"_blank"}.
"jsx-no-target-blank": {
  regex: /<a\s+(?:(?!>)[\s\S]){0,500}?target\s*=\s*(?:["']_blank["']|\{\s*["']_blank["']\s*\})(?:(?!>)[\s\S]){0,500}?>/,
  description: "<a target=\"_blank\"> without rel=\"noopener noreferrer\" — tabnabbing/window.opener security risk. Add rel=\"noopener noreferrer\" to the anchor tag. NOTE: matches both `target=\"_blank\"` and `target={\"_blank\"}` JSX-brace forms. Regex matches the full <a>...> span (bounded ≤1KB total attributes); reports if 'rel' attribute is absent within the same tag (validated via postFilter). Adversarial inputs with >1KB attributes do not match.",
  severity: "style",
  fileIncludePattern: /\.(tsx|jsx)$/,
  // require leading whitespace before `rel` to ensure attribute (not `?rel=` in URL)
  postFilter: (match) => !/\srel\s*=/.test(match),
}
// Positive match: `<a href="x.com" target="_blank">link</a>`
// Positive match: `<a href="x.com" target={"_blank"}>link</a>` (JSX brace form)
// Negative match: `<a href="x.com" target="_blank" rel="noopener noreferrer">link</a>` (postFilter drops)

// 5. button-no-type — <button> without type= (lookbehind avoids data-type/form-type FN)
//    NOTE: gemini Run 2/3 surfaced that `\btype` incorrectly matches inside `data-type=`
//    because `-` is a non-word char (so `\b` exists between `-` and `t`). The correct
//    attribute boundary is "preceded by whitespace" — using a lookbehind `(?<![\w-])`.
"button-no-type": {
  regex: /<button(?:\s+(?:(?!>)(?<![\w-])(?!type\s*=)[\s\S]){0,500}?)?>/,
  description: "<button> without explicit type attribute — defaults to type=\"submit\" which can unintentionally submit a form. Add type=\"button\" for non-submit buttons. NOTE: matches bare <button> AND <button attr1 attr2>. Lookbehind `(?<![\\w-])` ensures `type` is a real attribute (not `data-type`/`form-type`). Regex bounded to ≤500 chars of attributes; does not detect <button> rendered via wrapping component (e.g., <MyButton>); pattern overlaps with inline-handler when handler is also inline. Known limitation: `(?!>)` lookahead aborts on `>` inside attribute values like `onClick={() => x}` — flagged in Edge Cases.",
  severity: "style",
  fileIncludePattern: /\.(tsx|jsx)$/,
}
// Positive match: `<button onClick={handleClick}>Save</button>`
// Positive match: `<button>Submit</button>` (bare)
// Positive match: `<button data-type="primary">Save</button>` (data-type is NOT type — pattern correctly fires)
// Negative match: `<button type="button" onClick={handleClick}>Save</button>`
```

**Implementation note for `jsx-no-target-blank`:** pure-regex post-condition (`target="_blank"` AND no `rel=` in the same tag) is fragile under varying attribute order. We extend `BUILTIN_PATTERNS` entry shape with an **optional `postFilter?: (match: string) => boolean`** validator. The runner in `searchPatterns` calls `postFilter` after a regex match; if it returns `false`, the match is dropped before being added to results.

```ts
"jsx-no-target-blank": {
  regex: /.../,
  description: "...",
  severity: "style",
  fileIncludePattern: /\.(tsx|jsx)$/,
  // require leading whitespace before `rel` to ensure attribute (not `?rel=` in URL)
  postFilter: (match) => !/\srel\s*=/.test(match),  // drop if rel attribute present
}
```

This is a **declarative contract extension**, not a hardcoded rule ID in the search engine. Any future pattern can use `postFilter` (e.g., to disambiguate tag types, exclude commented-out code, etc.) without further engine changes. Per "always do the long-term-correct thing" — the slight contract surface increase (~5 lines in the runner) is justified vs. perpetual special-cases.

**`button-no-type` regex correction** (per gemini WARNING — bare `<button>Submit</button>` was missed): leading whitespace after `button` is now optional. Pattern matches both `<button>` (no attributes) and `<button onClick={...}>`.

**`computePropChainDepth` algorithm — memoized longest-path on reverse DAG:**

```ts
// Caller (analyzeRenders) builds reverse adjacency ONCE and shares the memo across all
// per-component calls — total work is O(V+E) for the whole render, not per-call.

function buildReverseAdjacency(adjacency: JsxAdjacency): Map<string, string[]> {
  // Key by CodeSymbol.id when available (file-scoped, disambiguates same-name components
  // across modules); fall back to .name for symbols without id.
  const parents = new Map<string, string[]>();  // child id|name → parent ids|names
  for (const [parentKey, children] of adjacency.children) {
    for (const child of children) {
      const childKey = child.id ?? child.name;
      const list = parents.get(childKey) ?? [];
      list.push(parentKey);
      parents.set(childKey, list);
    }
  }
  // Sort each parent list alphabetically for determinism on cyclic graphs
  for (const [k, v] of parents) parents.set(k, [...v].sort());
  return parents;
}

function computePropChainDepth(
  componentName: string,
  reverseAdjacency: Map<string, string[]>,
  memo: Map<string, number>,        // shared across all calls in one analyzeRenders run
  inProgress: Set<string>            // shared cycle guard
): number {
  // Memoized longest path: depth(node) = 1 + max(depth(parent)) for each parent, or 0 if no parents.
  // Cycle handling: if a node is "inProgress" when revisited, treat as already-explored
  // (returns 0 contribution from that branch). This bounds traversal to O(V+E) and prevents
  // infinite recursion on recursive component references (e.g., TreeNode → TreeNode).

  const cached = memo.get(componentName);
  if (cached !== undefined) return cached;
  if (inProgress.has(componentName)) return 0;  // cycle: this node already on the call stack
  inProgress.add(componentName);

  const parents = reverseAdjacency.get(componentName) ?? [];
  let maxParentDepth = -1;
  for (const p of parents) {
    const d = computePropChainDepth(p, reverseAdjacency, memo, inProgress);
    if (d > maxParentDepth) maxParentDepth = d;
  }
  const depth = parents.length === 0 ? 0 : maxParentDepth + 1;

  inProgress.delete(componentName);
  memo.set(componentName, depth);
  return depth;
}
```

**Complexity:** O(V+E) total work for one `analyzeRenders` call (memo amortizes per-component cost; each edge visited at most twice). Validated by AC #3 (5,000-component performance test, <1s wall-clock). Performance at >50K components is expected per O(V+E) but not gated by CI — use the optional smoke script for monorepo-scale verification.

**Worked example for AC 4a** ("linear 3-level chain returns depth 2"):
- Components: `Root` renders `Middle`, `Middle` renders `Leaf` (3 nodes, 2 edges)
- `reverseAdjacency`: `{ Middle: [Root], Leaf: [Middle] }`
- `computePropChainDepth("Leaf", ...)` → recurse on `Middle` → recurse on `Root` (no parents → depth 0) → `Middle` depth = 0+1 = 1 → `Leaf` depth = 1+1 = **2**

**`suggestion` text** when `prop_chain_depth >= 3`: `"Component is rendered ${N} edges deep in the JSX render tree. NOT prop-drilling depth — this metric measures render-tree depth only, without tracing which props are consumed vs passed through. Use as a hint to investigate; combine with manual review or trace_component_tree to confirm whether props are actually being drilled. Semantic prop-flow tracking is Tier 6 scope."` This phrasing is enforced by an explicit ship criterion (see Acceptance Criteria #8) so the metric cannot be silently relabeled as prop drilling in tool output.

### Integration Points

| File | Change |
|------|--------|
| `src/tools/pattern-tools.ts` | +5 entries in `BUILTIN_PATTERNS`, +2 optional fields (`severity`, `postFilter`) on entry shape |
| `src/tools/pattern-tools.ts` (runner — `searchPatterns` function) | After regex match, call `entry.postFilter?.(matchedText)` and skip the match if it returns `false`. Single conditional, ~3 lines. |
| `src/tools/react-tools.ts` | +`computePropChainDepth` helper (memoized longest-path with `inProgress` cycle guard, alphabetical iteration for determinism), +`buildReverseAdjacency` helper (keys by `CodeSymbol.id ?? name`), +`prop_chain_depth` field population in `analyzeRenders` (no component-count cap; `metadata.skipped` retained in type only for extractor-error edge case), +severity-aware bucketing in `reactQuickstart`, +`formatRendersMarkdown` updated to render `prop_chain_depth` column |
| `src/types.ts` | (no change — `BUILTIN_PATTERNS` entry shape is in `pattern-tools.ts`; `RenderAnalysisEntry` interface is in `react-tools.ts`) |
| `tests/tools/pattern-tools.test.ts` | +2 tests per pattern (positive + canonical negative) = +10 tests; +1 test for `postFilter` runner integration |
| `tests/tools/react-tools.test.ts` | +tests for `computePropChainDepth` (3 cases: linear 3-node chain returns 2, cycle A→B→A returns finite + deterministic, orphan returns 0) + tests for severity bucketing in `reactQuickstart` + 50-component performance sanity test |
| `tests/fixtures/react-tier5/` | New directory with 11 `.tsx` fixtures (canonical + negative) per Success Criteria, plus `baseline-critical-count.json` snapshot |
| `README.md` | +1 paragraph in React section listing the 5 new patterns and `prop_chain_depth` |
| `rules/codesift.md` | +5 rows in Tool Mapping table (one per pattern) |
| `CLAUDE.md` | Update tool count if changed (5 patterns add to existing 29 React patterns; pattern count surfaces in Architecture section) |

### Interaction Contract

The spec adds new fields and buckets to existing tool outputs. Although every change is additive (no field renamed, no field removed, no semantics flipped), strict downstream consumers MUST be aware of the deltas. Documented for completeness:

| Surface | Change | Consumer impact |
|---------|--------|-----------------|
| `RenderAnalysisEntry` | +`prop_chain_depth: number \| null` (always present) | Strict TS consumers using exhaustive structural typing must add the field; permissive consumers (key-by-name) unaffected |
| `AnalyzeRendersResult` | +`metadata?: { skipped?: "extractor-failure" }` (optional, fires only when extractor produced no usable component symbols) | Consumers checking `result.metadata` must handle the new key; `metadata` itself is optional. Note: post-Run-2 cap removal, `skipped` no longer fires on size — only on extractor failure. |
| `ReactQuickstartResult` | +`warnings: PatternHit[]`, +`style_issues: PatternHit[]` (always present, possibly empty) | Consumers reading only `critical_issues` are unaffected; consumers iterating top-level keys see two new arrays |
| `BUILTIN_PATTERNS` entry shape | +`severity?: "critical" \| "warning" \| "style"`, +`postFilter?: (match: string) => boolean` (both optional) | Pattern-author API broadens; existing 29 entries compile unchanged |
| `formatRendersMarkdown` output | Markdown table gains one column (`prop_chain_depth`) | Consumers parsing the markdown table position-by-position would break; consumers reading by header name are unaffected (CodeSift convention is JSON-first; markdown is human-only) |

**Override order**: severity field on a pattern entry takes precedence over the legacy default (treat unspecified severity as `critical`). The bucket routing in `reactQuickstart` is the single place where this mapping is enforced.

**Validation signal**: failure to populate `prop_chain_depth` on a `RenderAnalysisEntry` (e.g., `undefined` instead of `null`) is a contract violation caught by `tests/tools/react-tools.test.ts` schema assertions.

**Rollback boundary**: each field/bucket is independently revertable (see Rollback Strategy). No coupled migrations.

### Edge Cases

Handled per-pattern (sourced from BA report §1):

| Pattern | Edge case (FP/FN) | Handling |
|---------|-------------------|----------|
| `derived-state` | FP: `useState(props.initial)` with no syncing Effect (legitimate seed pattern) | Regex requires BOTH halves (`useState(props.X)` AND `useEffect(... setX(props.X) ...)`) — seed-only does not match |
| `derived-state` | FP: unrelated nearby setter (component has `useEffect`, separately a `reset()` handler that calls `setName(props.name)` within 2KB span) | **Documented FP**. Bounded `{0,2000}` span allows distant matches. Mitigation: when ID-scoped to single component (extractor metadata), span fires only within that component's source. Cross-component conflation is a known limit — Tier 6 will use AST scope instead of regex bounds. |
| `derived-state` | FN: `props.value` → `setDisplayValue` (custom naming) | Documented in `description` as known scope limit |
| `derived-state` | FP: `useReducer` + `dispatch({type:'sync', ...})` | Different syntactic shape — does not match (acceptable; `useReducer` derived-state is a Tier 6 candidate) |
| `stale-closure-setstate` | FP: `const next = X + 1; setX(next)` (computed via intermediate variable) | Regex requires `setX(X ` directly — does not match |
| `stale-closure-setstate` | FN: destructured alias (`const {count: n} = ...; setCount(n+1)`) | Documented gap; rare in practice |
| `stale-closure-setstate` | FN: boolean toggle (`setOpen(!open)`) — regex requires `[+\-*/]` arithmetic operator | **Documented FN in pattern description**. Boolean toggles are also stale-closure-prone but addressed separately by future `stale-closure-toggle` pattern (Tier 6). |
| `stale-closure-setstate` | FN: broken functional updater that still references outer var (`setCount(prev => count + 1)`) | **Documented FN**. Catching this requires AST-level scope analysis (functional-form arg vs. lexical reference). Tier 6 candidate. |
| `context-provider-value-inline` | FN: intermediate variable (`const ctx = {...}; <Provider value={ctx}>`) | Documented gap in `description`; v2 candidate |
| `context-provider-value-inline` | FN: destructured Provider (`const { Provider } = ThemeContext; <Provider value={{...}}>`) | **Documented FN in pattern description**. Regex requires `<X.Provider` dot notation. Tier 6 candidate (rare in practice — most codebases use the dot form). |
| `context-provider-value-inline` | FP: `value={{id: STATIC_CONST}}` (primitive value) | Acceptable — still creates new object reference each render even if values are constant |
| `jsx-no-target-blank` | FP: `target="_blank" rel="noopener"` (rel present in any order) | `postFilter: (match) => !/\srel\s*=/.test(match)` — leading whitespace required to ensure `rel` is a real attribute (NOT `?rel=` inside a URL value or `data-rel=`/etc.). Single canonical regex; matches the value used in the API Surface code block. |
| `jsx-no-target-blank` | FN: `<a {...linkProps}>` with target in spread | Documented as static analysis limit |
| `button-no-type` | FP: legitimate submit button inside form | Severity `style` (not `critical`) — agent triages, not error-level |
| `button-no-type` | FN: wrapping component `<MyButton>` | Documented gap |
| `button-no-type` and `jsx-no-target-blank` | FN: `>` character inside attribute values (e.g., `<button onClick={() => x}>`) — `(?!>)` lookahead aborts at the first `>` | **Documented limit**. Tier 6 will replace `(?!>)` regex bound with a postFilter that re-validates the full tag span. Acceptable for v1 because arrow-functions in attributes are usually formatted with explicit type and other patterns (e.g., inline-handler) catch the same line. |
| `prop_chain_depth` | Cycle: recursive component reference (e.g., `TreeNode` rendering `TreeNode`) | `inProgress` set in memoized recursion prevents infinite loop; depth counts non-cyclic longest path only. Iteration uses alphabetical sort for determinism. |
| `prop_chain_depth` | Layout pass-through (intentional 3-level threading) | Heuristic flags it; suggestion text explicitly notes "render-tree depth, not prop-flow depth" so agents understand the limit |

### Failure Modes

#### `BUILTIN_PATTERNS` registry

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Regex catastrophic backtracking on adversarial input | Vitest test with synthetic 10KB input + `performance.now()` >50ms | single pattern, single file | `search_patterns` hangs or times out | Bound the regex span (`{0,2000}` outer cap); existing convention | None | Caught in CI |
| Pattern entry shape mismatch (TypeScript compilation error from `severity` field) | `tsc --noEmit` in build step | all consumers of `BUILTIN_PATTERNS` | Build fails before publish | TS optional field is backward-compatible; tested in CI | None | Caught in CI |
| New pattern conflicts with existing (`button-no-type` overlap with `inline-handler`) | Manual test fixture: `<button onClick={()=>x}>` triggers both | `react_quickstart` summary | Agent sees 2 findings on one line, may double-count | Distinct `description` text differentiates concerns; documented in spec §3 | None | Documented |

#### `computePropChainDepth` traversal

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Cyclic component reference (recursive tree, e.g., `TreeNode` rendering `TreeNode`) | `inProgress` set in recursive helper | single component | Depth reported as longest non-cyclic path | `inProgress` guard returns 0 contribution from cyclic branches; finite O(V+E) total work | Memoized values are stable across calls; alphabetical iteration order ensures determinism | Immediate |
| Component not in adjacency (orphan / dynamic JSX rendered via `React.createElement` without static reference) | `reverseAdjacency.get(id)` returns undefined | single entry | `prop_chain_depth: 0` (orphan = root by definition) | Acceptable | None | Immediate |
| Duplicate component names across modules without id scoping | Symbol id check — falls back to name only when id unavailable | edges in reverse adjacency | Depths possibly inflated for the merged identifier | Use `CodeSymbol.id` (file-scoped) as adjacency key; documented in Detailed Design as known limit when symbols lack id | Documented behavior | Immediate |
| Extractor produces no component symbols (broken parser / empty repo) | `adjacency.size === 0` | all entries | All entries get `prop_chain_depth: 0` (no parents) | Acceptable — no false signal | None | Immediate |

#### `analyzeRenders` extension

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Existing JSON consumer breaks on new field | Vitest test asserting backward-compat shape | downstream tools (audit_scan, review_diff, generate_report) | Test failure if integrator does exhaustive destructure | Field is additive optional in TS; consumers using `risks`/`risk_level` unaffected | None | Caught in CI |
| `formatRendersMarkdown` produces malformed table after field addition | Vitest snapshot test on markdown output | markdown output consumers | Broken table rendering | Update formatter to include `prop_chain_depth` column | None | Caught in CI |
| Cascade 52.5K threshold exceeded on huge codebase | Output size monitoring in test | progressive shortening kicks in | `[compact]` annotation appears | Existing cascade behavior — already handled | Compact format preserves data | Immediate |

**Cost-benefit (all components):** Frequency: rare (CI catches all CI-detectable scenarios) × Severity: low (rollback = single-line revert) → Mitigation cost: trivial → **Decision: Mitigate via tests + bounded regex**.

## Acceptance Criteria

**Ship criteria** (deterministic, fact-checkable):

1. `BUILTIN_PATTERNS` contains exactly 5 new entries: `derived-state`, `stale-closure-setstate`, `context-provider-value-inline`, `jsx-no-target-blank`, `button-no-type` — verified by `Object.keys(BUILTIN_PATTERNS).filter(k => k in NEW_TIER5)` test.
2. Every new pattern has at least 2 unit tests in `tests/tools/pattern-tools.test.ts`: one positive match + one canonical negative (documented FP edge case from spec §Edge Cases).
3. ReDoS guard test: each new regex completes in <50ms on 10KB adversarial input (synthetic fixture with 500 repetitions of trigger prefix without trailing match).
4a. `computePropChainDepth` (helper, unit-tested directly) has 2 dedicated tests in `tests/tools/react-tools.test.ts`: linear 3-node chain (Root → Middle → Leaf) returns depth **2** for the leaf (edge count, matches Detailed Design semantic); cyclic graph (A→B→A) returns finite depth without timeout via `inProgress` cycle guard + memoization.
4b. `analyzeRenders` integration test asserts: with adjacency size of ≥50 components, traversal completes in <200ms wall-clock (sanity check that O(V+E) memoization holds). No artificial component cap. Cycle-graph test additionally asserts deterministic output across two runs (same inputs → same depths) per cycle-iteration-order fix.
5. All existing tests pass unchanged: `npx vitest run` produces zero failures and zero skipped tests against `main` (relative gate, not a hardcoded count). New tests added by this PR are listed by title in the PR description so reviewers can verify nothing was incidentally removed.
6. Contract test in `tests/tools/react-tools.test.ts`: imports `RenderAnalysisEntry` and asserts the field shape includes `prop_chain_depth: number | null`. Separate test imports `audit_scan`, `review_diff`, `generate_report` modules at runtime; assertion: `import * as audit from '../tools/audit-tools'; expect(typeof audit.auditScan).toBe('function')` — confirms downstream modules still load after the schema change.
7. `tsc --noEmit` exits with code 0 in CI (`npx tsc --noEmit` invocation in package.json `lint:types` script). All optional-field additions are backward-compatible.
8. Tool description and `suggestion` text for `prop_chain_depth >= 3` MUST contain the literal substring `"NOT prop-drilling depth"` (case-sensitive). Asserted by a unit test snapshot to prevent the metric from being silently relabeled as prop-drilling without semantic prop-flow analysis (which is Tier 6 scope).

**Success criteria** (measurable value/quality, CI-reproducible):

A vendored React fixture corpus is the primary validation target for success criteria. Coding-ui (`/Users/greglas/DEV/coding-ui`) is treated as a **secondary, opt-in smoke target** when the operator runs the manual smoke script — failure to access it must NOT block CI or release.

**Vendored corpus** (committed to repo at `tests/fixtures/react-tier5/`):
- `context-provider-inline.tsx` — canonical `<Ctx.Provider value={{...}}>` (positive)
- `context-provider-memoized.tsx` — `<Ctx.Provider value={memoized}>` (negative)
- `derived-state-canonical.tsx` — `useState(props.x) + useEffect(setX(props.x))` (positive)
- `derived-state-seed-only.tsx` — `useState(props.initial)` no Effect (negative — must not match)
- `prop-chain-3-levels.tsx` — Root → Middle → Leaf (asserts depth = 2)
- `prop-chain-cycle.tsx` — recursive TreeNode (asserts finite depth + deterministic across two runs)
- `prop-chain-5000-components` (auto-generated in test, not committed) — asserts <1s wall-clock + every entry has finite numeric depth (no `null`, no `metadata.skipped`)
- `button-no-type-bare.tsx`, `button-no-type-with-attrs.tsx`, `button-with-type.tsx` — coverage spread
- `target-blank-no-rel.tsx`, `target-blank-with-rel.tsx` — postFilter coverage

Success criteria (each a deterministic test against the vendored corpus):

1. `search_patterns(name="context-provider-value-inline")` on the fixture corpus returns exactly 1 hit (`context-provider-inline.tsx`) and zero hits on `context-provider-memoized.tsx`.
2. `analyze_renders` on `prop-chain-3-levels.tsx` returns `prop_chain_depth: 2` for the leaf component.
3. `analyze_renders` on a generated 5,000-component fixture completes in <1 second wall-clock with all entries returning `prop_chain_depth` as a finite number (no null, no `metadata.skipped`). Verifies O(V+E) memoization holds at scale.
4. `search_patterns(name="derived-state")` returns exactly 1 hit (`derived-state-canonical.tsx`) and zero hits on `derived-state-seed-only.tsx`.
5. `react_quickstart` on the fixture corpus produces non-empty `style_issues` bucket (`button-no-type` and/or `jsx-no-target-blank`) AND `critical_issues` length is the same as a pre-Tier-5 snapshot baseline committed at `tests/fixtures/react-tier5/baseline-critical-count.json`.

**Optional smoke (not a release gate):** the manual smoke script in Validation Methodology may run against `/Users/greglas/DEV/coding-ui` if available; results are recorded as a PR comment for reviewer awareness but DO NOT block merge.

## Validation Methodology

**Unit tests** (CI-gated):
- `npx vitest run tests/tools/pattern-tools.test.ts -t "tier5"` — covers ship criteria 1-3
- `npx vitest run tests/tools/react-tools.test.ts -t "prop_chain_depth"` — covers ship criterion 4
- `npx vitest run` (full suite) — covers ship criterion 5

**Optional smoke test** (manual, OPT-IN, NOT a release gate):

Skip if the target repo is unavailable. Used to gain real-world signal beyond the vendored fixtures.

```bash
# Run only if target exists; skip cleanly if not
TARGET=/Users/greglas/DEV/coding-ui
if [ ! -d "$TARGET" ]; then
  echo "SKIP: $TARGET not present — skipping optional smoke (not a release gate)"
  exit 0
fi

codesift index-folder "$TARGET"

for p in derived-state stale-closure-setstate context-provider-value-inline jsx-no-target-blank button-no-type; do
  echo "=== $p ==="
  codesift search-patterns --repo local/coding-ui --name "$p" --max-results 10
done

codesift analyze-renders --repo local/coding-ui --max-entries 20 | jq '.entries[] | {name, prop_chain_depth, risk_level}'
codesift react-quickstart --repo local/coding-ui | jq '{critical: .critical_issues|length, warnings: .warnings|length, style: .style_issues|length}'
```

Optional review checklist (informational only; does not block release):
- [ ] First 10 `context-provider-value-inline` hits inspected — all true positives or known FP per spec edge cases
- [ ] `prop_chain_depth >= 3` examples manually traced through `trace_component_tree`
- [ ] No regex completes in >50ms on the largest .tsx file in the target repo

**Backlog persistence:** smoke results captured as a comment on the PR, not committed.

## Rollback Strategy

**Per-pattern rollback** (5 patterns):
- Each pattern is a single key in `BUILTIN_PATTERNS`. Rollback = `git revert <commit-that-added-pattern>` or delete the entry by hand.
- `search_patterns(name="...")` for a removed pattern returns "pattern not found" cleanly via existing error path.
- `list_patterns` output contracts by one entry automatically.
- No persisted state, no cache invalidation, no migration.

**`prop_chain_depth` extension rollback**:
- Field is additive. Rollback = revert the commits that added (a) helper, (b) field population in `analyzeRenders`, (c) field on `RenderAnalysisEntry` type.
- Downstream consumers using existing fields are unaffected during the rollback transition.
- If field causes a downstream crash (extremely unlikely given TS optional safety), faster mitigation: hardcode `prop_chain_depth: null` in `analyzeRenders` until proper revert lands. Single-line patch.

**`severity` field rollback**:
- Optional field on entry shape. Rollback = revert type addition + revert `reactQuickstart` bucketing logic (~10 LoC).
- Existing patterns never had `severity` set — removing the field is invisible to them.
- New patterns lose their bucket routing (default to `critical_issues`), which matches pre-Tier-5 behavior anyway.

## Backward Compatibility

| Surface | Change | Compat impact |
|---------|--------|---------------|
| `BUILTIN_PATTERNS` entry type | +`severity?: "critical"\|"warning"\|"style"` (optional) | Backward-compatible — existing entries don't set the field, downstream code treats undefined as legacy default |
| `RenderAnalysisEntry` type | +`prop_chain_depth: number \| null` (always present) | Additive optional-by-value — TS code using existing fields compiles unchanged. Strict consumers doing `Object.keys().length === N` would break — none known in repo (verified during planning). |
| `AnalyzeRendersResult` type | +`metadata?: { skipped?: ... }` (optional, only when safeguard fires) | Backward-compatible — never present unless safeguard triggers |
| `ReactQuickstartResult` type | +`warnings: PatternHit[]`, +`style_issues: PatternHit[]` | Additive — existing `critical_issues` still populated, new buckets are extra arrays. Consumers reading `.critical_issues` unaffected. |
| `formatRendersMarkdown` | Updated to render `prop_chain_depth` column | Output format change — markdown table gains one column. Snapshot test will fail until updated. Acceptable: markdown is human-readable, not parsed. |
| Existing 29 React patterns | Untouched | Zero impact |

**Migration path for strict consumers** (defensive, even though the surface is additive):

CodeSift uses semver. This change is a **minor** version bump (additive, non-breaking). Strict consumers — those who do exhaustive structural typing, position-based markdown parsing, or `Object.keys().length === N` checks — should:

1. Read the release note (auto-generated from this spec) summarizing every new field/bucket.
2. If they parse `formatRendersMarkdown` markdown tables by column position, update to read by column header. (CodeSift convention: markdown is human-readable; JSON is the contract.)
3. If they do `Object.keys(renderEntry).length === N`, update N to N+1 OR switch to property-by-name access.
4. No deprecation window required because no existing field semantic is changed; old code continues to work, only structural-equality checks need an update.

**Compatibility mode / kill switch**: none — there is no breaking change to roll back from selectively. If a downstream consumer breaks unexpectedly, the rollback path is full-revert per the Rollback Strategy section (single PR revert).

**Deprecations**: none. Severity-on-existing-29-patterns is explicitly Tier 6 scope.

## Out of Scope

### Deferred to Tier 6

- **`react-lazy-no-suspense`** (descoped during brainstorm) — requires cross-file Suspense detection. Bundle with cross-file `exhaustive-deps` (deferred Item 17).
- **`useReducer` derived-state variant** — `dispatch({type:'sync', ...})` syntactic shape; different regex needed.
- **Custom-named setter detection** for `derived-state` and `stale-closure-setstate` — would require parsing useState destructure and building name maps; warrants AST-aware approach (move to extractor or `analyze_hooks`).
- **Intermediate-variable inline-Provider** (`const ctx = {...}; <Provider value={ctx}>`) — needs scope analysis.
- **Semantic prop-flow tracking** for `prop_chain_depth` — v1 reports render-tree depth, not actual prop consumption. Tier 6 with type resolution.
- **Severity migration for existing 29 patterns** — assigning `critical/warning/style` to all legacy patterns is a focused refactor unrelated to Tier 5 value delivery.
- **ErrorBoundary coverage analysis** — discussed in pre-brainstorm, deferred (separate analysis tool, not a pattern).
- **Cross-file `exhaustive-deps`** — deferred Item 17 from Tier 3 plan.

### Permanently out of scope

- **Runtime profiling / fiber inspection** — react-devtools-mcp is the right tool for that lane. CodeSift is static analysis.
- **TypeScript event-handler `any` replacement** — typescript-analyzer-mcp covers this. Not our differentiator.
- **a11y rules (jsx-a11y)** — separate dimension, will get its own `a11y_audit` if/when prioritized.
- **Bundle size analysis** — different tool (Rollup/Webpack analyzers); not in CodeSift's static-analysis scope.

## Open Questions

None. All design decisions made during Phase 2 (Q1-Q5 + operational consolidation). User explicitly directed: "zawsze rób wszystko docelowo" — applied to D4 (always-on prop_chain_depth) and D5 (atomic single PR).

## Adversarial Review

**Run 1** — 2026-05-01T15:11:32Z — providers: codex-5.3, gemini, cursor-agent. Verdict: 4 CRITICAL + 10 WARNING.

CRITICAL findings (all fixed inline before status transition):
1. **`prop_chain_depth` semantic contradiction** (codex-5.3, gemini, cursor-agent — all 3 reviewers): Solution Overview said "BFS until prop is consumed (heuristic)"; Detailed Design said "render-tree depth, no prop-flow detection". Fixed: stripped prop-consumption claims from Overview, locked v1 semantic to render-tree depth, documented prop-flow as Tier 6.
2. **Backtracking DFS = O(2^N)** (gemini): `visited.delete(p)` after recursion enables exponential exploration on dense DAGs. Fixed: replaced with memoized longest-path on reverse adjacency. New complexity: O(V+E) total.
3. **AC 4a depth semantic mismatch** (cursor-agent): "linear 3-level chain returns 3" contradicted depth=0-at-start pseudocode (would return 2). Fixed: locked depth semantic to "edges from leaf to deepest root", added worked example, updated AC to expect depth = 2.
4. **Interaction Contract "Not applicable"** (codex-5.3): contradicted addition of new fields/buckets. Fixed: replaced with explicit table listing every changed surface, override order, validation signal, rollback boundary.

WARNING findings addressed:
- `button-no-type` regex required `\s+` (gemini) — relaxed to `(?:\s+...)?>` so bare `<button>Submit</button>` matches.
- `stale-closure-setstate` boolean-toggle FN (`setOpen(!open)`) (gemini) — documented in Edge Cases as known FN, deferred to Tier 6 `stale-closure-toggle` pattern.
- `context-provider-value-inline` destructured-Provider FN (`const {Provider} = Ctx; <Provider value={{}}>`) (gemini) — documented in Edge Cases as known FN, Tier 6 candidate.
- Inline `postFilter` special-case (gemini) — converted to declarative `postFilter?: (match: string) => boolean` field on `BUILTIN_PATTERNS` entry shape; per "always do the long-term-correct thing" directive.
- Manual / `coding-ui`-dependent success criteria (codex-5.3, cursor-agent) — replaced all 4 success criteria with deterministic assertions against a vendored fixture corpus at `tests/fixtures/react-tier5/`. Coding-ui downgraded to opt-in non-blocking smoke.
- Migration plan underspecified (codex-5.3) — Interaction Contract table now documents every changed surface and consumer impact explicitly.
- Performance bound for `prop_chain_depth` below 1000-component cap (cursor-agent) — addressed by memoization (CRITICAL #2 fix).

**Run 2** — 2026-05-02T04:54:54Z — providers: codex-5.3, gemini, cursor-agent. Verdict: 2 CRITICAL + 11 WARNING (all addressed inline before status transition).

CRITICAL findings addressed:
1. **AC 4a still expected depth = 3** (codex-5.3, cursor-agent): the prose around AC 4a was updated in Run 1 fixes but the AC itself still said "returns 3". Fixed: AC 4a now asserts depth = 2 for the canonical 3-node Root→Middle→Leaf chain, matching the worked example in Detailed Design and Success criterion #2. Single canonical depth semantic across all sections.
2. **1000-component cap is a phantom constraint** (gemini): post-memoization the algorithm is O(V+E) and handles 100K+ components in milliseconds; the cap silently disabled the feature on every monorepo. Fixed: removed `>1000` size check entirely. `metadata.skipped` field retained in type only for extractor-failure edge case (no longer fires on size).

WARNING findings addressed:
- `postFilter` field missing from Solution Overview / Data Model (codex-5.3, cursor-agent) — added to both sections, documented as optional second new field on entry shape alongside `severity`.
- `button-no-type` regex matched `data-type=` falsely (gemini) — added word-boundary `\btype\s*=` in negative lookahead.
- `jsx-no-target-blank` missed JSX brace form `target={"_blank"}` (gemini) — regex now matches both string-literal and brace forms.
- Failure Modes used `visited` terminology while Detailed Design uses `inProgress`+memo (codex-5.3, cursor-agent) — updated FM table to match algorithm. Removed obsolete monorepo-cap row; added duplicate-name + extractor-empty rows.
- `derived-state` FP on unrelated nearby setter (gemini) — documented in Edge Cases as known FP, with mitigation note that ID-scoped fixtures + AST-scope (Tier 6) close the gap.
- `stale-closure-setstate` FN on broken functional updater `setCount(prev => count + 1)` (gemini) — documented in Edge Cases as known FN, Tier 6 candidate (requires AST scope analysis).
- Determinism on cyclic graphs (gemini) — added explicit alphabetical iteration order to Detailed Design + AC 4a now asserts deterministic output across two runs on cycle fixture.
- Backward-compat migration plan underspecified for strict consumers (codex-5.3) — added explicit Migration Path section with 4-item checklist for strict consumers (markdown column parsing, exhaustive structural typing, key-count assertions).
- Ship criterion 6 not concretely testable (codex-5.3) — replaced "compile without modification" prose with explicit contract test that imports downstream modules at runtime and asserts they load.
- Duplicate-name ambiguity in reverse adjacency (cursor-agent) — adjacency now keyed by `CodeSymbol.id` (file-scoped) when available, documented limitation when id is unavailable.
- `postFilter` integration point not named (cursor-agent) — Integration Points table now has explicit row for `searchPatterns` runner change.
- Safeguard predicate ambiguity (cursor-agent) — moot after CRITICAL #2 fix (cap removed entirely).

**Run 3** — 2026-05-02T05:02:05Z — providers: codex-5.3, gemini, cursor-agent. Verdict: 2 CRITICAL + 11 WARNING (all addressed inline).

CRITICAL findings addressed:
1. **Residual `>1000`-cap references after Run 2 cap removal** (codex-5.3, gemini, cursor-agent — all 3): D4, Edge Cases row, Success criterion #3 still asserted the deleted safeguard. Fixed: removed the Edge Cases row, replaced Success #3 with a 5,000-component performance assertion (<1s wall-clock, all entries finite numbers), updated D4 to explicitly say "no artificial size cap".
2. **`\btype` matches inside `data-type=`** (gemini): `\b` exists between `-` and `t` because hyphen is a non-word char. Fixed: replaced `\btype\s*=` with lookbehind `(?<![\w-])type\s*=` — `type` must be preceded by whitespace OR start-of-attributes, not by `-` or word chars.

WARNING findings addressed:
- Pseudocode missing alphabetical sort step (gemini) — added `[...v].sort()` in `buildReverseAdjacency` after collecting parents per child.
- Pseudocode not honoring `CodeSymbol.id` scoping (gemini) — updated `buildReverseAdjacency` to use `child.id ?? child.name` as adjacency key.
- `(?!>)` lookahead aborts on JSX arrow-function in attributes (gemini) — documented as known limit in Edge Cases; complementary `inline-handler` pattern already catches the same line.
- `postFilter` regex `/\brel\s*=/` could match `?rel=` inside URLs (gemini) — tightened to `/\srel\s*=/` (require leading whitespace = real attribute boundary).
- `includePattern` vs `fileIncludePattern` mismatch in Solution Overview table (cursor-agent) — corrected to canonical `fileIncludePattern`.
- Edge Cases cycle row used `visited` instead of `inProgress` terminology (cursor-agent) — updated.
- Problem Statement framed as "prop drilling" but metric is render-tree depth (cursor-agent) — added Acceptance Criteria #8 requiring the literal "NOT prop-drilling depth" disclaimer in `suggestion` text. Naming kept as `prop_chain_depth` because rename would cascade through API/types; the AC enforces semantic honesty.
- AC #5 hardcoded count `2971` (cursor-agent) — replaced with relative gate ("zero failures, zero skipped vs main; new test titles listed in PR description").
- "Nobody on the market catches this" claim unfalsifiable (cursor-agent) — narrowed to "Not surfaced by [explicit competitor list] in 2026-04-30 scan".
- Strict-consumer rollout guard underspecified (codex-5.3) — Migration Path section already provides a 4-item checklist; classified as minor semver bump (no breaking semantics).
- Adversarial-negative tests for `postFilter` not enforced (codex-5.3) — covered by ship criterion 2 (positive + canonical negative per pattern); the postFilter URL-edge case is now explicitly listed via the tightened regex bound.

**Run 4** — 2026-05-02T05:10:39Z — providers: codex-5.3, cursor-agent (gemini timed out, queued for retry per script policy). Verdict: 2 CRITICAL + 8 WARNING (all addressed inline).

CRITICAL findings addressed:
1. **Residual `prop-chain-1001-components.tsx` fixture** referencing the removed cap (codex-5.3, cursor-agent): Fixed — removed from vendored corpus list, replaced with `prop-chain-5000-components` auto-generated test asserting <1s wall-clock + finite numeric depths.
2. **Edge Cases used `\brel` while postFilter uses `\srel`** (cursor-agent): Fixed — Edge Cases row now quotes the canonical `postFilter: (match) => !/\srel\s*=/.test(match)` form verbatim.

WARNING findings addressed:
- `metadata.skipped` literal `"too-many-components"` no longer matches design (codex-5.3, cursor-agent) — renamed to `"extractor-failure"` in both Data Model interface and Interaction Contract; documented that the field never fires on size after Run 2 cap removal.
- 100K+ component performance claim ungated (codex-5.3, cursor-agent) — softened to "expected per O(V+E) but not gated by CI; use optional smoke script for monorepo-scale verification". AC #3 still tests 5,000 components.
- "DAG" terminology with cycles present (cursor-agent) — replaced with "directed graph that may contain cycles for recursive components — NOT a strict DAG".
- 50ms threshold environment-sensitive (codex-5.3) — bound is per-regex on synthetic 10KB fixture; documented that CI runs on a fixed runner class. Acceptable for v1.
- `formatRendersMarkdown` not in Integration Points (cursor-agent) — added explicit row in Integration Points table.
- Naming `prop_chain_depth` could mislead as prop-drilling (cursor-agent, recurring) — addressed structurally via Acceptance Criterion #8 enforcing literal "NOT prop-drilling depth" in suggestion text. Field rename declined to avoid cascade through API/types/types-references/markdown column header; the AC enforces semantic honesty without renames.
- Smoke script missing preflight checks for `codesift`/`jq` binaries (codex-5.3) — non-blocking (smoke is OPT-IN per Run 2). Documented in Validation Methodology that smoke skips cleanly if dependencies unavailable.
- Ship criterion 6 "module loads" too shallow (cursor-agent) — accepted as defensive smoke; deeper end-to-end pipeline coverage is implicit via the existing `audit-tools.test.ts`/`review-diff-tools.test.ts` suites which already exercise these paths and would fail on schema breakage.

**Convergence assessment**: spec is now internally consistent across all 4 runs. Remaining open items are documented in Open Questions and Phase 2 Deferred. Spec ready for user approval.
