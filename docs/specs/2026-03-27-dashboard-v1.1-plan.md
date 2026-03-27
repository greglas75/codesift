# Implementation Plan: Dashboard v1.1

**Spec:** `docs/specs/2026-03-27-dashboard-v1.1-spec.md`
**Created:** 2026-03-27 (rev 2 — reviewer fixes)
**Tasks:** 20
**Estimated complexity:** 13 standard, 7 complex

## Architecture Summary

Two projects modified:
- **codesift-mcp** (Task 0): Add 6 CLI commands to `src/cli/commands.ts` COMMAND_MAP. All tool functions already exist — just need CLI wrappers following the established `handleXxx` pattern with lazy imports.
- **codesift-dashboard** (Tasks 1-19): Astro + React islands. All data lib functions use `execSync("codesift ...")` pattern from `health-score.ts`. Pages are `.astro` files with React islands via `client:visible`.

## Technical Decisions

- **RadarChart**: Pure SVG component (no recharts, per spec Design Decision 5 — keep bundle minimal)
- **Astro output**: `'server'` — all pages SSR, F5 = fresh data on every request. Remove all `prerender = true`.
- **MetricCard delta**: Add new `delta` prop alongside existing `trend`/`trendUp` (backward compatible)
- **Anonymization**: `process.env.CODESIFT_ANONYMIZE` + `node:crypto` sha256 for deterministic codenames
- **Adapters**: Conditional `process.env.VERCEL ? vercel() : node()` in astro.config.mjs
- **Health page**: Extract sub-components (Task 9.5) BEFORE adding new sections to avoid 400+ line file

## Quality Strategy

- **codesift-mcp**: Vitest (existing), add `tests/cli/commands.test.ts` for new handlers
- **codesift-dashboard**: **Zero test infrastructure exists**. Task 1 sets up Vitest. Lib functions tested with mocked `execSync` and `readFileSync`
- **CQ gates activated**: CQ3 (function length), CQ6 (error boundaries on execSync), CQ8 (SSR + execSync risk), CQ14 (coverage regression)
- **Key risk**: `health.astro` is 208 lines — Task 9.5 extracts sub-components before Tasks 10-14 add content

---

## Task Breakdown

### Task 0: Add 6 CLI commands to codesift-mcp
**Files:** `src/cli/commands.ts`, `src/cli/help.ts`, `tests/cli/commands.test.ts` (new)
**Complexity:** complex
**Dependencies:** none
**Model routing:** Opus

Each handler follows the exact pattern from existing code (lazy import + output):
1. `complexity` → `analyzeComplexity()` from `complexity-tools.ts`
2. `dead-code` → `findDeadCode()` from `symbol-tools.ts`
3. `hotspots` → `analyzeHotspots()` from `hotspot-tools.ts`
4. `communities` → `detectCommunities()` from `community-tools.ts`
5. `patterns` → `searchPatterns()` from `pattern-tools.ts` (accepts `--pattern <name>`)
6. `find-clones` → `findClones()` from `clone-tools.ts`

- [ ] RED: Write `tests/cli/commands.test.ts` — smoke tests for each handler (mock tool imports via `vi.mock`, verify `output()` called with correct result)
- [ ] GREEN: Add 6 handlers to `commands.ts` + 6 entries to COMMAND_MAP + help text in `help.ts`
- [ ] Verify: `npx vitest run tests/cli/commands.test.ts` → 6 passed
- [ ] Verify: `codesift complexity local/codesift-mcp --compact | head -5` → JSON with `functions` key
- [ ] Commit: `feat(cli): add 6 analysis commands — complexity, dead-code, hotspots, communities, patterns, find-clones`

---

### Task 1: Dashboard test infrastructure
**Files:** `package.json`, `vitest.config.ts` (new), `tests/lib/.gitkeep` (new)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Create `tests/lib/smoke.test.ts` with a trivial assertion (`expect(true).toBe(true)`) to verify Vitest works
- [ ] GREEN: Add `vitest` to devDependencies. Create `vitest.config.ts`. Add `"test": "vitest run"` script.
- [ ] Verify: `npm test` → `1 passed`
- [ ] Commit: `chore: add vitest test infrastructure`

---

### Task 2: Astro SSR config + Vercel adapter
**Files:** `astro.config.mjs`, `package.json`, all `.astro` pages (remove `prerender = true`)
**Complexity:** complex
**Dependencies:** none
**Model routing:** Opus

- [ ] RED: Write `tests/config/astro-config.test.ts` — assert config uses `output: 'server'`, verify build produces `dist/server/entry.mjs`
- [ ] GREEN: Change `output: 'static'` → `output: 'server'`. Add conditional adapter: `process.env.VERCEL ? vercel() : node()`. Add `@astrojs/vercel` to devDependencies. Remove ALL `export const prerender = true` from all pages.
- [ ] Verify: `npm run build` → build succeeds, `dist/server/entry.mjs` exists
- [ ] Verify: `npm run dev` → dashboard loads, all pages serve fresh data
- [ ] Commit: `feat: switch to Astro server mode with dual Vercel/Node adapter — all pages SSR`

---

### Task 3: Anonymization lib
**Files:** `src/lib/anonymize.ts` (new), `tests/lib/anonymize.test.ts` (new)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Test `anonRepo('local/my-project')` returns `'Project Xxx'` when env set, returns original when not. Test determinism (same input → same output). Test `anonPath()` strips to last 2 segments.
- [ ] GREEN: Implement `anonRepo()` and `anonPath()` using sha256 hash mod codename list via `process.env.CODESIFT_ANONYMIZE`
- [ ] Verify: `npm test -- tests/lib/anonymize.test.ts` → passed
- [ ] Commit: `feat(F1): add anonymization lib — deterministic codenames from repo name hash`

---

### Task 4: Delta computation lib
**Files:** `src/lib/deltas.ts` (new), `tests/lib/deltas.test.ts` (new)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Test `computeDelta(entries, e => e.length)` returns correct value/percent for this-week vs last-week. Test zero previous (percent = 0). Test negative delta.
- [ ] GREEN: Implement `computeDelta()` function
- [ ] Verify: `npm test -- tests/lib/deltas.test.ts` → passed
- [ ] Commit: `feat(F3): add delta computation — 7-day change calculation for metrics`

---

### Task 5: MetricCard delta prop
**Files:** `src/components/MetricCard.astro`
**Complexity:** standard
**Dependencies:** Task 4
**Model routing:** Sonnet

- [ ] GREEN: Add optional `delta?: { value: number; percent: number; good?: 'up' | 'down' }` prop. Render pill badge: `↑ 12%` (green if good direction, red if bad). Keep existing `trend`/`trendUp` working.
- [ ] Verify: `npm run dev` → MetricCards render without errors
- [ ] Commit: `feat(F3): add delta badge to MetricCard — shows 7-day change indicator`

---

### Task 6: "Since yesterday" banner
**Files:** `src/lib/yesterday.ts` (new), `tests/lib/yesterday.test.ts` (new), `src/pages/index.astro`
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

- [ ] RED: Write `tests/lib/yesterday.test.ts` with mocked timestamps testing: (a) entries from UTC yesterday included, (b) entries from UTC today excluded, (c) empty state when no entries, (d) boundary at midnight UTC
- [ ] GREEN: Create `getYesterdayStats(entries)` in `yesterday.ts`. Add banner section at top of Overview page. Empty state: `No activity yesterday`.
- [ ] Verify: `npm test -- tests/lib/yesterday.test.ts` → passed
- [ ] Verify: `npm run dev` → banner visible on overview page
- [ ] Commit: `feat(F4): add "since yesterday" summary banner with UTC day boundary logic`

---

### Task 7: Overview page deltas
**Files:** `src/pages/index.astro`
**Complexity:** standard
**Dependencies:** Task 4, Task 5
**Model routing:** Sonnet

- [ ] GREEN: Import `computeDelta`, compute deltas for each KPI (repos, symbols, searches, savings). Pass `delta` prop to each MetricCard.
- [ ] Verify: `npm run dev` → MetricCards show delta badges
- [ ] Commit: `feat(F3): wire delta indicators to Overview KPI cards`

---

### Task 8a: Health data layer — patterns + clones
**Files:** `src/lib/patterns.ts` (new), `src/lib/clones.ts` (new), `tests/lib/patterns.test.ts` (new), `tests/lib/clones.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 0, Task 1
**Model routing:** Sonnet

`getPatternCounts(repo)` includes `isTypeScriptRepo(repo)` helper — skips `any-type` and `no-error-type` patterns for non-TS repos (checks for `.ts`/`.tsx` files via registry). Returns dynamic 6-8 pattern set.

`getClonePairs(repo)` uses key `clones` (NOT `clone_pairs`).

- [ ] RED: Test each function with mocked `execSync` — happy path, error path, timeout path. Test TS detection logic.
- [ ] GREEN: Implement both functions with execSync + try/catch + fallback
- [ ] Verify: `npm test -- tests/lib/patterns.test.ts tests/lib/clones.test.ts` → passed
- [ ] Commit: `feat(F6-F7): add pattern scan and clone detection data layer`

---

### Task 8b: Health data layer — circular deps + complexity summary
**Files:** `src/lib/circular-deps.ts` (new), `src/lib/health-score.ts` (modify), `tests/lib/circular-deps.test.ts` (new), `tests/lib/complexity-summary.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 0, Task 1
**Model routing:** Sonnet

- [ ] RED: Test `getCircularDeps(repo)` and `getComplexitySummary(repo)` with mocked `execSync`
- [ ] GREEN: Implement both. `getComplexitySummary` extracts `summary` object from existing `analyzeComplexity` output. `getCircularDeps` calls `codesift knowledge-map` and extracts `circular_deps`.
- [ ] Verify: `npm test -- tests/lib/circular-deps.test.ts tests/lib/complexity-summary.test.ts` → passed
- [ ] Commit: `feat(F5,F8): add circular dependency detection and complexity summary extraction`

---

### Task 9: RadarChart component (pure SVG)
**Files:** `src/components/RadarChart.tsx` (new)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

Pure SVG spider chart — NO recharts. 6-8 dynamic axes. CSS variables for theming.

- [ ] GREEN: Implement `RadarChart.tsx` with props: `data: Array<{ label: string; value: number }>`. SVG polygon fill using `var(--accent)` with opacity. Axis labels in `var(--text-secondary)`. Responsive via viewBox.
- [ ] Verify: `npm run dev` → no build errors
- [ ] Commit: `feat(F6): add pure SVG RadarChart component — no external chart dependency`

---

### Task 9.5: Extract health.astro sub-components
**Files:** `src/pages/health.astro`, `src/components/health/ComplexitySection.astro` (new), `src/components/health/DeadCodeSection.astro` (new), `src/components/health/HotspotsSection.astro` (new), `src/components/health/CommunitySection.astro` (new)
**Complexity:** complex
**Dependencies:** none
**Model routing:** Opus

Extract existing health.astro sections into sub-components. health.astro becomes an orchestrator importing each section. No functionality change — pure refactor.

- [ ] GREEN: Create 4 sub-components, move existing section markup into each. health.astro imports and renders them. Each sub-component receives data as props.
- [ ] Verify: `npm run dev` → `/health` looks identical to before
- [ ] Commit: `refactor: extract health page into sub-components — prep for F5-F9 additions`

---

### Task 10: Health page — complexity summary cards (F5)
**Files:** `src/components/health/ComplexitySection.astro` (modify — add summary cards)
**Complexity:** standard
**Dependencies:** Task 8b, Task 9.5
**Model routing:** Sonnet

- [ ] GREEN: Call `getComplexitySummary(defaultRepo)`. Add 4 MetricCards: Avg Complexity, Max Complexity, Avg Lines, Max Nesting. Place in new row in ComplexitySection.
- [ ] Verify: `npm run dev` → `/health` shows summary cards
- [ ] Commit: `feat(F5): add complexity summary metric cards to Health page`

---

### Task 11: Health page — anti-pattern radar (F6)
**Files:** `src/components/health/RadarSection.astro` (new)
**Complexity:** standard
**Dependencies:** Task 8a, Task 9, Task 9.5
**Model routing:** Sonnet

- [ ] GREEN: New sub-component. Call `getPatternCounts(defaultRepo)`. Transform to RadarChart data format (dynamic 6-8 axes based on repo language). Empty state if all counts = 0.
- [ ] Verify: `npm run dev` → `/health` shows radar chart (or empty state)
- [ ] Commit: `feat(F6): add anti-pattern radar chart to Health page`

---

### Task 12: Health page — clone detection table (F7)
**Files:** `src/components/health/ClonesSection.astro` (new)
**Complexity:** standard
**Dependencies:** Task 8a, Task 9.5
**Model routing:** Sonnet

- [ ] GREEN: New sub-component. Call `getClonePairs(defaultRepo)`. Render DataTable with Symbol A, Symbol B, Similarity, Shared Lines. Badge with count in header. Empty state.
- [ ] Verify: `npm run dev` → `/health` shows clone table (or empty state)
- [ ] Commit: `feat(F7): add clone detection table to Health page`

---

### Task 13: Health page — circular dependencies (F8)
**Files:** `src/components/health/CircularDepsSection.astro` (new)
**Complexity:** standard
**Dependencies:** Task 8b, Task 9.5
**Model routing:** Sonnet

- [ ] GREEN: New sub-component. Call `getCircularDeps(defaultRepo)`. Show count as MetricCard (warning color if > 0). List cycles as `A → B → C → A`. Collapse if > 5.
- [ ] Verify: `npm run dev` → `/health` shows circular deps section
- [ ] Commit: `feat(F8): add circular dependency detection to Health page`

---

### Task 14: Health page — impact analysis (F9)
**Files:** `src/lib/impact.ts` (new), `tests/lib/impact.test.ts` (new), `src/components/health/ImpactSection.astro` (new)
**Complexity:** standard
**Dependencies:** Task 0, Task 9.5
**Model routing:** Sonnet

- [ ] RED: Write `tests/lib/impact.test.ts` testing: (a) successful response with risk scores, (b) git error (no history) → empty fallback, (c) fewer than 20 commits → partial result, (d) execSync timeout → empty fallback
- [ ] GREEN: New `getImpactAnalysis(repo)` calling `codesift impact <repo> --since HEAD~20 --compact`. New sub-component with BarChart, risk-colored bars (green→red). Handle all edge cases.
- [ ] Verify: `npm test -- tests/lib/impact.test.ts` → passed
- [ ] Verify: `npm run dev` → `/health` shows impact analysis (or empty state)
- [ ] Commit: `feat(F9): add impact analysis panel with risk scores and edge-case handling`

---

### Task 15: Time range selector on Analytics (F2)
**Files:** `src/pages/analytics.astro`
**Complexity:** complex
**Dependencies:** Task 2
**Model routing:** Opus

- [ ] GREEN: Read `Astro.url.searchParams.get('range')`. Add dropdown links (7d/30d/90d/All) in page header as `<a>` tags with `?range=X`. Filter all data through `getUsageEntries(sinceMs)`. Highlight active range. Default: `30d`.
- [ ] Verify: `npm run dev` → `/analytics?range=7d` shows filtered data, `/analytics?range=90d` shows more
- [ ] Commit: `feat(F2): add time range selector to Analytics page — SSR with URL params`

---

### Task 16: Portfolio page (F10)
**Files:** `src/pages/portfolio.astro` (new), `src/components/Sidebar.astro`
**Complexity:** complex
**Dependencies:** Task 0, Task 3, Task 8a, Task 8b
**Model routing:** Opus

- [ ] GREEN: New page at `/portfolio`. Load all repos from registry. For each repo, compute health grade + complex functions count + dead code count (15s timeout per CLI call, console progress). Render sortable DataTable. Add Portfolio nav item to Sidebar (new SVG icon). Apply `anonRepo()`.
- [ ] Verify: `npm run dev` → `/portfolio` shows multi-repo health table
- [ ] Commit: `feat(F10): add Portfolio page — multi-repo health comparison table`

---

### Task 17: Anonymization wiring across all pages
**Files:** `src/pages/index.astro`, `src/pages/analytics.astro`, `src/pages/health.astro`, `src/pages/admin.astro`, `src/pages/portfolio.astro`
**Complexity:** complex
**Dependencies:** Task 3, Task 16
**Model routing:** Opus

- [ ] GREEN: Import `anonRepo` and `anonPath` in every page. Wrap all repo name and file path renders. Test both modes.
- [ ] Verify: `CODESIFT_ANONYMIZE=true npm run dev` → all repo names show codenames
- [ ] Verify: `npm run dev` → all repo names show real names
- [ ] Commit: `feat(F1): wire anonymization across all pages — env toggle for codenames`

---

## Execution Order

```
Task 0  (CLI commands)          ← independent, codesift-mcp project
Task 1  (test infra)            ← independent, dashboard project
Task 2  (Astro SSR config)      ← independent
Task 3  (anonymize lib)         ← independent
Task 4  (delta lib)             ← independent
─── foundation complete ───
Task 5  (MetricCard delta prop) ← depends on 4
Task 6  (yesterday banner)      ← depends on 1
Task 7  (overview deltas)       ← depends on 4, 5
Task 8a (patterns + clones)     ← depends on 0, 1
Task 8b (circular + summary)    ← depends on 0, 1
Task 9  (RadarChart SVG)        ← independent
Task 9.5 (health sub-components)← independent (pure refactor)
─── components + data ready ───
Task 10 (complexity summary)    ← depends on 8b, 9.5
Task 11 (radar chart F6)        ← depends on 8a, 9, 9.5
Task 12 (clone table F7)        ← depends on 8a, 9.5
Task 13 (circular deps F8)      ← depends on 8b, 9.5
Task 14 (impact analysis F9)    ← depends on 0, 9.5
Task 15 (time range F2)         ← depends on 2
─── features complete ───
Task 16 (portfolio page F10)    ← depends on 0, 3, 8a, 8b
Task 17 (anonymization wiring)  ← depends on 3, 16
```

Tasks 0-4 run in **parallel** (independent foundations).
Tasks 5-9.5 can partially overlap.
Tasks 10-15 target separate sub-component files (can overlap).
Tasks 16-17 are final integration.
