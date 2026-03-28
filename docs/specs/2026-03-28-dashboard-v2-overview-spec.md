# Dashboard v2 Overview Page -- Design Specification

> **Date:** 2026-03-28
> **Status:** Approved
> **Author:** zuvo:brainstorm
> **Prior art:** docs/specs/2026-03-27-dashboard-v2-brief.md

## Problem Statement

The CodeSift dashboard Overview page shows raw data (5 KPI cards, empty charts, a recent-activity table) but tells no story. It doesn't answer "What does CodeSift give me?" or "How is my code?". There's no USP showcase, no portfolio health aggregate, and 13 of 39 tools are invisible. The page looks like a generic admin panel — there's no reason for a user to come back. Light mode charts don't render (P0 bug), the health score is hardcoded ("B 72"), and the health formula is provably wrong (uses a truncated 30-item array instead of summary totals).

The user wants a page that **sells CodeSift's value** through real data: savings, benchmarks, tool adoption, and portfolio health — honest, including where CodeSift loses.

## Design Decisions

### DD1: Parallel build — Overview page + cron script simultaneously
The cron script populates health caches; the Overview page degrades gracefully when data is missing ("1 of 51 repos analyzed"). This unblocks the 3 sections that work today (benchmark, tool distribution, activity) while health data fills in over time.

### DD2: Full benchmark table with wins AND losses
The benchmark section shows all 6 categories from `FINAL-RECOMMENDATION-MATRIX.md`, including categories B and E where grep wins. This builds credibility with technical users and serves as diagnostic info for the project owner.

### DD3: Dual hero — Health gauge + Savings counter
Two KPIs side by side in the hero area. Left: portfolio health score (or "X/N analyzed" progress). Right: total token savings with cost estimate. Answers two questions simultaneously: "How is my code?" and "What does CodeSift save me?"

### DD4: Full 39-tool grid
All 39 tools displayed in a categorized grid. Active tools are colored with call count; inactive tools are grayed with "0 calls". Shows adoption rate at a glance and highlights which tools need better documentation/prompting.

### DD5: Value-first layout order
Savings and benchmark (the USP) come first in the viewport. Health and activity are lower. Rationale: the benchmark section is CodeSift's unique differentiator that no competitor has; it should be the first thing a visitor sees below the hero.

### DD6: Incremental cron with git-commit check
The cron script compares `last_git_commit` from registry against a stored value in cache. Unchanged repos are skipped. First run is full (~15-25 min for 51 repos), subsequent runs process only repos with new commits (~1-3 min). Uses `execFileSync` with array args (no shell injection).

## Solution Overview

The Overview page (`src/pages/index.astro`) is rebuilt with 5 sections in this order:

```
┌─────────────────────────────────────────────────────┐
│ HERO: [Health Gauge]          [Savings Counter]     │
│       "58% avg (12/51 repos)" "$72.85 (2.4M tokens)"│
├─────────────────────────────────────────────────────┤
│ BENCHMARK: CodeSift vs Grep — 6-category comparison │
│ [====== 48,930 ======] CodeSift  search_text        │
│ [========== 72,993 ==========] Grep     -33% ✅     │
│ ...4 more categories including 2 losses...          │
│ Net: "CodeSift wins 4/6 categories"                 │
├─────────────────────────────────────────────────────┤
│ TOOL GRID: 39 tools in 4 categories                │
│ [Search: 9] [Navigate: 10] [Analyze: 13] [Operate: 7] │
│ 26/39 active — colored tiles with call count        │
│ 13/39 inactive — gray tiles "0 calls"               │
├─────────────────────────────────────────────────────┤
│ PORTFOLIO HEALTH: Repo table sorted by score        │
│ Repo | Grade | Score | Complexity | Dead Code | ... │
│ (only repos with cache data; "Run Analysis" for rest)│
├─────────────────────────────────────────────────────┤
│ ACTIVITY: Calls/day area chart + recent activity    │
│ Stacked by tool category (Search/Navigate/Analyze)  │
└─────────────────────────────────────────────────────┘
```

A standalone cron script (`scripts/refresh-cache.ts`) runs daily via launchd, populating `~/.codesift/dashboard-cache/*.json` incrementally. The Overview page only reads pre-built JSON files — zero CLI calls during SSR.

## Detailed Design

### Data Model

#### New: `src/lib/benchmark-data.ts`

Static benchmark data extracted from `FINAL-RECOMMENDATION-MATRIX.md`:

```typescript
export interface BenchmarkCategory {
  id: string;                    // "A", "B", "C", "D", "E", "G"
  label: string;                 // "Text Search", "Symbol Search", etc.
  tool: string;                  // "search_text", "search_symbols", etc.
  codesift_tokens: number | null; // null for timeout (category E)
  grep_tokens: number | null;
  winner: 'codesift' | 'grep';
  delta_percent: number;         // -33, -6, -20, -5, 0, +20
  delta_label: string;           // "-33%", "timeout", "+20% quality"
  note: string;                  // "BM25 ranking" or "verbosity, fixable"
}

export const BENCHMARK_DATA: BenchmarkCategory[] = [
  { id: 'A', label: 'Text Search',     tool: 'search_text',      codesift_tokens: 48_930, grep_tokens: 72_993, winner: 'codesift', delta_percent: -33, delta_label: '-33%', note: 'BM25 ranking, file_pattern filtering' },
  { id: 'B', label: 'Symbol Search',   tool: 'search_symbols',   codesift_tokens: 63_829, grep_tokens: 60_282, winner: 'grep',     delta_percent: -6,  delta_label: 'Bash -6%', note: 'Verbosity — fixable with compact mode' },
  { id: 'C', label: 'File Structure',  tool: 'get_file_outline',  codesift_tokens: 36_580, grep_tokens: 45_489, winner: 'codesift', delta_percent: -20, delta_label: '-20%', note: 'Symbol counts per file' },
  { id: 'D', label: 'Symbol Reading',  tool: 'get_symbol',       codesift_tokens: 57_703, grep_tokens: 60_482, winner: 'codesift', delta_percent: -5,  delta_label: '-5%', note: 'Exact symbol boundaries' },
  { id: 'E', label: 'Call Tracing',    tool: 'trace_call_chain', codesift_tokens: null,   grep_tokens: 60_810, winner: 'grep',     delta_percent: 0,   delta_label: 'Timeout', note: 'Needs rewrite — use grep for now' },
  { id: 'G', label: 'Semantic Search', tool: 'codebase_retrieval', codesift_tokens: null, grep_tokens: null,   winner: 'codesift', delta_percent: 20,  delta_label: '+20% quality', note: '7.8/10 vs 6.5/10 on concept questions' },
];
```

#### New: `src/lib/tool-catalog.ts`

Canonical list of all 39 MCP tools, categorized:

```typescript
export type ToolCategory = 'search' | 'navigate' | 'analyze' | 'operate';

export interface ToolInfo {
  name: string;
  label: string;           // human-readable
  category: ToolCategory;
  description: string;     // one-line
}

// Canonical list — reconciled with MCP tool registry (39 tools exactly).
// Tool `name` must match the MCP tool name suffix (after `mcp__codesift__`)
// so that usage.jsonl lookups work correctly.
export const ALL_TOOLS: ToolInfo[] = [
  // Search (9 tools)
  { name: 'search_text',        label: 'Text Search',        category: 'search',   description: 'Find text patterns in files' },
  { name: 'search_symbols',     label: 'Symbol Search',      category: 'search',   description: 'Find functions, classes, types by name' },
  { name: 'find_references',    label: 'Find References',    category: 'search',   description: 'Find all usages of a symbol' },
  { name: 'search_patterns',    label: 'Pattern Search',     category: 'search',   description: 'Find anti-patterns (empty-catch, etc.)' },
  { name: 'list_patterns',      label: 'List Patterns',      category: 'search',   description: 'List available anti-pattern detectors' },
  { name: 'find_dead_code',     label: 'Dead Code',          category: 'search',   description: 'Find unused exports' },
  { name: 'find_clones',        label: 'Clone Detection',    category: 'search',   description: 'Find copy-paste duplication' },
  { name: 'cross_repo_search',  label: 'Cross-Repo Search',  category: 'search',   description: 'Find symbols across repos' },
  { name: 'cross_repo_refs',    label: 'Cross-Repo Refs',    category: 'search',   description: 'Find references across repos' },
  // Navigate (10 tools)
  { name: 'get_file_outline',   label: 'File Outline',       category: 'navigate', description: 'List exports and functions in a file' },
  { name: 'get_file_tree',      label: 'File Tree',          category: 'navigate', description: 'Directory tree with symbol counts' },
  { name: 'get_symbol',         label: 'Get Symbol',         category: 'navigate', description: 'Read one function/class source' },
  { name: 'get_symbols',        label: 'Get Symbols (batch)', category: 'navigate', description: 'Read multiple symbols at once' },
  { name: 'get_context_bundle', label: 'Context Bundle',     category: 'navigate', description: 'Symbol + imports + siblings in 1 call' },
  { name: 'assemble_context',   label: 'Assemble Context',   category: 'navigate', description: 'Dense context at L0-L3 compression' },
  { name: 'go_to_definition',   label: 'Go To Definition',   category: 'navigate', description: 'Jump to symbol definition (LSP)' },
  { name: 'get_type_info',      label: 'Type Info',          category: 'navigate', description: 'Get return type and docs (LSP)' },
  { name: 'get_repo_outline',   label: 'Repo Outline',       category: 'navigate', description: 'High-level repo structure summary' },
  { name: 'suggest_queries',    label: 'Suggest Queries',    category: 'navigate', description: 'Suggested queries for unfamiliar repo' },
  // Analyze (13 tools)
  { name: 'trace_call_chain',   label: 'Call Chain',         category: 'analyze',  description: 'Trace callers or callees of a function' },
  { name: 'trace_route',        label: 'Route Trace',        category: 'analyze',  description: 'HTTP route → handler → service → DB' },
  { name: 'impact_analysis',    label: 'Impact Analysis',    category: 'analyze',  description: 'Blast radius of recent changes' },
  { name: 'analyze_complexity', label: 'Complexity',         category: 'analyze',  description: 'Rank functions by cyclomatic complexity' },
  { name: 'analyze_hotspots',   label: 'Hotspots',           category: 'analyze',  description: 'Git churn × complexity score' },
  { name: 'detect_communities', label: 'Communities',        category: 'analyze',  description: 'Discover code modules via Louvain' },
  { name: 'get_knowledge_map',  label: 'Knowledge Map',      category: 'analyze',  description: 'Import graph with dependency edges' },
  { name: 'diff_outline',       label: 'Diff Outline',       category: 'analyze',  description: 'Structured outline of git diff' },
  { name: 'changed_symbols',    label: 'Changed Symbols',    category: 'analyze',  description: 'Symbols added/modified/removed between refs' },
  { name: 'codebase_retrieval', label: 'Batch Retrieval',    category: 'analyze',  description: 'Multiple queries in one call' },
  { name: 'generate_report',    label: 'Generate Report',    category: 'analyze',  description: 'Markdown report from analysis' },
  { name: 'rename_symbol',      label: 'Rename Symbol',      category: 'analyze',  description: 'Cross-file rename via LSP' },
  { name: 'generate_claude_md', label: 'Generate CLAUDE.md', category: 'analyze',  description: 'Auto-generate project CLAUDE.md' },
  // Operate (7 tools)
  { name: 'index_repo',         label: 'Index Repo',         category: 'operate',  description: 'Index entire repository' },
  { name: 'index_folder',       label: 'Index Folder',       category: 'operate',  description: 'Index a directory' },
  { name: 'index_file',         label: 'Index File',         category: 'operate',  description: 'Re-index a single changed file' },
  { name: 'list_repos',         label: 'List Repos',         category: 'operate',  description: 'List all indexed repositories' },
  { name: 'invalidate_cache',   label: 'Invalidate Cache',   category: 'operate',  description: 'Clear cached index data' },
  { name: 'usage_stats',        label: 'Usage Stats',        category: 'operate',  description: 'Show tool call statistics' },
  { name: 'find_and_show',      label: 'Find & Show',        category: 'operate',  description: 'Search + display in one step' },
];
// Total: 9 + 10 + 13 + 7 = 39 tools
```

#### Modified: `src/lib/cache.ts` — add `source_commit` field

The `CachedHealthData` interface gets a new optional field used by the cron script for incremental checks:

```typescript
export interface CachedHealthData {
  repo: string;
  generated_at: number;
  source_commit?: string;  // NEW — git commit hash at cache generation time
  complexity: { functions: unknown[]; summary: unknown };
  dead_code: { candidates: unknown[] };
  hotspots: { hotspots: unknown[] };
  patterns: { counts: Record<string, number>; patterns: string[]; total: number };
  clones: unknown[];
  circular_deps: unknown[];
  impact: { risk_scores: unknown[] };
  community_mermaid: string;
}
```

The cron script writes `source_commit` when generating cache. On subsequent runs, it reads the cached `source_commit` and compares against `last_git_commit` from `registry.json`. If they match, the repo is skipped.

#### Modified: `src/lib/health-score.ts`

**Bug fix (P0):** `computeHealthGrade` currently receives data from `getRepoHealth()` which uses `complexFns.length` (capped at 30) for `totalFunctions`. The fix: when reading from cache, use `cached.complexity.summary.above_threshold` and `cached.complexity.summary.total_functions` instead of counting the truncated array.

New function:

```typescript
export function computeHealthFromCache(cached: CachedHealthData): HealthData {
  const summary = cached.complexity.summary as { above_threshold?: number; total_functions?: number } | null;
  const complexFunctions = summary?.above_threshold ?? (cached.complexity.functions as unknown[]).filter(
    (f: any) => (f as { cyclomatic_complexity: number }).cyclomatic_complexity > 10
  ).length;
  const totalFunctions = summary?.total_functions ?? (cached.complexity.functions as unknown[]).length;

  return {
    complexFunctions,
    totalFunctions,
    deadCodeCount: cached.dead_code.candidates.length,
    hotspotCount: cached.hotspots.hotspots.length,
    communityModularity: 0, // Reserved — not used in computeHealthGrade formula. Kept for future use.
  };
}
```

**Verification test for the bug fix (ISSUE-4 from review):**
```typescript
// Unit test: computeHealthFromCache must use summary, not array length
test('uses summary.total_functions, not functions.length', () => {
  const cached = {
    complexity: {
      functions: new Array(30), // truncated to 30
      summary: { above_threshold: 69, total_functions: 381 },
    },
    dead_code: { candidates: new Array(5) },
    hotspots: { hotspots: new Array(2) },
  } as unknown as CachedHealthData;
  const health = computeHealthFromCache(cached);
  expect(health.totalFunctions).toBe(381);  // NOT 30
  expect(health.complexFunctions).toBe(69); // NOT 30
});
```

#### New: `src/lib/portfolio-stats.ts`

Aggregates health scores across all cached repos:

```typescript
export interface PortfolioSummary {
  totalRepos: number;         // from registry (51)
  analyzedRepos: number;      // repos with cache files
  avgScore: number;           // average health score
  avgGrade: string;           // grade from avgScore
  breakdown: {                // per-repo scores for table
    repo: string;
    score: number;
    grade: string;
    complexity: number;       // above_threshold count
    deadCode: number;
    patterns: number;
  }[];
}
```

#### New: `scripts/refresh-cache.ts`

Standalone Node script for cron execution. Key logic:

```typescript
// 1. Read registry.json → get all repos with last_git_commit
// 2. For each repo: read existing cache file → check stored git commit
// 3. If commit matches → skip (repo unchanged)
// 4. If commit differs or no cache → run refreshRepoCache()
// 5. Store the git commit in cache JSON (new field: source_commit)
// 6. Use execFileSync with array args (no shell injection)
// 7. Concurrency: sequential (simpler, avoids CLI conflicts)
// 8. Log: "Refreshed 3/51 repos (48 unchanged) in 47s"
```

#### New: `com.codesift.refresh-cache.plist`

launchd plist for macOS scheduling:

```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key><integer>6</integer>
  <key>Minute</key><integer>0</integer>
</dict>
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/Users/greglas/DEV/codesift-dashboard/scripts/refresh-cache.js</string>
</array>
```

### API Surface

No new API endpoints. The existing `POST /api/refresh-cache` remains as a manual trigger but will be updated to use `execFileSync` (array args) to fix shell injection.

The cron script writes directly to `~/.codesift/dashboard-cache/*.json` — the same files the dashboard already reads.

### Integration Points

| Component | Integration | Change type |
|-----------|------------|-------------|
| `src/pages/index.astro` | Complete rewrite of page content | **Replace** |
| `src/lib/health-score.ts` | Add `computeHealthFromCache()` | **Extend** |
| `src/lib/config.ts` | No changes needed | **None** |
| `src/lib/cache.ts` | Fix `safeExec` → `execFileSync` with array; add `source_commit?: string` field to `CachedHealthData` interface | **Modify** |
| `src/lib/usage-data.ts` | No changes — `getToolStats()` already provides what we need | **None** |
| `src/components/AreaChart.tsx` | Fix light mode: read CSS vars in `useEffect`, not at module scope | **Fix (P0)** |
| `src/components/DonutChart.tsx` | Same light mode fix | **Fix (P0)** |
| `src/components/BarChart.tsx` | Same light mode fix | **Fix (P0)** |
| `src/components/HealthBadge.astro` | Accept "X/N analyzed" mode when data is partial | **Extend** |

New files:
- `src/lib/benchmark-data.ts` — static benchmark constants
- `src/lib/tool-catalog.ts` — 39-tool canonical list with categories
- `src/lib/portfolio-stats.ts` — aggregate health from cache files
- `src/components/BenchmarkChart.tsx` — horizontal gap-annotated bar chart (React island)
- `src/components/ToolGrid.astro` — 39-tool categorized grid (pure Astro, no JS)
- `src/components/PortfolioTable.astro` — sortable repo table with grades
- `scripts/refresh-cache.ts` — standalone cron script
- `com.codesift.refresh-cache.plist` — launchd schedule

### Edge Cases

**EC1: Zero repos cached (first-time user)**
- Portfolio health shows "No repos analyzed yet" with a "Run Analysis" button that triggers the cron script
- Benchmark and Tool Distribution render normally (static/usage data)
- Activity section shows empty state if usage.jsonl is missing

**EC2: Partial cache (1-10 of 51 repos)**
- Hero health gauge shows "58% (3 of 51 repos)" — makes clear it's partial
- Portfolio table shows graded repos at top, ungraded repos below with "—"
- Average score computation includes only cached repos, labeled "(based on N repos)"

**EC3: Usage data < 7 days**
- Delta badges suppressed (no "vs last week" when there's no last week)
- Activity chart shows available days, labels axis with actual date range
- "N days of data" label shown instead of "Last 14 days"

**EC4: Repos with shell-unsafe names (`Portal & Access`)**
- `execFileSync('codesift', ['complexity', repoName, '--compact'])` — array args, no shell interpretation
- Applies to both cron script and any remaining `safeExec` calls in cache.ts

**EC5: Light mode theme switch**
- Charts use `useEffect` + `useState` to read CSS vars after hydration
- Re-read on `data-theme` attribute change via MutationObserver
- Fallback colors are light-mode appropriate (not dark hex values)

**EC6: Benchmark category E (timeout)**
- Bar chart shows CodeSift bar as red/gray with "Timeout" label
- Grep bar renders normally
- Annotation: "Needs rewrite — use grep for now"

**EC7: Cache data older than 48 hours**
- Staleness badge on Portfolio section: "Data from 3 days ago"
- Not blocking — stale data is better than no data

## Acceptance Criteria

**Must have:**

1. Hero section displays dual KPI: health gauge (computed from cache, or "X/N analyzed") and savings counter (from usage.jsonl) — no hardcoded values
2. Benchmark section displays all 6 categories from `FINAL-RECOMMENDATION-MATRIX.md` with gap-annotated horizontal bars, including the 2 categories where grep wins
3. Tool Grid displays all 39 tools categorized into 4 groups, with call counts from usage.jsonl; unused tools shown as gray tiles with "0 calls"
4. Portfolio table shows repos with cache data sorted by health score; repos without cache show "—" grade
5. Health score uses `summary.above_threshold / summary.total_functions` — not the truncated function array length
6. Light mode charts render correctly (CSS var reading fixed in AreaChart, DonutChart, BarChart)
7. Shell injection fixed: all `execSync` string calls replaced with `execFileSync` array calls in cache.ts
8. Cron script (`scripts/refresh-cache.ts`) runs standalone, compares git commits, skips unchanged repos, writes cache files
9. launchd plist provided for daily 6 AM scheduling

**Should have:**

1. Activity section uses stacked area chart by tool category (Search/Navigate/Analyze/Operate)
2. Benchmark bars annotated with savings translated to dollars at current usage ("saves ~$X/month")
3. Tool Grid shows adoption rate badge: "26/39 active (67%)"
4. Portfolio table sortable by column (score, complexity, dead code)
5. "Run Analysis" button on portfolio section triggers cron script for uncached repos
6. Delta badges suppressed when comparison period has insufficient data

**Edge case handling:**

1. Zero repos cached: empty state with onboarding prompt in Portfolio section
2. Empty usage.jsonl: empty state in Tool Grid and Activity sections
3. Partial cache: health gauge shows "N of M repos" with progress indicator
4. Cache staleness > 48h: visual indicator on Portfolio section

## Out of Scope

- Per-repo drill-down pages (keep existing health.astro as-is)
- Admin/Portfolio page merge or redesign (separate spec)
- Real-time data or WebSocket updates
- User authentication or multi-user support
- Benchmark re-running or live benchmark comparison
- Tool recommendations ("you should use trace_route more")
- PDF export of dashboard
- Mobile-specific layout (existing responsive design is sufficient)
- Global repo filter bar (future enhancement — requires URL state management)

## Open Questions

None — all design decisions resolved in Phase 2 dialogue.
