# Dashboard Cache Layer — Design Specification

> **Date:** 2026-03-27
> **Status:** Approved
> **Author:** zuvo:brainstorm (inline)

## Problem Statement

The Health and Portfolio pages make 10-18 CLI calls per render via `execSync`. On large repos (91K symbols), this takes 60+ seconds. Even on small repos, it's 2-5s per page load. Every F5 re-runs all CLI calls. This makes the dashboard unusable as a daily driver.

## Design Decision

**File-based cache with background refresh.**

- CLI results cached in `~/.codesift/dashboard-cache/` as JSON files
- Pages read from cache (instant, <10ms)
- Background process regenerates cache every 1 hour
- Stale cache (>2h) still served with "Last updated: X ago" indicator
- Manual refresh button per repo

## Solution

### Cache Structure

```
~/.codesift/dashboard-cache/
  local--codesift-mcp.json      # per-repo health data
  local--translation-qa.json
  _meta.json                     # last full refresh timestamp
```

Each repo cache file:
```json
{
  "repo": "local/codesift-mcp",
  "generated_at": 1711526400000,
  "complexity": { "functions": [...], "summary": {...} },
  "dead_code": { "candidates": [...] },
  "hotspots": { "hotspots": [...] },
  "patterns": { "counts": {...}, "patterns": [...], "total": 0 },
  "clones": { "clones": [...] },
  "circular_deps": [...],
  "impact": { "risk_scores": [...] },
  "community_mermaid": "graph LR..."
}
```

### Cache Manager (`src/lib/cache.ts`)

```typescript
export function getCachedHealth(repoName: string): CachedHealthData | null
export function refreshRepoCache(repoName: string): void
export function refreshAllCaches(): void
export function getCacheAge(repoName: string): number // ms since generated_at
```

### Page Changes

Health/Portfolio pages call `getCachedHealth()` instead of individual CLI functions. If cache miss → run CLI calls once, write cache, return data.

### Background Refresh

Astro middleware or API route `/api/refresh-cache` that:
1. Iterates all repos from registry
2. Runs CLI calls for each
3. Writes cache files
4. Can be triggered by cron (external) or manual button

### UI Indicator

Small "Last updated: 5m ago" text on Health and Portfolio pages. If cache > 2h: show warning "Data may be stale".

## Acceptance Criteria

1. Health page loads in <500ms (reads from cache)
2. Portfolio page loads in <1s (reads from cache for all repos)
3. Cache files written to `~/.codesift/dashboard-cache/`
4. `/api/refresh-cache` endpoint regenerates all caches
5. "Last updated" indicator shown on cached pages
6. First visit with no cache falls back to CLI calls (writes cache for next time)

## Out of Scope

- Automatic background cron (user runs `curl /api/refresh-cache` themselves or via external cron)
- Partial cache invalidation per-file (full repo refresh only)
- WebSocket live updates
