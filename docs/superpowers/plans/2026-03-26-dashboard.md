# CodeSift Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Astro dashboard with 4 tabs (Overview, Analytics, Code Health, Admin) + badge API

**Architecture:** Astro + React islands + Recharts + Mermaid + Tailwind. Reads usage.jsonl + calls CodeSift CLI for health data. Separate package alongside codesift-mcp.

**Tech Stack:** Astro 5, React 19, Recharts, D3 (treemap only), Mermaid.js, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-26-dashboard-design.md`

---

## IMPORTANT: Data Reality Check

Before implementing, understand what data ACTUALLY exists:

### Available Data Sources

| Source | How to access | What it contains |
|--------|-------------|-----------------|
| `~/.codesift/usage.jsonl` | Read file, parse JSONL | ts, tool, repo, args_summary, elapsed_ms, result_tokens, result_chunks, session_id |
| `~/.codesift/registry.json` | Read file, parse JSON | repos[]: name, root, index_path, symbol_count, file_count, updated_at |
| `codesift complexity <repo>` | CLI exec | `{ functions: [{ name, file, cyclomatic_complexity, max_nesting_depth, lines }] }` |
| `codesift dead-code <repo>` | CLI exec | `{ candidates: [{ name, kind, file, reason }] }` |
| `codesift hotspots <repo>` | CLI exec | `{ hotspots: [{ file, hotspot_score, change_count }] }` — **may be empty if no git history** |
| `codesift communities <repo>` | CLI exec | `{ communities: [...], modularity, total_files }` |
| `*.index.json` files | Read file | Full CodeIndex with symbols[], files[] |
| `*.embeddings.ndjson` | Check existence | Boolean: has embeddings or not |

### NOT Available (don't build features for these)

- ❌ Per-user data (only session_id, no user identity)
- ❌ Uptime/health check (no monitoring system)
- ❌ Persisted error log (stderr only)
- ❌ Historical health scores (computed on demand each time)
- ❌ Cumulative token savings across restarts (resets to 0)
- ❌ API keys / billing / usage limits
- ❌ LSP session details (not exposed via CLI)

### Adjusted Design Decisions

| Spec says | Reality-adjusted |
|-----------|-----------------|
| "5 KPI cards incl. Tokens Saved $X" | Compute savings from usage.jsonl: `sum(result_tokens * multiplier)` |
| "Active Users / Week" | Active **Sessions** / Week (session_id count) |
| "Admin: Uptime, Errors, Cache" | Admin: Repo Index Status + File counts only. Skip uptime/errors/cache. |
| "Admin: LSP Server Status" | Skip — not exposed via CLI, only internal Map |
| "Admin: API Keys" | Skip — no auth layer exists |

---

## File Structure

```
codesift-dashboard/
├── package.json
├── astro.config.mjs
├── tailwind.config.mjs
├── tsconfig.json
├── src/
│   ├── layouts/
│   │   └── DashboardLayout.astro
│   ├── pages/
│   │   ├── index.astro              ← Overview
│   │   ├── analytics.astro          ← Analytics
│   │   ├── health.astro             ← Code Health
│   │   ├── admin.astro              ← Admin
│   │   └── api/
│   │       ├── badge/[repo].ts      ← Badge endpoint
│   │       └── metrics.ts           ← Public metrics
│   ├── components/
│   │   ├── MetricCard.astro
│   │   ├── HealthBadge.astro
│   │   ├── Sidebar.astro
│   │   ├── AreaChart.tsx
│   │   ├── DonutChart.tsx
│   │   ├── BarChart.tsx
│   │   ├── Treemap.tsx
│   │   ├── MermaidDiagram.astro
│   │   └── DataTable.tsx
│   ├── lib/
│   │   ├── usage-data.ts            ← Parse usage.jsonl
│   │   ├── registry-data.ts         ← Parse registry.json
│   │   ├── health-score.ts          ← Compute A-F from CLI output
│   │   ├── savings.ts               ← Compute token savings from usage data
│   │   └── config.ts                ← Paths, constants
│   └── styles/
│       └── global.css               ← CSS variables (dark theme)
└── public/
    └── favicon.svg
```

---

## Task 1: Project Scaffolding + Layout (4h)

**Files:**
- Create: entire `codesift-dashboard/` project
- Key: `package.json`, `astro.config.mjs`, `tailwind.config.mjs`, `DashboardLayout.astro`, `Sidebar.astro`, `global.css`

- [ ] **Step 1: Create project**

```bash
mkdir codesift-dashboard && cd codesift-dashboard
npm create astro@latest -- --template minimal --no-git --no-install
npm install @astrojs/react @astrojs/tailwind react react-dom recharts tailwindcss
npm install -D @types/react @types/react-dom
```

- [ ] **Step 2: Configure Astro**

`astro.config.mjs`:
```javascript
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  integrations: [react(), tailwind()],
  output: 'static',
});
```

- [ ] **Step 3: Create global.css with dark theme palette**

Full CSS variables from spec (--bg-base through --chart-8).

- [ ] **Step 4: Create Sidebar.astro**

Fixed left sidebar, 56px collapsed / 220px expanded. Nav items: Overview, Analytics, Health, Admin. Logo at top. Active state highlighting.

- [ ] **Step 5: Create DashboardLayout.astro**

Grid layout: sidebar + main content area. Max-width 1400px. 24px gaps.

- [ ] **Step 6: Create placeholder pages**

4 pages (index, analytics, health, admin) — each with DashboardLayout and "Coming soon" content.

- [ ] **Step 7: Verify it runs**

```bash
npm run dev
# → opens localhost:4321 with dark sidebar + placeholder content
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(dashboard): project scaffolding — Astro + Tailwind + dark theme sidebar"
```

---

## Task 2: Data Layer (6h)

**Files:**
- Create: `src/lib/config.ts`, `src/lib/usage-data.ts`, `src/lib/registry-data.ts`, `src/lib/health-score.ts`, `src/lib/savings.ts`

- [ ] **Step 1: Create config.ts**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

export const CODESIFT_DIR = join(homedir(), ".codesift");
export const USAGE_PATH = join(CODESIFT_DIR, "usage.jsonl");
export const REGISTRY_PATH = join(CODESIFT_DIR, "registry.json");

export const SAVINGS_MULTIPLIER: Record<string, number> = {
  search_text: 1.5,
  search_symbols: 1.0,
  get_file_outline: 3.0,
  get_file_tree: 1.25,
  find_references: 1.5,
  codebase_retrieval: 3.0,
  assemble_context: 5.0,
  trace_call_chain: 4.0,
  impact_analysis: 3.0,
  detect_communities: 2.0,
  trace_route: 4.0,
  get_context_bundle: 3.0,
};

export const OPUS_COST_PER_TOKEN = 30 / 1_000_000;
```

- [ ] **Step 2: Create usage-data.ts**

Parse usage.jsonl → typed objects. Functions:
- `getUsageEntries(since?: Date)` → array of entries
- `getToolStats()` → per-tool aggregates
- `getDailyStats()` → per-day aggregates
- `getSessionCount()` → unique session_ids
- `getRepoStats()` → per-repo aggregates

**IMPORTANT:** Read actual usage.jsonl fields: `ts`, `tool`, `repo`, `args_summary`, `elapsed_ms`, `result_tokens`, `result_chunks`, `session_id`

- [ ] **Step 3: Create registry-data.ts**

Parse registry.json → repo list. Functions:
- `getRepos()` → array of { name, root, file_count, symbol_count, updated_at, has_embeddings }
- Check for `*.embeddings.ndjson` existence per repo

- [ ] **Step 4: Create savings.ts**

Compute token savings from usage data (NOT from getCumulativeSavings which resets):
```typescript
function computeSavings(entries: UsageEntry[]): { tokens: number; cost: number } {
  let saved = 0;
  for (const e of entries) {
    const mult = SAVINGS_MULTIPLIER[e.tool] ?? 1.0;
    if (mult > 1.0) saved += Math.round(e.result_tokens * (mult - 1));
  }
  return { tokens: saved, cost: saved * OPUS_COST_PER_TOKEN };
}
```

- [ ] **Step 5: Create health-score.ts**

Call CodeSift CLI for repo health. **Handle**: non-array returns, empty hotspots, CLI errors.

```typescript
async function getRepoHealth(repoName: string) {
  // codesift complexity <repo> → parse { functions: [...] }
  // codesift dead-code <repo> → parse { candidates: [...] }
  // codesift hotspots <repo> → parse { hotspots: [...] } — may be empty!
  // Compute score 0-100 → grade A-F
}
```

**Return shape for each CLI tool:**
- complexity: `{ functions: [{ name, file, cyclomatic_complexity, lines }] }`
- dead-code: `{ candidates: [{ name, kind, file, reason }] }`
- hotspots: `{ hotspots: [{ file, hotspot_score, change_count }] }` — often empty!

- [ ] **Step 6: Commit**

```bash
git add src/lib/
git commit -m "feat(dashboard): data layer — usage.jsonl parser, registry, health score, savings"
```

---

## Task 3: MetricCard + HealthBadge Components (2h)

**Files:**
- Create: `src/components/MetricCard.astro`, `src/components/HealthBadge.astro`

- [ ] **Step 1: Create MetricCard.astro**

Props: label, value, trend (optional), sparklineData (optional). Pure Astro (0 JS). Inline SVG sparkline.

- [ ] **Step 2: Create HealthBadge.astro**

Props: grade (A-F), score (0-100). Large colored badge. Green A through Red F.

- [ ] **Step 3: Commit**

---

## Task 4: Overview Page (8h)

**Files:**
- Modify: `src/pages/index.astro`
- Create: `src/components/AreaChart.tsx`, `src/components/DonutChart.tsx`

- [ ] **Step 1: Create AreaChart.tsx (React island)**

Recharts AreaChart with dark theme styling. Props: data, xKey, yKey, color.

- [ ] **Step 2: Create DonutChart.tsx (React island)**

Recharts PieChart (donut variant). Props: data (name, value)[]. Center label.

- [ ] **Step 3: Build Overview page**

Layout:
- Row 1: HealthBadge + 4 MetricCards (repos, symbols, searches today, tokens saved $)
- Row 2: Sessions/Week AreaChart (full width)
- Row 3: Tool Usage DonutChart (half) + Top Repos BarChart (half)
- Row 4: Recent Activity DataTable (last 20 calls)

Data: read from usage-data.ts + registry-data.ts at build time (SSG) or via API route.

- [ ] **Step 4: Verify in browser**

```bash
npm run dev
# Overview page shows real data from usage.jsonl
```

- [ ] **Step 5: Commit**

---

## Task 5: Analytics Page (10h)

**Files:**
- Modify: `src/pages/analytics.astro`
- Create: `src/components/BarChart.tsx`, `src/components/DataTable.tsx`

- [ ] **Step 1: Create BarChart.tsx**

Recharts horizontal BarChart. Dark theme. Props: data, nameKey, valueKey.

- [ ] **Step 2: Create DataTable.tsx**

Sortable table React island. Columns config, sort by click, search filter. Dark theme.

- [ ] **Step 3: Build Analytics page**

Layout:
- Filter bar: time range selector (7d/30d/90d)
- Calls Over Time: stacked AreaChart by tool
- Per-Tool Breakdown: BarChart sorted by count
- Response Time: AreaChart with p50 line
- Top Queries: DataTable (query, tool, count, avg tokens)
- Token Savings Cumulative: AreaChart with $ total

- [ ] **Step 4: Commit**

---

## Task 6: Code Health Page (12h)

**Files:**
- Modify: `src/pages/health.astro`
- Create: `src/components/Treemap.tsx`, `src/components/MermaidDiagram.astro`

- [ ] **Step 1: Create Treemap.tsx**

D3 treemap layout rendered as SVG React island. Size = file lines, color = complexity. Click to drill into directories. Tooltip.

- [ ] **Step 2: Create MermaidDiagram.astro**

Client-side Mermaid.js rendering. Dark theme config. Pan/zoom wrapper. Props: mermaidCode.

- [ ] **Step 3: Build Health page**

Layout:
- Repo selector dropdown
- Health card row: grade badge + complex functions count + dead code count + hotspots count + communities count
- Treemap: files colored by complexity (full width)
- Community Map: Mermaid graph (half) + Hotspots BarChart (half)

**IMPORTANT:**
- Call CLI: `codesift complexity <repo>` → use `.functions` field
- Call CLI: `codesift dead-code <repo>` → use `.candidates` field
- Call CLI: `codesift hotspots <repo>` → use `.hotspots` field — **handle empty array!**
- Call CLI: `codesift communities <repo> --format mermaid` → get Mermaid string
- Health score computed from these results

- [ ] **Step 4: Handle empty states**

Hotspots may be empty (no git history). Dead code may be empty (small repo). Show "No data available" cards, not errors.

- [ ] **Step 5: Commit**

---

## Task 7: Admin Page (6h)

**Files:**
- Modify: `src/pages/admin.astro`

- [ ] **Step 1: Build Admin page**

**Available data only:**
- Repo Index Status table: repo name, files, symbols, last indexed (from registry.json), has embeddings (check .ndjson exists)
- Status: "fresh" (<24h), "stale" (>24h), "old" (>7d) — computed from `updated_at`

**NOT available (show skeleton/coming soon):**
- Uptime: "Coming in v2"
- Error log: "Coming in v2"
- LSP status: "Coming in v2"
- API keys: "Coming in v2"

- [ ] **Step 2: Commit**

---

## Task 8: Badge API + Public Metrics (4h)

**Files:**
- Create: `src/pages/api/badge/[...repo].ts`, `src/pages/api/metrics.ts`

- [ ] **Step 1: Create badge endpoint**

`/api/badge/local/codesift-mcp` → shields.io JSON:
```json
{ "schemaVersion": 1, "label": "CodeSift", "message": "B — 3,016 symbols", "color": "blue" }
```

Reads from registry.json + computes health score.

**Note:** For SSG output, this needs `output: 'server'` or `output: 'hybrid'` in Astro config. Adjust accordingly.

- [ ] **Step 2: Create public metrics endpoint**

`/api/metrics` → JSON with aggregate stats from registry + usage.

- [ ] **Step 3: Commit**

---

## Task 9: Polish + Responsive (6h)

- [ ] **Step 1: Loading states** — skeleton cards while data loads
- [ ] **Step 2: Empty states** — "No data yet" for fresh installs
- [ ] **Step 3: Responsive** — sidebar collapses on mobile, cards reflow
- [ ] **Step 4: Animations** — number tweens on metric cards, chart transitions
- [ ] **Step 5: Commit**

---

## Task 10: Deploy Config (4h)

- [ ] **Step 1: Vercel config** — `vercel.json` or auto-detect Astro
- [ ] **Step 2: Environment** — `CODESIFT_DIR` env var for custom paths
- [ ] **Step 3: README** — for dashboard project with setup instructions
- [ ] **Step 4: Screenshot** — capture for main CodeSift README
- [ ] **Step 5: Final commit + push**

---

## What We're NOT Building (to avoid scope creep)

- ❌ User authentication / login
- ❌ Multi-tenant (one dashboard = one machine's data)
- ❌ Real-time WebSocket (polling is fine)
- ❌ Custom dashboard builder (fixed layout)
- ❌ Email notifications
- ❌ Billing integration
- ❌ Historical health score storage (always computed fresh)
- ❌ Interactive dependency explorer (D3 force graph) — use Mermaid instead
