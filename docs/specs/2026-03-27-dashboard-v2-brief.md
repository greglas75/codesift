# Dashboard v2 — Design Brief

> Collected from user feedback session 2026-03-27. Use this as the starting point for the next design session.

## Core Problem

Dashboard v1.1 shows raw data (cards, tables, empty charts) but has NO storytelling, NO value proposition, NO reason to come back. It's a generic admin panel. User says: "nie widze efektu wow".

## User's Vision for Overview Page

### Section 1: Portfolio Summary
- **Health score as AVERAGE across ALL projects** — "Health: 54% (average of 53 projects)"
- Breakdown into components (complexity, dead code, patterns, clones, circular deps)
- NOT per-repo on main page — per-repo is drill-down
- Filter by service: "Service A: 1,600 files (56,000 LOC), 400 test files (23,000 tests)"
- Health reports generated via CRON (daily), uploaded to dashboard — NOT computed on page load

### Section 2: Benchmark Results
- **CodeSift tools vs standard bash/grep** — performance comparison table
- Show estimated token count per standard query type
- Show savings: "search_text: 48,930 tok vs grep 72,993 tok = -33% savings"
- This is the USP selling point — "why CodeSift is better than grep"
- Data source: existing benchmark data in docs/benchmarks/

### Section 3: Tool Distribution
- 39 tools — how many are ACTUALLY used?
- Usage distribution from usage.jsonl
- "25 of 39 tools used. Most popular: search_text (35%), codebase_retrieval (14%)"
- Average usage per repo across all repos

### Section 4: Calls & Activity
- Calls/day chart (FIX: currently empty in light mode!)
- Recent activity table (already works)

## Key Feedback Points

1. **Charts don't render in light mode** — P0 bug, client:visible React islands not hydrating
2. **KPI cards are uneven height** — HealthBadge taller than MetricCards
3. **Treemap colors were too pale** — fixed to #059669/#d97706/#dc2626 but need verification
4. **Anti-pattern radar needs descriptions** — added but needs better UX
5. **No refresh button** — added but needs better placement
6. **Admin and Portfolio are almost identical** — merge or differentiate
7. **"B 72" is hardcoded** — must compute real health score from data
8. **Dashboard focuses only on code quality** — ignores CodeSift's CORE features (search, navigation, understanding)

## Competitor Research Insights (from agent report)

### Every competitor does:
1. Single verdict first (A-F grade), details second
2. Every number is clickable (drill-down)
3. Deltas shown ("what changed since yesterday")
4. Normalized metrics for cross-repo comparison (per 1K LOC)
5. "Fix Next" panel with actionable items

### CodeSift's unique differentiators:
1. 8-pattern anti-pattern radar (nobody else has this exact visualization)
2. Route/call-chain tracing (request flow visualization)
3. Cross-repo semantic search
4. Benchmark data showing token savings vs grep

## Technical Notes

- Dashboard at /Users/greglas/DEV/codesift-dashboard/
- Astro + React islands, SSR mode
- Cache layer in ~/.codesift/dashboard-cache/
- POST /api/refresh-cache regenerates cache
- Health page loads in <500ms from cache
- 6 CLI commands available: complexity, dead-code, hotspots, communities, patterns, find-clones
- usage.jsonl has 1,284+ entries across 53 repos

## What to Build Next

1. Fix light mode chart rendering (P0 bug)
2. Redesign Overview page per user's vision above
3. Implement real health scoring (weighted average across repos)
4. Add benchmark comparison section
5. Add tool distribution analytics
6. Make numbers clickable (drill-down to per-repo pages)
7. Daily cron for health report generation
