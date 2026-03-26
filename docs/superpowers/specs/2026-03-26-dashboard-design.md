# CodeSift Dashboard — Design Spec

**Date:** 2026-03-26
**Scope:** Full dashboard app (Astro + React islands) with 4 tabs + landing page integration + badge API
**Estimated effort:** ~60h

---

## Goal

Build a web dashboard for CodeSift that serves 6 personas: developer (personal usage), team lead (adoption), PM/director (trends), CTO (ROI), marketer (social proof), admin (operations). Deployed as standalone Astro app reading from CodeSift MCP data.

## Decisions

- **Framework:** Astro + React islands (static shell, JS only in charts)
- **Charts:** Recharts (45KB, React-native, SVG, dark mode)
- **Diagrams:** Mermaid.js (client-side, reuses CodeSift Mermaid output)
- **Styling:** Tailwind CSS, dark mode default, Vercel-style monochrome + blue accent
- **Layout:** Fixed left sidebar + 12-col grid content area
- **Data source:** CodeSift `usage.jsonl` + MCP tool calls (usage_stats, analyze_complexity, find_dead_code, detect_communities, analyze_hotspots)
- **Real-time:** Polling every 15-30s with tween animations
- **Hosting:** Static export → deploy anywhere (Vercel, Netlify, GitHub Pages)

## Color Palette

```css
:root {
  --bg-base: #0a0a0a;
  --bg-surface: #141414;
  --bg-elevated: #1a1a1a;
  --bg-hover: #222222;
  --border-default: #2a2a2a;
  --border-hover: #3a3a3a;
  --text-primary: #ededed;
  --text-secondary: #a1a1a1;
  --text-tertiary: #666666;
  --accent-primary: #0070f3;
  --accent-hover: #1a8cff;
  --success: #00c853;
  --warning: #ff9800;
  --error: #ef4444;
  --info: #3b82f6;
  --chart-1: #0070f3;
  --chart-2: #7c3aed;
  --chart-3: #00c853;
  --chart-4: #ff9800;
  --chart-5: #ef4444;
  --chart-6: #06b6d4;
  --chart-7: #ec4899;
  --chart-8: #eab308;
}
```

## Architecture

```
codesift-dashboard/          ← Separate package (not inside codesift-mcp)
├── src/
│   ├── layouts/
│   │   └── DashboardLayout.astro    ← Sidebar + header (0 JS)
│   ├── pages/
│   │   ├── index.astro              ← Tab 1: Overview
│   │   ├── analytics.astro          ← Tab 2: Analytics
│   │   ├── health.astro             ← Tab 3: Code Health
│   │   ├── admin.astro              ← Tab 4: Admin
│   │   └── api/
│   │       └── badge/[repo].ts      ← Dynamic badge endpoint
│   ├── components/
│   │   ├── MetricCard.astro         ← KPI tile (static, 0 JS)
│   │   ├── HealthScore.astro        ← A-F grade badge
│   │   ├── AreaChart.tsx            ← React island (client:visible)
│   │   ├── DonutChart.tsx           ← React island
│   │   ├── BarChart.tsx             ← React island
│   │   ├── Treemap.tsx              ← React island (D3 treemap)
│   │   ├── MermaidDiagram.astro     ← Client-side Mermaid render
│   │   ├── DataTable.tsx            ← React island (sortable)
│   │   └── Sidebar.astro            ← Navigation
│   └── lib/
│       ├── data.ts                  ← Read usage.jsonl + call MCP
│       ├── metrics.ts               ← Compute KPIs from raw data
│       └── health-score.ts          ← A-F scoring algorithm
├── public/
│   └── favicon.svg
├── astro.config.mjs
├── tailwind.config.mjs
├── tsconfig.json
└── package.json
```

---

## Tab 1: Overview (Hero — for all personas)

### Layout

```
┌──────┬──────────────────────────────────────────────┐
│      │  [Health: A] [Repos: 44] [Symbols: 214K]    │
│  S   │  [Searches: 2.1K] [Saved: $47.20]           │
│  I   │                                               │
│  D   │  [═══ Active Users / Week (line chart) ═════] │
│  E   │                                               │
│  B   │  [Tool Usage (donut) ½]  [Top Repos (bar) ½] │
│  A   │                                               │
│  R   │  [═══ Recent Activity (table) ══════════════] │
│      │                                               │
└──────┴──────────────────────────────────────────────┘
```

### Components

**Hero: Code Health Score (A-F)**
Like SonarQube quality gate. Computed from:
- Avg complexity score (from analyze_complexity)
- Dead code ratio (from find_dead_code)
- Hotspot count (from analyze_hotspots)
- Test coverage proxy (test files / total files)

Grading:
```
A: score >= 85 (green)
B: score >= 70 (blue)
C: score >= 55 (yellow)
D: score >= 40 (orange)
F: score < 40 (red)
```

**5 KPI Cards:**

```
┌─────────────────────┐
│  Repos Indexed       │
│  44                  │
│  ▲ 3 this week      │
│  ░░░░░░░░           │ ← sparkline
└─────────────────────┘
```

1. **Repos Indexed** — count + new this week
2. **Symbols Tracked** — count (214K) + trend
3. **Searches Today** — count + sparkline (7d)
4. **Avg Response Time** — ms + trend arrow
5. **Tokens Saved** — $X.XX + cumulative

**Active Users / Week** — line chart (Recharts AreaChart)
- X: weeks, Y: unique session_ids
- Gradient fill under line

**Tool Usage** — donut chart
- Top 8 tools by call count
- Center: total calls

**Top Repos** — horizontal bar chart
- Top 5 repos by call count
- Color: accent palette

**Recent Activity** — table (last 20 calls)
- Columns: time, tool, repo, tokens, duration
- Auto-refresh every 15s

---

## Tab 2: Analytics (Dev + Team Lead)

### Layout

```
┌──────┬──────────────────────────────────────────────┐
│      │  [Period: 7d ▼] [Repo: All ▼] [Tool: All ▼] │
│  S   │                                               │
│  I   │  [═══ Calls Over Time (stacked area) ═══════] │
│  D   │                                               │
│  E   │  [Per-Tool Breakdown ½] [Response Time ½]     │
│  B   │                                               │
│  A   │  [═══ Top Queries (table) ══════════════════] │
│  R   │                                               │
│      │  [Token Budget ½]  [Savings Cumulative ½]     │
└──────┴──────────────────────────────────────────────┘
```

### Components

**Filters bar** — time range (7d/30d/90d/custom), repo dropdown, tool dropdown. Cascade to all charts.

**Calls Over Time** — stacked area chart
- X: days, Y: call count
- Stacked by tool (top 5 + "other")

**Per-Tool Breakdown** — horizontal bar chart
- All tools, sorted by count
- Avg tokens per call as secondary metric

**Response Time** — line chart with p50/p95 bands
- X: days, Y: ms
- Two lines: p50 (solid), p95 (dashed)

**Top Queries** — sortable table
- Columns: query, tool, count, avg tokens, avg ms
- Sort by any column, search filter

**Token Budget Usage** — bar chart
- Per-codebase_retrieval call: budget vs actual

**Savings Cumulative** — area chart
- X: days, Y: $ saved (cumulative)
- Big number in corner: "$47.20 total"

---

## Tab 3: Code Health (PM + CTO)

### Layout

```
┌──────┬──────────────────────────────────────────────┐
│      │  [Repo: tgm-survey-platform ▼]               │
│  S   │                                               │
│  I   │  [Health: B] [Complex: 12] [Dead: 34]        │
│  D   │  [Hotspots: 8] [Communities: 14]              │
│  E   │                                               │
│  B   │  [═══ Treemap: File Complexity ══════════════]│
│  A   │                                               │
│  R   │  [Community Map (Mermaid) ½] [Hotspots ½]     │
│      │                                               │
│      │  [═══ Health Trend (line chart) ═════════════] │
└──────┴──────────────────────────────────────────────┘
```

### Components

**Repo selector** — dropdown, one repo at a time

**Health Card Row:**
- Health score badge (A-F, large)
- Complex functions count (>10 cyclomatic)
- Dead code candidates count
- Hotspot files count
- Communities count

**Treemap** — D3 treemap (React island)
- Rectangle size = file lines
- Color = complexity score (green → red gradient)
- Click to drill into directory
- Tooltip: file path, complexity, lines, symbols

**Community Map** — Mermaid graph LR
- From `detect_communities(repo, output_format="mermaid")`
- Rendered with Mermaid.js, dark theme
- Pan/zoom via panzoom library

**Hotspots** — bar chart
- Top 10 files by hotspot_score (churn × complexity)
- Color: orange/red gradient
- Tooltip: file, changes, complexity, score

**Health Trend** — line chart
- X: weeks, Y: health score
- Goal line at score = 70 (B threshold)

---

## Tab 4: Admin

### Layout

```
┌──────┬──────────────────────────────────────────────┐
│      │  [System Status: ● Online]                    │
│  S   │                                               │
│  I   │  [Uptime] [Errors/24h] [Avg Latency] [Cache] │
│  D   │                                               │
│  E   │  [═══ Repo Index Status (table) ════════════] │
│  B   │                                               │
│  A   │  [═══ Error Log (table) ════════════════════] │
│  R   │                                               │
│      │  [═══ LSP Server Status (table) ════════════] │
└──────┴──────────────────────────────────────────────┘
```

### Components

**System Status** — green dot + "Online" / red + "Error"

**4 KPI Cards:**
1. Uptime — "99.9%" or hours since last error
2. Errors/24h — count + severity breakdown
3. Avg Latency — ms (p50)
4. Cache Hit Rate — % of dedup cache hits

**Repo Index Status** — table
- Columns: repo name, files, symbols, last indexed, status (fresh/stale/error), embedding status
- Status badge: green = fresh (<24h), yellow = stale (>24h), red = error
- Action: "Reindex" button

**Error Log** — table (last 50)
- Columns: time, tool, repo, error message, duration
- Filter by severity
- Expandable row for full stack trace

**LSP Server Status** — table
- Columns: language, server binary, status (running/stopped/not installed), sessions, last used
- Status: green = running, gray = stopped, red = not installed

---

## Badge API

### Endpoint: `/api/badge/[repo].ts`

Returns shields.io-compatible JSON:

```typescript
// GET /api/badge/local/codesift-mcp
{
  "schemaVersion": 1,
  "label": "CodeSift",
  "message": "A — 3,016 symbols",
  "color": "brightgreen"
}
```

Usage in README:
```markdown
![CodeSift](https://codesift-dashboard.vercel.app/api/badge/local/codesift-mcp)
```

Color mapping:
- A → brightgreen
- B → blue
- C → yellow
- D → orange
- F → red

---

## Data Layer

### lib/data.ts

Reads from two sources:

1. **usage.jsonl** — direct file read (polling every 15s)
```typescript
async function getUsageData(since?: Date): Promise<UsageEntry[]> {
  const raw = await readFile(USAGE_JSONL_PATH, "utf-8");
  return raw.split("\n").filter(Boolean).map(JSON.parse).filter(entry => ...);
}
```

2. **CodeSift MCP tools** — via CLI for health data
```typescript
async function getRepoHealth(repo: string) {
  const complexity = await execAsync(`codesift complexity ${repo} --compact`);
  const deadCode = await execAsync(`codesift dead-code ${repo} --compact`);
  const hotspots = await execAsync(`codesift hotspots ${repo} --compact`);
  const communities = await execAsync(`codesift communities ${repo} --compact`);
  return computeHealthScore(complexity, deadCode, hotspots, communities);
}
```

### lib/health-score.ts

```typescript
function computeHealthScore(data: RepoHealthData): { score: number; grade: string } {
  // Weighted scoring:
  // 40% — complexity (% functions with cyclomatic < 10)
  // 25% — dead code (% exports that are alive)
  // 20% — hotspots (inverse of hotspot density)
  // 15% — structure (community cohesion avg)

  const complexityScore = ...;  // 0-100
  const deadCodeScore = ...;
  const hotspotScore = ...;
  const structureScore = ...;

  const total = complexityScore * 0.4 + deadCodeScore * 0.25
              + hotspotScore * 0.2 + structureScore * 0.15;

  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C"
              : total >= 40 ? "D" : "F";

  return { score: Math.round(total), grade };
}
```

---

## Landing Page Integration

Dashboard provides data for landing page social proof:

### Public Metrics Endpoint: `/api/metrics`

```json
{
  "repos_indexed": 44,
  "symbols_tracked": 214000,
  "searches_served": 12847,
  "tokens_saved": 1847000,
  "tools_count": 39,
  "languages": 12,
  "uptime_percent": 99.9
}
```

Landing page fetches this and shows auto-updating counters.

### Badge Endpoint: `/api/badge/[repo]`

For README badges (see Badge API above).

---

## Implementation Phases

| Phase | Features | Effort |
|-------|----------|--------|
| **1: Foundation** | Astro project, Tailwind, sidebar layout, dark theme | 4h |
| **2: Overview tab** | 5 KPI cards, health score, tool donut, active users chart | 8h |
| **3: Analytics tab** | Filters, calls over time, per-tool breakdown, response time, top queries | 10h |
| **4: Code Health tab** | Treemap (D3), Mermaid community map, hotspots chart, health trend | 12h |
| **5: Admin tab** | Repo status table, error log, LSP status | 6h |
| **6: Data layer** | usage.jsonl reader, health score algorithm, polling/refresh | 6h |
| **7: Badge API** | shields.io endpoint, health grade computation | 2h |
| **8: Public metrics** | /api/metrics endpoint for landing page | 2h |
| **9: Polish** | Animations, responsive, loading states, empty states | 6h |
| **10: Deploy** | Vercel/Netlify config, env vars, domain | 4h |

**Total: ~60h**

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Page load time | < 1.5s (Astro static shell) |
| Chart render time | < 500ms (Recharts + Mermaid) |
| Data freshness | < 30s (polling interval) |
| Dashboard bundle size | < 200KB JS (islands only) |
| Badge response time | < 100ms |
| Mobile responsive | Works on 375px+ |
| Accessibility | WCAG AA contrast ratios |

---

## Tech Dependencies

```json
{
  "dependencies": {
    "astro": "^5.0.0",
    "@astrojs/react": "^4.0.0",
    "@astrojs/tailwind": "^6.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "recharts": "^2.15.0",
    "d3-hierarchy": "^3.1.0",
    "d3-scale": "^4.0.0",
    "mermaid": "^11.0.0",
    "panzoom": "^9.0.0"
  }
}
```

Zero backend deps — data comes from static files (usage.jsonl) and CLI calls.
