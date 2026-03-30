# Implementation Plan: Dashboard Cache Layer

**Spec:** `docs/specs/2026-03-27-dashboard-cache-spec.md`
**Created:** 2026-03-27
**Tasks:** 5
**Estimated complexity:** 3 standard, 2 complex

## Architecture Summary

New `src/lib/cache.ts` module reads/writes JSON files in `~/.codesift/dashboard-cache/`. All health-related pages read from cache instead of calling CLI directly. API route `/api/refresh-cache` regenerates all caches. First visit without cache falls back to CLI calls.

## Task Breakdown

### Task 1: Cache manager module
**Files:** `src/lib/cache.ts` (new), `tests/lib/cache.test.ts` (new)
**Complexity:** complex
**Dependencies:** none
**Model routing:** Opus

The core module. Reads/writes per-repo JSON cache files.

- [ ] RED: Test getCachedHealth returns null when no cache, returns data when cache exists, refreshRepoCache writes file
- [ ] GREEN: Implement cache.ts with getCachedHealth, refreshRepoCache, refreshAllCaches, getCacheAge
- [ ] Verify: `npx vitest run tests/lib/cache.test.ts`
- [ ] Commit: `feat: add dashboard cache manager — file-based CLI result caching`

### Task 2: Refresh cache API endpoint
**Files:** `src/pages/api/refresh-cache.ts` (new)
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

- [ ] GREEN: POST `/api/refresh-cache` calls refreshAllCaches(), returns JSON with repo count and duration
- [ ] Verify: `curl -X POST http://localhost:4323/api/refresh-cache`
- [ ] Commit: `feat: add /api/refresh-cache endpoint for manual cache regeneration`

### Task 3: Wire Health page to cache
**Files:** `src/pages/health.astro`
**Complexity:** complex
**Dependencies:** Task 1
**Model routing:** Opus

Replace all individual CLI calls with single getCachedHealth() call. Add "Last updated" indicator. Fallback to CLI on cache miss.

- [ ] GREEN: Import getCachedHealth, replace 8+ CLI calls with 1 cache read, add timestamp indicator
- [ ] Verify: `time curl -s -o /dev/null -w "%{http_code}" http://localhost:4323/health` — should be <500ms
- [ ] Commit: `feat: health page reads from cache — instant load instead of 2-60s CLI calls`

### Task 4: Wire Portfolio page to cache
**Files:** `src/pages/portfolio.astro`
**Complexity:** standard
**Dependencies:** Task 1
**Model routing:** Sonnet

Replace per-repo CLI loops with cache reads. Add "Last updated" indicator.

- [ ] GREEN: Import getCachedHealth for each repo, add timestamp
- [ ] Verify: `time curl -s -o /dev/null -w "%{http_code}" http://localhost:4323/portfolio` — should be <1s
- [ ] Commit: `feat: portfolio page reads from cache — all repos load instantly`

### Task 5: Cache freshness UI indicator
**Files:** `src/components/CacheIndicator.astro` (new)
**Complexity:** standard
**Dependencies:** Task 3
**Model routing:** Sonnet

Small component showing "Last updated: 5m ago" or warning if stale.

- [ ] GREEN: Create component with age calculation, green/yellow/red states
- [ ] Verify: Visual check on health page
- [ ] Commit: `feat: add cache freshness indicator — shows when data was last regenerated`

## Execution Order

```
Task 1 (cache manager)     ← independent
Task 2 (refresh API)       ← depends on 1
Task 3 (health page)       ← depends on 1
Task 4 (portfolio page)    ← depends on 1
Task 5 (UI indicator)      ← depends on 3
```

Tasks 2, 3, 4 can run in parallel after Task 1.
