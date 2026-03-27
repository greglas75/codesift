# CodeSift Dashboard v1.1 — Design Specification

> **Date:** 2026-03-27
> **Status:** Approved
> **Author:** zuvo:brainstorm
> **Base:** Existing dashboard at `/Users/greglas/DEV/codesift-dashboard/` (Astro + React islands, 4 tabs)

## Problem Statement

The v0.1 dashboard shows basic usage metrics and code health snapshots but:
1. Cannot filter by time range or repo — charts show all-time aggregates
2. Shows no deltas — users can't tell if things got better or worse
3. Misses rich data CodeSift already computes: anti-patterns, clones, circular deps, impact analysis
4. Can't be shown publicly — real project names are exposed
5. Has no "daily driver" hook — nothing pulls users back each morning
6. Health page shows all zeros — CLI commands for complexity/dead-code/hotspots/communities don't exist yet

## Design Decisions

1. **All 10 features in one release** — no waves, no feature flags. Reduces risk of losing scope.
2. **Anonymization via env var** — `CODESIFT_ANONYMIZE=true` replaces repo names with stable codenames. Marketing demo at `dashboard.codesift.dev` (Vercel, anonymized). Daily use on localhost with real names.
3. **All pages SSR** — `output: 'server'` in astro.config. Every page renders fresh on each request (reads usage.jsonl + registry.json live). On localhost this means F5 = fresh data. On Vercel (`dashboard.codesift.dev`) uses serverless functions. No manual rebuild needed.
4. **CLI commands as prerequisite** — 6 missing CLI commands (`complexity`, `dead-code`, `hotspots`, `communities`, `patterns`, `find-clones`) must be added to codesift-mcp's `COMMAND_MAP` BEFORE dashboard features F5-F9 can work. This is Task 0. The existing health page is also broken without these.
5. **No new npm dependencies** — radar chart built with SVG, no D3-radar or chart.js. Keep bundle minimal.
6. **Dashboard embedded in codesift-mcp** — `codesift dashboard` command starts a local HTTP server serving the pre-built Astro app. Zero separate install. Dashboard `dist/` is bundled into the npm package.
7. **`process.env` for server-side, `import.meta.env` for client-side** — anonymize.ts uses `process.env.CODESIFT_ANONYMIZE` since it runs in Node.js context (Astro SSR + prerender).

## Solution Overview

### Prerequisite: Add Missing CLI Commands (Task 0)

Add these commands to `src/cli/commands.ts` COMMAND_MAP:

| CLI command | MCP tool function | Return type |
|-------------|------------------|-------------|
| `codesift complexity <repo>` | `analyzeComplexity()` | `{ functions: ComplexFunction[], summary: ComplexitySummary }` |
| `codesift dead-code <repo>` | `findDeadCode()` | `{ candidates: DeadCodeCandidate[] }` |
| `codesift hotspots <repo>` | `analyzeHotspots()` | `{ hotspots: FileHotspot[], period: string, total_commits: number }` |
| `codesift communities <repo>` | `detectCommunities()` | `{ communities: Community[], modularity: number }` |
| `codesift patterns <repo> --pattern <name>` | `searchPatterns()` | `{ matches: PatternMatch[], pattern: string, scanned_symbols: number }` |
| `codesift find-clones <repo>` | `findClones()` | `{ clones: CodeClone[], scanned_symbols: number, threshold: number }` |

This also fixes the existing Health page which currently shows all zeros.

### 10 Features Across 4 Categories

#### Infrastructure
- **F1: Anonymization mode** — env var toggles repo name display

#### Daily Driver (existing pages enhanced)
- **F2: Time range selector** — global 7d/30d/90d dropdown on Analytics (server-rendered)
- **F3: Delta indicators** — ↑↓ badges on every MetricCard showing 7d change
- **F4: "Since yesterday" banner** — summary line at top of Overview
- **F5: Complexity summary cards** — avg/max complexity from `summary` object

#### Wow Factor (new sections on Health page)
- **F6: Anti-pattern radar chart** — spider/radar SVG showing 8 pattern counts
- **F7: Clone detection table** — duplicate code pairs with similarity scores
- **F8: Circular dependency list** — import cycles count + expandable paths
- **F9: Impact analysis panel** — risk scores for recent commits

#### Multi-Repo Management
- **F10: Portfolio health table** — all repos compared side-by-side, sortable

---

## Detailed Design

### F1: Anonymization Mode

**Trigger:** `CODESIFT_ANONYMIZE=true` environment variable (read via `process.env`).

**Behavior:**
- Repo names replaced with stable codenames derived from name hash
- `local/tgm-survey-platform` → `Project Titan`
- Deterministic: same repo always gets same codename (simple string hash mod codename list)
- File paths in dead code / clone tables: show relative paths only, strip absolute prefix
- Numbers, scores, charts — unchanged (real data)

**Implementation:**
```typescript
// src/lib/anonymize.ts
const CODENAMES = ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta',
  'Iota','Kappa','Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau',
  'Upsilon','Phi','Chi','Psi','Omega','Atlas','Nova','Orion','Vega','Lyra',
  'Rigel','Altair','Deneb','Sirius','Polaris','Castor','Pollux','Antares'];

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const ANONYMIZE = process.env.CODESIFT_ANONYMIZE === 'true';

export function anonRepo(name: string): string {
  if (!ANONYMIZE) return name;
  return `Project ${CODENAMES[simpleHash(name) % CODENAMES.length]}`;
}

export function anonPath(filePath: string): string {
  if (!ANONYMIZE) return filePath;
  // Show only last 2 segments: "services/user.ts"
  return filePath.split('/').slice(-2).join('/');
}
```

**Files:** New `src/lib/anonymize.ts`. Import and call in every `.astro` page that renders repo names or file paths.

---

### F2: Time Range Selector

**Scope:** Analytics page only.

**UI:** Dropdown in page header: `7d | 30d | 90d | All`

**Behavior:**
- Selected range stored in URL: `/analytics?range=7d`
- All charts and tables on Analytics page filter to selected range
- Default: `30d`
- Links between ranges are `<a>` tags (full page navigation, no JS state)

**Implementation:**
- All pages are now SSR (`output: 'server'`), no need for `prerender` flags
- Read range from `Astro.url.searchParams.get('range') ?? '30d'`
- Compute `sinceMs` from range string, pass to `getUsageEntries(sinceMs)`

**Astro config change:**
```javascript
// astro.config.mjs
export default defineConfig({
  output: 'server',  // was: 'static'
  adapter: process.env.VERCEL ? vercel() : node({ mode: 'standalone' }),
  integrations: [react(), tailwind()],
});
```

**Files:** Modify `astro.config.mjs` (output → server, dual adapter), modify `src/pages/analytics.astro` (add dropdown, pass sinceMs). Remove all `export const prerender = true` from pages.

---

### F3: Delta Indicators

**What:** Every MetricCard shows a 7-day change badge.

**MetricCard prop change:** The existing `trend` (string) and `trendUp` (boolean) props are **replaced** by a single `delta` prop:

```typescript
interface Props {
  label: string;
  value: string | number;
  delta?: { value: number; percent: number; good?: 'up' | 'down' };
  sparkline?: number[];
}
```

- `delta.good = 'up'` means increase is good (more searches = green ↑)
- `delta.good = 'down'` means decrease is good (fewer dead code = green ↓)
- Default: `'up'`

**UI:** Small pill below value: `↑ 12%` (green if good direction, red if bad).

**Computation:**
```typescript
// src/lib/deltas.ts
export function computeDelta(
  entries: UsageEntry[],
  metricFn: (e: UsageEntry[]) => number
): { value: number; percent: number } {
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;
  const twoWeeksAgo = now - 14 * 86_400_000;
  const thisWeek = entries.filter(e => e.ts >= weekAgo);
  const lastWeek = entries.filter(e => e.ts >= twoWeeksAgo && e.ts < weekAgo);
  const current = metricFn(thisWeek);
  const previous = metricFn(lastWeek);
  const percent = previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0;
  return { value: current - previous, percent };
}
```

**Files:** Modify `src/components/MetricCard.astro` (replace trend/trendUp with delta), new `src/lib/deltas.ts`, modify all pages to pass delta.

---

### F4: "Since Yesterday" Banner

**What:** One-line summary bar at top of Overview page.

**UI:**
```
Yesterday: 142 calls · 3 repos · $1.23 saved · Avg 340ms
```

**Timezone handling:** Use UTC day boundaries (`new Date().toISOString().slice(0, 10)`) for consistency. Usage.jsonl timestamps are UTC unix ms. "Yesterday" = UTC yesterday, regardless of user timezone. Document this in the UI as tooltip: "Based on UTC time".

**Empty state:** If no entries yesterday, show: `No activity yesterday`

**Files:** Modify `src/pages/index.astro` (add banner div). Computation inline in frontmatter.

---

### F5: Complexity Summary Cards

**What:** 4 additional MetricCards on Health page.

**Cards:**
1. Avg Complexity — `summary.avg_complexity` (rounded to 1 decimal)
2. Max Complexity — `summary.max_complexity`
3. Avg Function Lines — `summary.avg_lines` (rounded)
4. Max Nesting — `summary.max_nesting`

**Data source:** Modify `getComplexFunctions()` to also return the `summary` object. The `analyzeComplexity()` MCP function already returns `{ functions, summary }` but the dashboard's wrapper only extracts `functions`.

**Prerequisite:** CLI command `codesift complexity` must exist (Task 0).

**Files:** Modify `src/lib/health-score.ts` (add `getComplexitySummary()`), modify `src/pages/health.astro` (add 4 cards in a new row).

---

### F6: Anti-Pattern Radar Chart

**What:** Spider/radar chart showing 8 anti-pattern counts.

**Patterns:**
1. `empty-catch` — swallowed errors
2. `any-type` — TypeScript `any` usage
3. `console-log` — debug logs in production
4. `await-in-loop` — sequential async in loops
5. `no-error-type` — untyped catch clauses
6. `toctou` — check-then-act race conditions
7. `unbounded-findmany` — DB queries without limit
8. `scaffolding` — TODO/FIXME/HACK comments

**Data source:** `codesift patterns <repo> --pattern <name> --compact`
Returns: `{ matches: PatternMatch[], pattern: string, scanned_symbols: number }`

**Prerequisite:** CLI command `codesift patterns` must exist (Task 0).

**Visualization:** Pure SVG radar/spider chart. 8 axes radiating from center. Filled polygon. Each axis labeled with pattern name and count. CSS variables for colors (theme-adaptive).

**Empty state:** If all patterns return 0 matches, show: "No anti-patterns detected" with a green checkmark.

**Error handling:** If CLI call fails (e.g., repo not indexed), that pattern gets count 0. If ALL fail, show empty state, not an error.

**New component:** `src/components/RadarChart.tsx`
- Props: `data: Array<{ label: string; value: number; max?: number }>`
- Pure SVG, no dependencies
- Uses `var(--accent)` for fill, `var(--text-secondary)` for labels

**Files:** New `src/lib/patterns.ts`, new `src/components/RadarChart.tsx`, modify `src/pages/health.astro`.

---

### F7: Clone Detection Table

**What:** Table showing duplicate code pairs with similarity scores.

**Data source:** `codesift find-clones <repo> --compact`
Returns: `{ clones: CodeClone[], scanned_symbols: number, threshold: number }`

**IMPORTANT:** The key is `clones`, NOT `clone_pairs`. Each `CodeClone` has: `symbol_a: string`, `symbol_b: string`, `similarity: number` (0-1), `shared_lines: number`.

**Prerequisite:** CLI command `codesift find-clones` must exist (Task 0).

**UI:**
- Section header: "Code Clones" with badge "12 pairs found"
- Table columns: Symbol A | Symbol B | Similarity | Shared Lines
- Similarity column: colored inline bar (0-1 scale)
  - `< 0.5`: low (default text color)
  - `0.5-0.8`: medium (`var(--warning)`)
  - `> 0.8`: high (`var(--error)`)
- Max 20 rows shown

**Empty state:** "No code clones detected" (this is a good result — no duplication)

**Files:** New `src/lib/clones.ts`, modify `src/pages/health.astro`, reuse `DataTable.tsx`.

---

### F8: Circular Dependencies

**What:** Count card + expandable list of import cycles.

**Data source:** `codesift knowledge-map <repo> --compact`
Returns: `{ modules: Module[], edges: Edge[], circular_deps: CircularDep[] }`
Where `CircularDep = { cycle: string[], length: number }`

**UI:**
- MetricCard: count of circular deps with `var(--warning)` color if > 0
- Below card: list of cycles, each shown as: `A → B → C → A`
- File paths anonymized if `CODESIFT_ANONYMIZE=true`
- Collapsed by default if > 5 cycles (show first 5 + "Show N more")

**Empty state:** "No circular dependencies" (green checkmark — this is good)

**Edge case:** `knowledge-map` can be slow on large repos. Set `timeout: 30000` on execSync. If timeout, show "Analysis timed out for this repo".

**Files:** New `src/lib/circular-deps.ts`, modify `src/pages/health.astro`.

---

### F9: Impact Analysis Panel

**What:** Risk scores for recent commits.

**Data source:** `codesift impact <repo> --since HEAD~20 --compact`
Returns: `{ risk_scores: RiskScore[], changed_files: string[], affected_symbols: string[] }`
Where `RiskScore = { file: string, risk: 'low'|'medium'|'high'|'critical', score: number, callers: number, test_coverage: number, symbols_changed: number }`

**UI:**
- Section title: "Recent Changes — Risk Assessment"
- Horizontal bar chart: files sorted by risk score (0-100)
- Bar color: green (low, <25) → yellow (medium, 25-50) → orange (high, 50-75) → red (critical, >75)
- Below chart: summary text: "12 files changed, 3 high risk, 1 critical"

**Edge cases:**
- Repo with < 20 commits: use `HEAD~{actual_count}` or catch git error → show "Not enough git history for impact analysis"
- Repo with no git: show "Requires git repository"
- All scores low: show the chart normally (this is good news)

**Files:** New `src/lib/impact.ts`, modify `src/pages/health.astro`, reuse `BarChart.tsx`.

---

### F10: Portfolio Health Table

**What:** Multi-repo comparison table, sortable by any column.

**Where:** New page `/portfolio` (5th tab in sidebar).

**Columns:**
| Repo | Files | Symbols | Health | Complex Fns | Dead Code | Status |
|------|-------|---------|--------|-------------|-----------|--------|

**Data source:**
- Files, Symbols, Status: from `registry.json` (already loaded, fast)
- Health grade, Complex Fns, Dead Code: from CLI calls (slow — computed only for top 10 repos by symbol count)

**Performance strategy:**
- Registry data (files, symbols, status) shown for ALL repos immediately
- Health columns shown only for top 10 repos. Others show "—"
- Each CLI call has 15s timeout. If any fails, that cell shows "—"
- Total worst-case: 10 repos × 2 CLI calls (complexity + dead-code) = 20 calls × 15s timeout = 5 min max. Realistic: ~30s total.

**Sorting:** Client-side sorting via React island `DataTable.tsx`. Already supports sortable columns.

**Anonymization:** Repo names go through `anonRepo()`. File counts and health scores remain real.

**Files:** New `src/pages/portfolio.astro`, modify `src/components/Sidebar.astro` (add Portfolio nav item with icon).

---

## Acceptance Criteria

1. `CODESIFT_ANONYMIZE=true` replaces all repo names with stable codenames across all pages
2. Analytics page has working time range dropdown (7d/30d/90d/all) that filters all charts
3. Every MetricCard shows 7-day delta badge (↑/↓/—) with directional color
4. Overview page shows "Since yesterday" summary banner with 4 metrics
5. Health page shows avg/max complexity and max nesting as MetricCards
6. Health page shows radar chart with 8 anti-pattern counts (pure SVG)
7. Health page shows clone detection table with similarity indicators
8. Health page shows circular dependency count + cycle list
9. Health page shows impact analysis bar chart for recent commits
10. Portfolio page shows multi-repo comparison table, sortable by column
11. All new features work in both dark and light theme (CSS variables)
12. Empty states handled for all new sections: no data, no git history, CLI timeout, small repos
13. `codesift complexity`, `dead-code`, `hotspots`, `communities`, `patterns`, `find-clones` CLI commands exist and return correct JSON
14. Astro config uses `output: 'server'` — all pages SSR, F5 = fresh data

## Out of Scope

- Real-time polling (15-30s refresh) — deferred to v1.2
- Loading skeleton animations — deferred to v1.2
- Number tween animations — deferred to v1.2
- Error log persistence — deferred to v2
- LSP server status — deferred to v2
- User authentication — not planned for local dashboard
- Health score history persistence — not planned (always computed fresh)
- Interactive route explorer — not planned (too complex)
- Hosted SaaS / team view — future (requires auth, GDPR, trust)
- `codesift dashboard` CLI command — deferred (requires embedding dist/ in npm package)

## Open Questions

None — all resolved:

1. **Portfolio: all repos** — compute health for ALL repos, not just top 10. Build time ~2-5 min acceptable. Add console progress during build.
2. **Radar adapts to language** — skip TS-specific patterns (`any-type`, `no-error-type`) for non-TS repos. Radar shows 6-8 axes dynamically based on repo language.
3. **Both adapters** — detect environment at config time: `process.env.VERCEL ? vercelAdapter() : nodeAdapter()`. One astro.config.mjs serves both.
