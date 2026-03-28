# Implementation Plan: Dashboard v2 Overview Page

**Spec:** docs/specs/2026-03-28-dashboard-v2-overview-spec.md
**Created:** 2026-03-28
**Tasks:** 13
**Estimated complexity:** 8 standard, 5 complex

## Architecture Summary

The Overview page (`src/pages/index.astro`) is completely rewritten with 5 sections: dual hero (Health + Savings), benchmark chart, tool grid, portfolio table, and activity. All data is SSR-computed in Astro frontmatter; React islands receive pre-computed props.

New lib modules: `benchmark-data.ts` (static), `tool-catalog.ts` (static), `portfolio-stats.ts` (aggregation). Modified: `cache.ts` (shell injection fix + source_commit), `health-score.ts` (bug fix + new function). Three chart components get light-mode fix. Standalone cron script for daily cache refresh.

**Dependency graph:**
```
T1 (benchmark-data) ──────────────────────────┐
T2 (tool-catalog) ────────────────────────────┤
T3 (health-score fix) ──→ T5 (portfolio-stats) ├──→ T11 (index.astro)
T4 (cache.ts fix) ──────→ T5                  │
T6 (chart light mode fix) ────────────────────┤
T7 (HealthBadge extend) ─────────────────────┤
T8 (BenchmarkChart) ──────────────────────────┤
T9 (ToolGrid) ────────────────────────────────┤
T10 (PortfolioTable) ─────────────────────────┘
T4 ──→ T12 (cron script) ──→ T13 (launchd plist)
```

## Technical Decisions

- **No new runtime deps.** Recharts (existing) for BenchmarkChart. `tsx` added as devDep for cron script.
- **Chart light mode fix:** `useEffect` + `useState` + `MutationObserver` on `data-theme` attribute. Light-appropriate fallback colors.
- **PortfolioTable sort:** Vanilla JS `<script>` tag, not React island. Deferred to should-have.
- **BenchmarkChart:** Recharts `BarChart` with custom `Cell` colors + `LabelList` for gap annotations. `null` token values render as zero-width bars with label overlay. Dollar savings annotation derived from `getToolStats()` avg tokens × `SAVINGS_MULTIPLIER`.
- **Cron:** `tsx scripts/refresh-cache.ts`, sequential execution, `execFileSync` array args. Main function guarded with `import.meta.url` check for safe test imports.
- **index.astro splitting:** If rewrite exceeds 200 lines, extract section wrappers (HeroSection.astro, BenchmarkSection.astro, etc.) to stay within component file limits.

## Deferred Should-Haves

These are explicitly not implemented in this plan. Add to backlog for future work:
- **SH1 (stacked activity chart by category):** v1 AreaChart is kept as-is (not stacked). Stacking requires extending AreaChart to accept multi-series data — separate task.
- **SH4 (portfolio table sortable columns):** PortfolioTable is pure SSR. Client-side sort via `<script>` tag deferred to next iteration.

## Quality Strategy

- **Test framework:** Vitest 4.1.2, node environment, tmpdir isolation for FS tests.
- **CQ gates activated:** CQ8 (error handling in chart CSS var reading), CQ14 (reuse existing cache/health functions), CQ22 (MutationObserver cleanup).
- **Risk areas:** index.astro rewrite (HIGH — 5 new data sources), cache.ts 9-site safeExec conversion (MEDIUM), BenchmarkChart null-value handling (MEDIUM).
- **Missing test infra:** No React test env (happy-dom). Chart component tests will test the `useThemeColors` hook logic in isolation, not full component rendering. Visual verification via manual browser check.

## Task Breakdown

### Task 1: Static benchmark data module
**Files:** `src/lib/benchmark-data.ts`, `tests/lib/benchmark-data.test.ts`
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/lib/benchmark-data.test.ts
  import { describe, it, expect } from 'vitest';
  import { BENCHMARK_DATA, type BenchmarkCategory } from '../../src/lib/benchmark-data';

  describe('BENCHMARK_DATA', () => {
    it('has exactly 6 categories', () => {
      expect(BENCHMARK_DATA).toHaveLength(6);
    });

    it('has unique category IDs', () => {
      const ids = BENCHMARK_DATA.map(b => b.id);
      expect(new Set(ids).size).toBe(6);
    });

    it('category E has null codesift_tokens (timeout)', () => {
      const catE = BENCHMARK_DATA.find(b => b.id === 'E');
      expect(catE).toBeDefined();
      expect(catE!.codesift_tokens).toBeNull();
      expect(catE!.winner).toBe('grep');
    });

    it('CodeSift wins 4 of 6 categories', () => {
      const wins = BENCHMARK_DATA.filter(b => b.winner === 'codesift');
      expect(wins).toHaveLength(4);
    });
  });
  ```
- [ ] GREEN: Create `src/lib/benchmark-data.ts` with the `BenchmarkCategory` interface and `BENCHMARK_DATA` array exactly as defined in the spec (6 entries).
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/benchmark-data.test.ts`
  Expected: `Tests: 4 passed`
- [ ] Commit: `feat: add static benchmark data — 6 categories, CodeSift vs grep comparison`

---

### Task 2: Tool catalog module (39 tools)
**Files:** `src/lib/tool-catalog.ts`, `tests/lib/tool-catalog.test.ts`
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/lib/tool-catalog.test.ts
  import { describe, it, expect } from 'vitest';
  import { ALL_TOOLS, type ToolCategory } from '../../src/lib/tool-catalog';

  describe('ALL_TOOLS', () => {
    it('has exactly 39 tools', () => {
      expect(ALL_TOOLS).toHaveLength(39);
    });

    it('has correct category counts: 9 search, 10 navigate, 13 analyze, 7 operate', () => {
      const counts: Record<ToolCategory, number> = { search: 0, navigate: 0, analyze: 0, operate: 0 };
      for (const t of ALL_TOOLS) counts[t.category]++;
      expect(counts).toEqual({ search: 9, navigate: 10, analyze: 13, operate: 7 });
    });

    it('has no duplicate tool names', () => {
      const names = ALL_TOOLS.map(t => t.name);
      expect(new Set(names).size).toBe(39);
    });

    it('all tool names are lowercase with underscores only', () => {
      for (const t of ALL_TOOLS) {
        expect(t.name).toMatch(/^[a-z_]+$/);
      }
    });
  });
  ```
- [ ] GREEN: Create `src/lib/tool-catalog.ts` with the `ToolInfo`, `ToolCategory` types and `ALL_TOOLS` array (39 entries, 4 categories) exactly as defined in the spec.
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/tool-catalog.test.ts`
  Expected: `Tests: 4 passed`
- [ ] Commit: `feat: add 39-tool catalog with 4 categories — search, navigate, analyze, operate`

---

### Task 3: Fix health score formula + computeHealthFromCache (P0 bug)
**Files:** `src/lib/health-score.ts` (modify), `tests/lib/health-score.test.ts` (new)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/lib/health-score.test.ts
  import { describe, it, expect } from 'vitest';
  import { computeHealthFromCache, computeHealthGrade } from '../../src/lib/health-score';
  import type { CachedHealthData } from '../../src/lib/cache';

  describe('computeHealthFromCache', () => {
    it('uses summary.total_functions, not functions.length (P0 bug regression)', () => {
      const cached = {
        complexity: {
          functions: new Array(30),
          summary: { above_threshold: 69, total_functions: 381 },
        },
        dead_code: { candidates: new Array(5) },
        hotspots: { hotspots: new Array(2) },
      } as unknown as CachedHealthData;

      const health = computeHealthFromCache(cached);
      expect(health.totalFunctions).toBe(381);
      expect(health.complexFunctions).toBe(69);
    });

    it('falls back to array counting when summary is null', () => {
      const cached = {
        complexity: {
          functions: [
            { cyclomatic_complexity: 15 },
            { cyclomatic_complexity: 5 },
            { cyclomatic_complexity: 12 },
          ],
          summary: null,
        },
        dead_code: { candidates: [{}, {}] },
        hotspots: { hotspots: [{}] },
      } as unknown as CachedHealthData;

      const health = computeHealthFromCache(cached);
      expect(health.totalFunctions).toBe(3);
      expect(health.complexFunctions).toBe(2); // 15 and 12 are > 10
      expect(health.deadCodeCount).toBe(2);
      expect(health.hotspotCount).toBe(1);
    });
  });

  describe('computeHealthGrade', () => {
    it('returns grade A for score >= 85', () => {
      const result = computeHealthGrade({
        complexFunctions: 0, totalFunctions: 100,
        deadCodeCount: 0, hotspotCount: 0, communityModularity: 0,
      });
      expect(result.grade).toBe('A');
      expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('returns grade F for high complexity + high dead code', () => {
      const result = computeHealthGrade({
        complexFunctions: 80, totalFunctions: 100,
        deadCodeCount: 50, hotspotCount: 20, communityModularity: 0,
      });
      expect(result.grade).toBe('F');
      expect(result.score).toBeLessThan(40);
    });

    it('handles totalFunctions = 0 without division error', () => {
      const result = computeHealthGrade({
        complexFunctions: 0, totalFunctions: 0,
        deadCodeCount: 0, hotspotCount: 0, communityModularity: 0,
      });
      expect(result.score).toBe(100);
    });
  });
  ```
- [ ] GREEN: In `health-score.ts`:
  1. Add `export` keyword to `HealthData` interface (line 3)
  2. Add `import type { CachedHealthData } from './cache';`
  3. Add `computeHealthFromCache` function as defined in spec
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/health-score.test.ts`
  Expected: `Tests: 5 passed`
- [ ] Commit: `fix: health score uses summary totals instead of truncated array — P0 regression test`

---

### Task 4: Fix shell injection in cache.ts + add source_commit field
**Files:** `src/lib/cache.ts` (modify), `tests/lib/cache.test.ts` (extend)
**Complexity:** complex
**Dependencies:** none
**Model routing:** Opus

- [ ] RED: Write failing tests (add to existing cache.test.ts)
  ```typescript
  // Add to tests/lib/cache.test.ts
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';

  describe('CachedHealthData.source_commit', () => {
    const testDir = join(tmpdir(), `cache-test-sc-${Date.now()}`);
    beforeEach(() => mkdirSync(testDir, { recursive: true }));
    afterEach(() => rmSync(testDir, { recursive: true, force: true }));

    it('getCachedHealth returns source_commit when present', async () => {
      const { getCachedHealth } = await import('../../src/lib/cache');
      const data = {
        repo: 'local/test',
        generated_at: Date.now(),
        source_commit: 'abc123',
        complexity: { functions: [], summary: null },
        dead_code: { candidates: [] },
        hotspots: { hotspots: [] },
        patterns: { counts: {}, patterns: [], total: 0 },
        clones: [],
        circular_deps: [],
        impact: { risk_scores: [] },
        community_mermaid: '',
      };
      writeFileSync(join(testDir, 'local--test.json'), JSON.stringify(data));
      const result = getCachedHealth('local/test', testDir);
      expect(result?.source_commit).toBe('abc123');
    });
  });

  describe('safeExecFile uses array args (shell injection fix)', () => {
    it('cache.ts uses execFileSync, not execSync with string interpolation', async () => {
      const src = readFileSync(
        join(process.cwd(), 'src/lib/cache.ts'), 'utf-8'
      );
      // After fix: execFileSync replaces execSync in the import
      expect(src).toContain('execFileSync');
      // No remaining execSync usage (the import line will say execFileSync)
      expect(src).not.toMatch(/\bexecSync\b/);
    });
  });
  ```
- [ ] GREEN: In `cache.ts`:
  1. Add `source_commit?: string` to `CachedHealthData` interface
  2. Replace `import { execSync } from 'node:child_process'` with `import { execFileSync } from 'node:child_process'`
  3. Replace `safeExec(cmd: string)` with `safeExecFile(bin: string, args: string[]): string` using `execFileSync(bin, args, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })`
  4. Convert all 9 call sites in `refreshRepoCache` from `safeExec(\`codesift X "${repoName}" ...\`)` to `safeExecFile('codesift', ['X', repoName, ...])`
  5. Convert pattern loop to `safeExecFile('codesift', ['patterns', repoName, '--pattern', p, '--compact'])`
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/cache.test.ts`
  Expected: All tests pass (baseline + 2 new). Verify baseline count first with `npx vitest run tests/lib/cache.test.ts` before adding new tests.
- [ ] Commit: `fix: replace execSync string interpolation with execFileSync array args — prevents shell injection`

---

### Task 5: Portfolio stats aggregation module
**Files:** `src/lib/portfolio-stats.ts` (new), `tests/lib/portfolio-stats.test.ts` (new)
**Complexity:** standard
**Dependencies:** Task 3, Task 4
**Model routing:** Sonnet

- [ ] RED: Write failing test
  ```typescript
  // tests/lib/portfolio-stats.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';

  describe('computePortfolioSummary', () => {
    const testDir = join(tmpdir(), `portfolio-test-${Date.now()}`);
    beforeEach(() => mkdirSync(testDir, { recursive: true }));
    afterEach(() => rmSync(testDir, { recursive: true, force: true }));

    function writeCache(name: string, complexity: { above_threshold: number; total_functions: number }, deadCode: number) {
      const data = {
        repo: name, generated_at: Date.now(),
        complexity: { functions: [], summary: complexity },
        dead_code: { candidates: new Array(deadCode) },
        hotspots: { hotspots: [] },
        patterns: { counts: {}, patterns: [], total: 0 },
        clones: [], circular_deps: [], impact: { risk_scores: [] }, community_mermaid: '',
      };
      writeFileSync(join(testDir, name.replace(/\//g, '--') + '.json'), JSON.stringify(data));
    }

    it('aggregates scores across multiple cached repos', async () => {
      const { computePortfolioSummary } = await import('../../src/lib/portfolio-stats');
      writeCache('local/repo-a', { above_threshold: 0, total_functions: 100 }, 0);
      writeCache('local/repo-b', { above_threshold: 50, total_functions: 100 }, 20);
      const repos = [{ name: 'local/repo-a' }, { name: 'local/repo-b' }, { name: 'local/repo-c' }];
      const result = computePortfolioSummary(repos as any, testDir);
      expect(result.totalRepos).toBe(3);
      expect(result.analyzedRepos).toBe(2);
      expect(result.avgScore).toBeGreaterThan(0);
      expect(result.breakdown).toHaveLength(2);
    });

    it('returns zero score when no repos are cached', async () => {
      const { computePortfolioSummary } = await import('../../src/lib/portfolio-stats');
      const repos = [{ name: 'local/none' }];
      const result = computePortfolioSummary(repos as any, testDir);
      expect(result.analyzedRepos).toBe(0);
      expect(result.avgScore).toBe(0);
      expect(result.avgGrade).toBe('—');
      expect(result.breakdown).toHaveLength(0);
    });
  });
  ```
- [ ] GREEN: Create `src/lib/portfolio-stats.ts`:
  - `computePortfolioSummary(repos, cacheDir?)` reads cache for each repo, calls `computeHealthFromCache` + `computeHealthGrade`, averages scores
  - Guard: `analyzedRepos === 0` → return `avgScore: 0, avgGrade: '—'`
  - Returns `PortfolioSummary` as defined in spec
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/portfolio-stats.test.ts`
  Expected: `Tests: 2 passed`
- [ ] Commit: `feat: portfolio stats — aggregate health scores across cached repos with zero-division guard`

---

### Task 6: Fix light mode chart rendering (P0)
**Files:** `src/components/AreaChart.tsx`, `src/components/DonutChart.tsx`, `src/components/BarChart.tsx` (all modify)
**Complexity:** complex
**Dependencies:** none
**Model routing:** Opus

- [ ] RED: Source-level tests. Before the fix, these fail because dark fallbacks ARE present and useEffect/MutationObserver are NOT:
  ```typescript
  // tests/lib/theme-colors.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'fs';
  import { join } from 'path';

  function readComponent(name: string) {
    return readFileSync(join(process.cwd(), 'src/components', name), 'utf-8');
  }

  describe('chart light mode fallbacks', () => {
    it('AreaChart has no dark hex fallbacks and uses reactive theme reading', () => {
      const src = readComponent('AreaChart.tsx');
      expect(src).not.toContain("'#151b28'");
      expect(src).not.toContain("'#1e2638'");
      expect(src).toContain('useEffect');
      expect(src).toContain('MutationObserver');
      // CQ22: cleanup — observer must be disconnected
      expect(src).toContain('observer.disconnect');
    });

    it('DonutChart has no dark hex fallbacks and uses reactive theme reading', () => {
      const src = readComponent('DonutChart.tsx');
      expect(src).not.toContain("'#151b28'");
      expect(src).toContain('useEffect');
      expect(src).toContain('MutationObserver');
      expect(src).toContain('observer.disconnect');
    });

    it('BarChart has no dark hex fallbacks and uses reactive theme reading', () => {
      const src = readComponent('BarChart.tsx');
      expect(src).not.toContain("'#151b28'");
      expect(src).toContain('useEffect');
      expect(src).toContain('MutationObserver');
      expect(src).toContain('observer.disconnect');
    });
  });
  ```
- [ ] GREEN: In all 3 chart components:
  1. Extract a shared `useThemeColors` hook pattern (or apply inline to each):
     - Replace synchronous `getVar` calls in render body with `useState` + `useEffect`
     - Add `MutationObserver` on `document.documentElement` for `attributeFilter: ['data-theme']`
     - Return cleanup function: `observer.disconnect()`
  2. Change fallback colors from dark hex to light-appropriate defaults (`'#ffffff'`, `'#e5e7eb'`, `'#111827'`, `'#6b7280'`)
  3. Guard `typeof document === 'undefined'` for SSR safety
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/theme-colors.test.ts`
  Expected: `Tests: 3 passed`
- [ ] Commit: `fix: chart components read CSS vars via useEffect + MutationObserver — fixes light mode rendering`

---

### Task 7: Extend HealthBadge for partial-cache mode
**Files:** `src/components/HealthBadge.astro` (modify)
**Complexity:** standard
**Dependencies:** none
**Model routing:** Sonnet

- [ ] RED: Source-level verification test:
  ```typescript
  // tests/components/health-badge.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'fs';

  describe('HealthBadge partial-cache mode', () => {
    const src = readFileSync('src/components/HealthBadge.astro', 'utf-8');

    it('accepts analyzedCount and totalCount props', () => {
      expect(src).toContain('analyzedCount');
      expect(src).toContain('totalCount');
    });

    it('renders partial text when analyzedCount is provided', () => {
      expect(src).toContain('of');
      expect(src).toContain('repos');
    });
  });
  ```
- [ ] GREEN: In `HealthBadge.astro`:
  1. Add `analyzedCount?: number` and `totalCount?: number` to Props interface
  2. When `analyzedCount !== undefined`, render "N of M repos" text instead of score number
  3. Gauge fill based on `analyzedCount / totalCount` ratio
  4. Keep existing grade/score rendering when `analyzedCount` is undefined (backward compatible)
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/components/health-badge.test.ts`
  Expected: `Tests: 2 passed`
- [ ] Commit: `feat: HealthBadge supports partial-cache mode — shows "N of M repos" when data is incomplete`

---

### Task 8: BenchmarkChart React component
**Files:** `src/components/BenchmarkChart.tsx` (new)
**Complexity:** complex
**Dependencies:** Task 1 (benchmark-data types)
**Model routing:** Opus

- [ ] RED: Source-level test:
  ```typescript
  // tests/components/benchmark-chart.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'fs';

  describe('BenchmarkChart component', () => {
    it('exists and exports default', async () => {
      const mod = await import('../../src/components/BenchmarkChart');
      expect(mod.default).toBeDefined();
      expect(typeof mod.default).toBe('function');
    });

    it('handles null codesift_tokens without crash', () => {
      const src = readFileSync('src/components/BenchmarkChart.tsx', 'utf-8');
      // Must have null guard for token arithmetic
      expect(src).toMatch(/codesift_tokens\s*(!==?\s*null|!=\s*null|\?\?)/);
    });

    it('uses useEffect for theme colors (light mode safe)', () => {
      const src = readFileSync('src/components/BenchmarkChart.tsx', 'utf-8');
      expect(src).toContain('useEffect');
      expect(src).toContain('MutationObserver');
    });
  });
  ```
- [ ] GREEN: Create `src/components/BenchmarkChart.tsx`:
  - Props: `data: BenchmarkCategory[]`, `savingsPerMonth?: number` (optional dollar annotation from usage data)
  - Recharts `BarChart` with horizontal layout, grouped bars (codesift + grep per category)
  - Custom `Cell` color: green for CodeSift wins, red/gray for losses
  - `LabelList` for delta annotations (e.g., "−33%", "Timeout")
  - Null-guard: categories with `null` tokens render text annotation instead of bar
  - Summary line: "CodeSift wins N/6 categories"
  - `useEffect` + `MutationObserver` for theme-reactive colors
  - `client:load` (hero-adjacent, high priority)
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/components/benchmark-chart.test.ts`
  Expected: `Tests: 3 passed`
- [ ] Commit: `feat: BenchmarkChart — 6-category gap-annotated comparison with null-safe rendering`

---

### Task 9: ToolGrid Astro component
**Files:** `src/components/ToolGrid.astro` (new)
**Complexity:** standard
**Dependencies:** Task 2 (tool-catalog types)
**Model routing:** Sonnet

- [ ] RED: Source-level test:
  ```typescript
  // tests/components/tool-grid.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'fs';

  describe('ToolGrid component', () => {
    it('exists and imports ALL_TOOLS', () => {
      const src = readFileSync('src/components/ToolGrid.astro', 'utf-8');
      expect(src).toContain("import { ALL_TOOLS");
      expect(src).toContain("tool-catalog");
    });

    it('renders all 4 categories', () => {
      const src = readFileSync('src/components/ToolGrid.astro', 'utf-8');
      expect(src).toContain('search');
      expect(src).toContain('navigate');
      expect(src).toContain('analyze');
      expect(src).toContain('operate');
    });

    it('shows adoption rate', () => {
      const src = readFileSync('src/components/ToolGrid.astro', 'utf-8');
      expect(src).toMatch(/active|adoption|of 39/i);
    });
  });
  ```
- [ ] GREEN: Create `src/components/ToolGrid.astro`:
  - Props: `tools: ToolInfo[]`, `usage: Map<string, number>` (tool name → call count)
  - Renders 4 category sections (Search, Navigate, Analyze, Operate)
  - Each tool tile: name, call count (or "0 calls" grayed out)
  - Active tools: colored background, inactive: gray/muted
  - Header: "26/39 active (67%)" adoption rate badge
  - Pure SSR, no client JS
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/components/tool-grid.test.ts`
  Expected: `Tests: 3 passed`
- [ ] Commit: `feat: ToolGrid — 39-tool categorized grid with usage counts and adoption rate`

---

### Task 10: PortfolioTable Astro component
**Files:** `src/components/PortfolioTable.astro` (new)
**Complexity:** standard
**Dependencies:** Task 5 (portfolio-stats types)
**Model routing:** Sonnet

- [ ] RED: Source-level test:
  ```typescript
  // tests/components/portfolio-table.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'fs';

  describe('PortfolioTable component', () => {
    it('exists and imports PortfolioSummary type', () => {
      const src = readFileSync('src/components/PortfolioTable.astro', 'utf-8');
      expect(src).toContain('portfolio-stats');
    });

    it('handles empty state when no repos analyzed', () => {
      const src = readFileSync('src/components/PortfolioTable.astro', 'utf-8');
      expect(src).toMatch(/no.*repos|empty|analyzed/i);
    });

    it('shows staleness indicator', () => {
      const src = readFileSync('src/components/PortfolioTable.astro', 'utf-8');
      expect(src).toMatch(/stale|ago|fresh/i);
    });
  });
  ```
- [ ] GREEN: Create `src/components/PortfolioTable.astro`:
  - Props: `summary: PortfolioSummary`, `cacheAges: Map<string, number>`
  - Table: repo name | grade badge | score | complexity count | dead code count | patterns count
  - Repos with cache: sorted by score descending
  - Repos without cache: show "—" grade, listed at bottom
  - Staleness badge: "Data from N days ago" when `cacheAge > 48h`
  - Empty state: "No repos analyzed yet" with "Run Analysis" button (`<a href="/api/refresh-cache" data-action="post">`) — wired via inline `<script>` that intercepts click and sends POST to `/api/refresh-cache`
  - Pure SSR with `EmptyState` component reuse
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/components/portfolio-table.test.ts`
  Expected: `Tests: 3 passed`
- [ ] Commit: `feat: PortfolioTable — repo health table with staleness badges and empty state`

---

### Task 11: Rewrite index.astro Overview page
**Files:** `src/pages/index.astro` (rewrite)
**Complexity:** complex
**Dependencies:** Tasks 1-10
**Model routing:** Opus

- [ ] RED: Integration test checking page builds without error:
  ```typescript
  // tests/pages/index.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'fs';

  describe('index.astro overview page', () => {
    const src = readFileSync('src/pages/index.astro', 'utf-8');

    it('imports all 5 section components', () => {
      expect(src).toContain('BenchmarkChart');
      expect(src).toContain('ToolGrid');
      expect(src).toContain('PortfolioTable');
      expect(src).toContain('HealthBadge');
      expect(src).toContain('AreaChart');
    });

    it('imports new lib modules', () => {
      expect(src).toContain('benchmark-data');
      expect(src).toContain('tool-catalog');
      expect(src).toContain('portfolio-stats');
    });

    it('does not contain hardcoded health grade', () => {
      expect(src).not.toContain('grade="B"');
      expect(src).not.toContain('score={72}');
    });

    it('sections appear in value-first order', () => {
      const heroPos = src.indexOf('HealthBadge');
      const benchPos = src.indexOf('BenchmarkChart');
      const toolPos = src.indexOf('ToolGrid');
      const portPos = src.indexOf('PortfolioTable');
      const actPos = src.lastIndexOf('AreaChart');
      expect(heroPos).toBeLessThan(benchPos);
      expect(benchPos).toBeLessThan(toolPos);
      expect(toolPos).toBeLessThan(portPos);
      expect(portPos).toBeLessThan(actPos);
    });
  });
  ```
- [ ] GREEN: Rewrite `src/pages/index.astro`:
  - Frontmatter: import all new modules, compute portfolio summary, merge tool stats with catalog, prepare benchmark data
  - Savings formula: `computeSavings(entries)` returns `{ tokens, cost }` using existing `SAVINGS_MULTIPLIER` × actual tokens. Display as `$${cost.toFixed(2)}` + `${(tokens/1000).toFixed(0)}K tokens`
  - Delta suppression (EC3/SH6): if `daily.length < 7`, pass `delta={undefined}` to MetricCards (suppresses badge)
  - Section 1 (Hero): `HealthBadge` with computed portfolio avg (or partial mode) + `MetricCard` for savings
  - Section 2 (Benchmark): `BenchmarkChart client:load` with `BENCHMARK_DATA`
  - Section 3 (Tool Grid): `ToolGrid` with merged tool + usage data (left-join: for each ALL_TOOLS entry, lookup call count from getToolStats Map, default 0)
  - Section 4 (Portfolio): `PortfolioTable` with computed summary
  - Section 5 (Activity): `AreaChart client:visible` + `DataTable client:visible` (kept from v1)
  - Keep: TimeFilter, ErrorBanner, try/catch error boundary, yesterday banner
  - Each section wrapped in try/catch for independent failure isolation
  - **File limit:** If page exceeds 200 lines, extract section wrappers into `HeroSection.astro`, `BenchmarkSection.astro` etc. Commit section-by-section within T11 for intermediate green states.
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/pages/index.test.ts && npx astro check`
  Expected: `Tests: 4 passed`, `astro check` passes with no errors
- [ ] Commit: `feat: Overview page v2 — dual hero, benchmark chart, tool grid, portfolio table, activity`

---

### Task 12: Incremental cron cache refresh script
**Files:** `scripts/refresh-cache.ts` (new), `tests/scripts/refresh-cache.test.ts` (new), `package.json` (add tsx devDep)
**Complexity:** complex
**Dependencies:** Task 4 (cache.ts with execFileSync + source_commit)
**Model routing:** Opus

- [ ] RED: Write failing test
  ```typescript
  // tests/scripts/refresh-cache.test.ts
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmpdir } from 'node:os';

  describe('refresh-cache script logic', () => {
    const testDir = join(tmpdir(), `cron-test-${Date.now()}`);
    const cacheDir = join(testDir, 'cache');
    const registryPath = join(testDir, 'registry.json');

    beforeEach(() => {
      mkdirSync(cacheDir, { recursive: true });
    });
    afterEach(() => rmSync(testDir, { recursive: true, force: true }));

    it('skips repo when source_commit matches last_git_commit', async () => {
      const { shouldRefreshRepo } = await import('../../scripts/refresh-cache');
      const cached = { source_commit: 'abc123' };
      const registry = { last_git_commit: 'abc123' };
      expect(shouldRefreshRepo(cached as any, registry as any)).toBe(false);
    });

    it('refreshes repo when commits differ', async () => {
      const { shouldRefreshRepo } = await import('../../scripts/refresh-cache');
      const cached = { source_commit: 'abc123' };
      const registry = { last_git_commit: 'def456' };
      expect(shouldRefreshRepo(cached as any, registry as any)).toBe(true);
    });

    it('refreshes repo when no cache exists', async () => {
      const { shouldRefreshRepo } = await import('../../scripts/refresh-cache');
      expect(shouldRefreshRepo(null, { last_git_commit: 'abc123' } as any)).toBe(true);
    });

    it('refreshes repo when cache has no source_commit', async () => {
      const { shouldRefreshRepo } = await import('../../scripts/refresh-cache');
      const cached = { generated_at: Date.now() };
      expect(shouldRefreshRepo(cached as any, { last_git_commit: 'abc123' } as any)).toBe(true);
    });
  });
  ```
- [ ] GREEN: Create `scripts/refresh-cache.ts`:
  1. Export `shouldRefreshRepo(cached, registryEntry)` — compares `source_commit` vs `last_git_commit`
  2. Main function: reads registry.json, iterates repos, calls `shouldRefreshRepo`, calls `refreshRepoCache` for changed repos
  3. After refresh, reads the written cache file and adds `source_commit` from registry
  4. Logs summary: "Refreshed N/M repos (K unchanged) in Xs"
  5. Uses `execFileSync` array args throughout (via imported `refreshRepoCache`)
  6. **Guard main execution** for safe test imports: `if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) { main(); }` — prevents `main()` from firing when imported in tests
  7. Add `tsx` to `package.json` devDependencies
  8. Keep under 300 lines (service file limit)
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/scripts/refresh-cache.test.ts`
  Expected: `Tests: 4 passed`
- [ ] Commit: `feat: incremental cron script — skips unchanged repos via git commit comparison`

---

### Task 13: launchd plist for daily scheduling
**Files:** `com.codesift.refresh-cache.plist` (new)
**Complexity:** standard
**Dependencies:** Task 12
**Model routing:** Sonnet

- [ ] RED: Validation test:
  ```typescript
  // tests/scripts/launchd-plist.test.ts
  import { describe, it, expect } from 'vitest';
  import { readFileSync, existsSync } from 'fs';

  describe('launchd plist', () => {
    it('plist file exists', () => {
      expect(existsSync('com.codesift.refresh-cache.plist')).toBe(true);
    });

    it('schedules at 6 AM', () => {
      const src = readFileSync('com.codesift.refresh-cache.plist', 'utf-8');
      expect(src).toContain('<key>Hour</key>');
      expect(src).toContain('<integer>6</integer>');
    });

    it('references refresh-cache script', () => {
      const src = readFileSync('com.codesift.refresh-cache.plist', 'utf-8');
      expect(src).toContain('refresh-cache');
    });
  });
  ```
- [ ] GREEN: Create `com.codesift.refresh-cache.plist`:
  - Label: `com.codesift.refresh-cache`
  - ProgramArguments: `npx tsx scripts/refresh-cache.ts` (or direct node path)
  - WorkingDirectory: `/Users/greglas/DEV/codesift-dashboard`
  - StartCalendarInterval: Hour 6, Minute 0
  - StandardOutPath/StandardErrorPath: log files in `~/.codesift/logs/`
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/scripts/launchd-plist.test.ts`
  Expected: `Tests: 3 passed`
- [ ] Commit: `feat: launchd plist — daily 6 AM cache refresh schedule`
