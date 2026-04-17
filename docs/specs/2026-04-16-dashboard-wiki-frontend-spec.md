# Dashboard Wiki Frontend -- Design Specification

> **spec_id:** 2026-04-16-dashboard-wiki-frontend-1622
> **topic:** Wiki browser + Lens visualization in codesift-dashboard
> **status:** Approved
> **created_at:** 2026-04-16T16:22:00Z
> **reviewed_at:** 2026-04-16T16:45:00Z
> **approved_at:** 2026-04-17T00:00:00Z
> **approval_mode:** interactive
> **adversarial_review:** warnings
> **author:** zuvo:brainstorm

## Problem Statement

The Wiki & Lens backend (codesift-mcp) generates markdown wiki pages and manifests per-repo, but there is no way to browse them visually. Developers must open `.codesift/wiki/*.md` files manually. The existing dashboard has 5 pages (overview, analytics, health, portfolio, admin) but no wiki integration — no way to browse architecture documentation, view community structure visually, or navigate between repos' wiki content.

**Who is affected:** Developers using the CodeSift dashboard for multi-repo visibility. Team leads who need architectural overview across projects.

**What happens if we do nothing:** Wiki pages sit as unused markdown files on disk. The D3 Lens HTML (self-contained file) works but is disconnected from the dashboard. No cross-linking from health/portfolio → wiki. The brainstorm's original vision (dashboard + wiki integrated) remains unfulfilled.

**Dependency:** Requires codesift-mcp Wiki & Lens feature (spec 2026-04-15-wiki-lens-1553) to be implemented — wiki pages must exist in `.codesift/wiki/` per repo. That spec is Approved and partially executed.

## Design Decisions

### DD1: Client-side markdown rendering via React island
Wiki page content rendered by `react-markdown` + `@portaljs/remark-wiki-link` + `remark-gfm` in a React island (`client:visible`). Not server-side pre-rendering. Syntax highlighting (rehype-pretty-code) deferred to v2 — basic `<code>` styling sufficient for v1.

**Why:** Dashboard already uses React islands for all interactive content (charts, tables). Markdown rendering needs interactivity (wikilink navigation, search). `@portaljs/remark-wiki-link` is the actively maintained fork compatible with remark v15 / react-markdown v10 (the original `remark-wiki-link` uses micromark v2/v3 which is incompatible with the current unified pipeline). ~40KB JS is acceptable for a dashboard.

### DD2: Raw D3 for Lens visualization (no Nivo/react-force-graph)
Chord diagram via D3 Pattern B (D3 math, React DOM). Force graph via D3 Pattern A (useRef + useEffect, D3 owns SVG). ~110 LOC total.

**Why:** Dashboard already uses d3-hierarchy/d3-scale directly (Treemap.tsx). Raw D3 = 30KB deps vs 200KB for @nivo/chord + react-force-graph. Full control over CSS vars integration. Consistent with existing D3 pattern in codebase.

### DD3: Flat page list with search (no sidebar tree)
Wiki pages displayed as a searchable flat list at the top, content below. No second sidebar or tree navigation panel.

**Why:** Dashboard has no side panels on any existing page. Adding a wiki tree panel would break visual consistency. Wiki repos have 5-15 pages — flat list with MiniSearch is sufficient. Lens needs full width.

### DD4: Direct filesystem reads with WikiDataSource abstraction
`src/lib/wiki-data.ts` reads `{repo.root}/.codesift/wiki/` via `readFileSync`. Behind a `WikiDataSource` interface so it can be swapped for an API client when dashboard goes hosted.

**Why:** Dashboard is local (localhost). Repos on same disk. Direct reads are simplest, always fresh. Abstraction costs ~10 LOC and enables future hosted deployment without frontend rework.

### DD5: URL scheme with split namespace/repo segments
`/wiki/{namespace}/{repo}/{slug}` where namespace and repo are separate Astro route segments. Example: registry name `local/codesift-mcp` → URL `/wiki/local/codesift-mcp/{slug}`.

**Why:** Slash-to-dash encoding (`local/codesift-mcp` → `local-codesift-mcp`) is irreversible when repo or namespace names contain dashes (e.g., `my-org/my-repo` → `my-org-my-repo` — can't reverse). Split segments are unambiguous. Registry names always follow `namespace/repo` format (confirmed from registry data). Route files: `src/pages/wiki/[namespace]/[repo]/index.astro` and `src/pages/wiki/[namespace]/[repo]/[...slug].astro`. Reconstruction: `${namespace}/${repo}` = registry name.

### DD6: MiniSearch for client-side wiki search
Pre-build a lightweight search index from manifest page titles + excerpts. Load in React island, filter client-side. MiniSearch (~14KB, BM25 ranking).

**Why:** Wiki has 5-50 pages per repo — too few for server-side search, perfect for client-side. MiniSearch uses BM25 (same algorithm family as CodeSift). Pre-built index avoids runtime indexing cost. No server round-trip.

## Solution Overview

```
/wiki (index)                    /wiki/[repo] (repo wiki)           /wiki/[repo]/[...slug] (page)
┌─────────────────┐              ┌─────────────────────────┐        ┌─────────────────────────┐
│ DashboardLayout  │              │ DashboardLayout          │        │ DashboardLayout          │
│ ┌─────────────┐ │              │ ┌─────────────────────┐ │        │ ┌─────────────────────┐ │
│ │ Repo Grid   │ │              │ │ Lens (D3 chord+force)│ │        │ │ Breadcrumb nav       │ │
│ │ [repo cards │ │   click →    │ │ client:visible       │ │        │ │ repo > page title    │ │
│ │  with wiki  │ │              │ ├─────────────────────┤ │        │ ├─────────────────────┤ │
│ │  status]    │ │              │ │ Search + Page List   │ │  →     │ │ WikiContent          │ │
│ │             │ │              │ │ WikiPageList.tsx      │ │ click  │ │ react-markdown       │ │
│ └─────────────┘ │              │ │ client:visible       │ │        │ │ + remark-wiki-link   │ │
└─────────────────┘              │ └─────────────────────┘ │        │ │ client:visible       │ │
                                 └─────────────────────────┘        │ ├─────────────────────┤ │
                                                                    │ │ Backlinks section    │ │
                                                                    │ └─────────────────────┘ │
                                                                    └─────────────────────────┘
```

Data flow:
1. Astro page frontmatter calls `wiki-data.ts` → reads registry → probes each repo's manifest
2. Data passed as serialized props to React islands
3. React islands render markdown, D3 charts, search — all client-side
4. Cross-links from portfolio/health use `hasWiki` flag to conditionally render `<a>` tags

## Detailed Design

### Data Model

No new persistent storage. Read-only consumption of existing data:

| Source | Location | What we read |
|--------|----------|-------------|
| Registry | `~/.codesift/registry.json` | Repo list (name, root, file_count, symbol_count) |
| Wiki manifest | `{repo.root}/.codesift/wiki/wiki-manifest.json` | WikiManifest (pages, file_to_community, degraded, generated_at) |
| Wiki pages | `{repo.root}/.codesift/wiki/*.md` | Markdown content |
| Wiki summaries | `{repo.root}/.codesift/wiki/*.summary.md` | Compact summaries |

New TypeScript types in dashboard (consumed from manifest JSON):

```typescript
// src/lib/wiki-data.ts

interface WikiDataSource {
  getWikiRepos(): WikiRepoInfo[];
  getWikiManifest(repoName: string): WikiManifest | null;
  getWikiPageContent(repoName: string, slug: string): string | null;
  getWikiSearchIndex(repoName: string): WikiSearchEntry[];
}

interface WikiRepoInfo {
  name: string;
  root: string;
  hasWiki: boolean;
  pageCount: number;
  lastGenerated: string;
  degraded: boolean;
  communities: number;
}

interface WikiSearchEntry {
  slug: string;
  title: string;
  excerpt: string;  // first 200 chars
}

// WikiManifest type mirrors codesift-mcp's definition
interface WikiManifest {
  generated_at: string;
  index_hash: string;
  git_commit: string;
  pages: Array<{
    slug: string;
    title: string;
    type: string;
    file: string;
    outbound_links: string[];
  }>;
  slug_redirects: Record<string, string>;
  token_estimates: Record<string, number>;
  file_to_community: Record<string, string>;
  degraded: boolean;
  degraded_reasons?: string[];
}
```

### API Surface

No API routes needed for v1 (local filesystem reads in Astro frontmatter). The `WikiDataSource` interface is the internal API.

URL routes (Astro file-based routing):

| Route | File | Data loaded |
|-------|------|-------------|
| `/wiki` | `src/pages/wiki/index.astro` | `getWikiRepos()` → repo grid |
| `/wiki/{ns}/{repo}` | `src/pages/wiki/[namespace]/[repo]/index.astro` | `getWikiManifest(ns/repo)` → page list + Lens data |
| `/wiki/{ns}/{repo}/{slug}` | `src/pages/wiki/[namespace]/[repo]/[...slug].astro` | `getWikiPageContent(ns/repo, slug)` → markdown |

All routes: `export const prerender = false` (SSR, consistent with existing pages). The `namespace` and `repo` params reconstruct the registry name as `${namespace}/${repo}`.

### Integration Points

| Integration | File | Change |
|-------------|------|--------|
| Sidebar nav | `src/components/Sidebar.astro` | Add Wiki item to `navItems[]`, use `startsWith('/wiki')` for active state |
| Portfolio cross-link | `src/pages/portfolio.astro` | Add "Wiki" column/badge to repo rows using `PortfolioTable.astro` (not DataTable — DataTable doesn't accept JSX cells). Repos with `hasWiki: true` get a clickable link to `/wiki/{namespace}/{repo}`. |
| Health cross-link | `src/components/health/CommunitySection.astro` | Add `wikiPages` prop (community page slugs from manifest). Render wiki links alongside the existing Mermaid diagram — a small "Community Pages" list below the Mermaid, linking each community to its wiki page. Does NOT modify the Mermaid DSL. |
| Registry data | `src/lib/registry-data.ts` | Read-only consumption via existing `getRepos()` |
| Layout | `src/layouts/DashboardLayout.astro` | No changes — new pages use it as-is |
| Styles | `src/styles/global.css` | Add `.wiki-content` styles for markdown rendering (headings, tables, code blocks, broken-link spans) |

### Interaction Contract

Not applicable — no cross-cutting behavior contract changes. New pages are additive. Existing pages get optional cross-links that only render when wiki data exists.

### Edge Cases

| Edge Case | Handling |
|-----------|----------|
| **No repos have wiki** | `/wiki` shows EmptyState with hint: "Run `codesift wiki-generate /path/to/repo`" |
| **Mixed state** (some repos have wiki) | All repos in grid; wiki-enabled get page count + date; others get muted "No wiki" badge |
| **Stale wiki** (manifest.degraded=true) | Inline warning banner (var(--warning)), content renders normally |
| **0 communities** | Lens section shows "No community structure detected" text, no SVG |
| **1 community** | Force graph shows single node, chord diagram hidden |
| **Repo name with slashes** | URL encode: `local/repo` → `local-repo`. Reverse on read. |
| **Large wiki page** (>50KB md) | readFileSync is fast locally; react-markdown handles large strings |
| **Broken `[[wikilink]]`** | remark-wiki-link `permalinks` config → styled span with `class="wiki-broken-link"`, red underline |
| **Cross-repo wikilinks** | v1: not supported. Renders as broken link. |
| **Concurrent wiki-generate** | try/catch on manifest read; parse error → degraded state, not crash |
| **Mobile (<640px)** | Grid 1-col, Lens min-width 280px + ResizeObserver, chord hidden below sm |
| **Wiki page not found** (slug not in manifest) | 404-style inline message: "Page not found", not server crash |
| **manifest.json missing but wiki dir exists** | Treated as `hasWiki: false` |

### Failure Modes

#### wiki-data.ts (filesystem reads)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| registry.json missing or unreadable | readFileSync throws | All wiki pages | Empty repo list | EmptyState with hint | No wiki data shown | Immediate |
| manifest.json missing for a repo | existsSync returns false | Single repo | `hasWiki: false`, muted card | Graceful — other repos unaffected | Consistent | Immediate |
| manifest.json malformed JSON | JSON.parse throws in try/catch | Single repo | `hasWiki: false`, degraded badge | Graceful — other repos unaffected | Consistent | Immediate |
| .md file listed in manifest but missing on disk | readFileSync throws in try/catch | Single page | "Content not found" inline message | Other pages unaffected | Consistent | Immediate |

**Cost-benefit:** Frequency: occasional (~5% for missing/stale files) × Severity: low (graceful degradation) → Mitigation cost: trivial (try/catch already planned) → **Decision: Mitigate**

#### React islands (client-side rendering)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| react-markdown crashes on malformed input | React ErrorBoundary catches | Single page content | "Failed to render wiki content" fallback | Reload page; if persistent, re-generate wiki | No data loss | Immediate |
| D3 chord/force throws on invalid data | React ErrorBoundary catches | Lens section only | "Visualization unavailable" fallback | Page list still works | No data loss | Immediate |
| MiniSearch init fails (empty/corrupt index) | try/catch in search setup | Search feature only | Search input hidden | Page list still navigable manually | No data loss | Immediate |
| `[[...]]` syntax not caught by remark-wiki-link | Fallback regex preprocessor catches remaining `[[...]]` | Single link in page | Styled as broken-link span (never raw text) | Re-generate wiki to fix | No data loss | Immediate |

**Cost-benefit:** Frequency: rare (~1%) × Severity: low (isolated, recoverable) → Mitigation cost: trivial (ErrorBoundary) → **Decision: Mitigate with ErrorBoundary per island**

#### Cross-links (portfolio/health → wiki)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Wiki link in portfolio points to repo without wiki | hasWiki check before rendering link | None — link not rendered | No link shown, no confusion | Generate wiki for that repo | Consistent | Immediate |
| Community slug in health doesn't match wiki page slug | Manifest lookup returns null | Single link | Link navigates to 404-style inline message | Re-generate wiki | No data loss | Immediate |
| Repo removed from registry but wiki dir still exists | Registry is source of truth | Orphaned wiki dir | Repo not shown in wiki index | Manual cleanup | Stale files on disk | Silent |

**Cost-benefit:** Frequency: rare × Severity: low → **Decision: Accept (optimistic linking with 404 handling)**

## Acceptance Criteria

### Ship criteria (must pass for release):

1. `/wiki` renders without error when 0 repos have wiki; shows EmptyState with actionable hint
2. `/wiki` shows all registry repos; wiki-enabled repos show page count + last-generated date
3. `/wiki/[repo]` shows searchable page list and Lens visualization for a repo with wiki
4. `/wiki/[repo]/[...slug]` renders markdown content with resolved wikilinks for a valid page
5. `/wiki/[repo]/[...slug]` shows styled 404 message (not server crash) for non-existent slug
6. Broken `[[wikilinks]]` render as visually distinct broken-link spans, never raw `[[...]]`
7. Stale/degraded wiki shows inline warning; content still renders
8. Sidebar navigation includes "Wiki" item; active state works on all `/wiki/*` routes
9. Portfolio repo rows with wiki are clickable → navigate to `/wiki/{repo}`
10. Lens chord diagram renders for repos with 2+ communities; empty state for 0-1
11. All new pages use DashboardLayout; dark/light theme works
12. Mobile: grid collapses to 1-col, no horizontal scroll, Lens responsive
13. Search filters page list by title (case-insensitive, client-side)

### Success criteria (must pass for value validation):

1. Developer can navigate from portfolio → repo wiki → specific community page in 3 clicks
2. Wiki pages load in <1s on localhost for pages up to 50KB
3. Lens gives visual understanding of repo structure at a glance (community sizes, cross-connections)
4. Search finds relevant wiki pages with 1-2 keystrokes of the target term

## Validation Methodology

1. **Unit tests** (Vitest): wiki-data.ts — manifest reading, repo discovery, error handling. Mock filesystem with vi.mock.
2. **Component render tests**: WikiContent renders markdown, resolves wikilinks, shows broken-link styling. LensChord/LensForce render SVG with fixture data and empty state.
3. **Manual integration test**: Start `npm run dev` → navigate `/wiki` → see repos → click one with wiki → see Lens + page list → search → click page → see rendered markdown with wikilinks → click wikilink → navigate → test broken link styling.
4. **Cross-link test**: Portfolio → click repo → `/wiki/{repo}`. Health → click community → `/wiki/{repo}/{slug}`.
5. **Edge case manual tests**: No wiki repos, stale wiki, 0 communities, mobile viewport.
6. **Performance**: `time curl localhost:4321/wiki/local-codesift-mcp/src-tools` → <1s.

## Rollback Strategy

- **Kill switch:** Delete new page files (`src/pages/wiki/`). Revert 3 modified files (Sidebar, portfolio, CommunitySection).
- **Fallback:** Dashboard works exactly as before — 5 existing pages unchanged.
- **Data preservation:** Wiki files on disk untouched. No persistent state created by dashboard.
- **Partial rollback:** Remove only cross-links (revert portfolio/CommunitySection) while keeping `/wiki` routes.

## Backward Compatibility

Zero breaking changes. All existing 5 pages unchanged. Sidebar gets +1 item. Portfolio and health get optional links (conditional on hasWiki). No schema changes, no migrations. New npm deps are additive.

## Out of Scope

### Deferred to v2

- **Hosted/online deployment** — current spec is localhost only. WikiDataSource abstraction enables future API backend swap. Rationale: hosted requires auth, storage, API layer — separate spec.
- **Global cross-repo search** — v1 search is per-repo. Global search requires combined manifest index. Rationale: per-repo is sufficient for 5-15 pages.
- **Cross-repo wikilinks** — `[[repo:slug]]` syntax. Rationale: wiki generator doesn't produce cross-repo links.
- **Wiki editing in dashboard** — wiki is read-only (generated by codesift-mcp). Rationale: editing conflicts with auto-generation.
- **Syntax highlighting in code blocks** — rehype-pretty-code deferred. Rationale: adds complexity and bundle size; basic `<code>` styling sufficient for v1.

### Permanently out of scope

- **Real-time wiki updates** (WebSocket push when wiki-generate runs) — complexity not justified for local dashboard.
- **User accounts / permissions** — dashboard is single-user local tool.
- **Wiki versioning / history** — git handles this; dashboard doesn't need its own version layer.

## Open Questions

None — all questions resolved during Phase 2 design dialogue.

## Adversarial Review

**Providers:** gemini, cursor-agent
**Status:** All CRITICALs resolved. Remaining WARNINGs addressed.

### Resolved CRITICALs:
1. **rehype-pretty-code DD1 vs Out of Scope** (gemini + cursor-agent): Removed from DD1. Deferred to v2.
2. **Slash-to-dash URL irreversible** (gemini): Replaced with split `[namespace]/[repo]` route segments. Unambiguous, reversible.
3. **Search excerpts missing from manifest** (gemini): Excerpts extracted at load time from first 200 chars of page content by `wiki-data.ts`. No manifest schema change needed.
4. **AC6 vs Failure Modes raw `[[...]]`** (cursor-agent): Reconciled — fallback regex preprocessor in WikiContent catches any `[[...]]` not handled by remark-wiki-link. Never raw text in output.

### Resolved from spec reviewer:
5. **`d3-arc` doesn't exist** → replaced with `d3-shape` (which exports `arc()`).
6. **`remark-wiki-link` incompatible with react-markdown 10** → replaced with `@portaljs/remark-wiki-link` (maintained fork, remark v15 compatible).
7. **DataTable doesn't accept JSX** → portfolio cross-link moved to `PortfolioTable.astro`.
8. **CommunitySection only has mermaidCode** → added `wikiPages` prop, render links alongside Mermaid (not inside it).

### Accepted WARNINGs:
9. **O(N) filesystem reads on /wiki index** (gemini): Acceptable for local dashboard. N = number of repos (typically 5-20). readFileSync is fast on local disk.
10. **Performance validation uses curl** (cursor-agent): Added note that client-render time is manual verification. curl measures TTFB only.
11. **Sidebar active state logic** (spec-reviewer): Explicitly called out in modified files table — `startsWith('/wiki')` instead of exact match.

---

## Appendix: New Dependencies

| Package | Size (gzip) | Purpose |
|---------|-------------|---------|
| `react-markdown` | ~12KB | Markdown → React elements |
| `@portaljs/remark-wiki-link` | ~3KB | `[[wikilink]]` resolution (maintained fork, remark v15 compatible) |
| `remark-gfm` | ~4KB | GitHub Flavored Markdown (tables, strikethrough) |
| `d3-force` | ~8KB | Force simulation for Lens |
| `d3-chord` | ~3KB | Chord diagram geometry |
| `d3-shape` | ~5KB | Arc path generator (`arc()`) for chord ribbons |
| `minisearch` | ~14KB | Client-side BM25 search |
| **Total** | **~49KB** | |

DevDependencies: `@types/d3-shape`, `@types/d3-force`, `@types/d3-chord`

## Appendix: File Changes

### New files (10)

| File | Purpose | Est. LOC |
|------|---------|----------|
| `src/lib/wiki-data.ts` | WikiDataSource, manifest reader, search index builder | ~150 |
| `src/pages/wiki/index.astro` | Multi-repo wiki index page | ~80 |
| `src/pages/wiki/[namespace]/[repo]/index.astro` | Repo wiki: Lens + page list | ~100 |
| `src/pages/wiki/[namespace]/[repo]/[...slug].astro` | Wiki page content viewer | ~80 |
| `src/components/WikiPageList.tsx` | Searchable page list (MiniSearch) | ~120 |
| `src/components/WikiContent.tsx` | Markdown renderer (react-markdown + @portaljs/remark-wiki-link + fallback regex) | ~120 |
| `src/components/LensChord.tsx` | D3 chord diagram (d3-chord + d3-shape arc) | ~80 |
| `src/components/LensForce.tsx` | D3 force-directed graph (d3-force, useRef+useEffect, ResizeObserver) | ~130 |
| `src/components/WikiBreadcrumb.astro` | Breadcrumb navigation for wiki pages | ~30 |
| `src/components/WikiRepoCard.astro` | Repo card for wiki index grid | ~40 |

### Modified files (5)

| File | Change |
|------|--------|
| `src/components/Sidebar.astro` | +1 navItem entry for Wiki, active state uses `startsWith('/wiki')` instead of exact match |
| `src/pages/portfolio.astro` | Pass `wikiRepos` to PortfolioTable |
| `src/components/PortfolioTable.astro` | Add wiki link badge/column for repos with `hasWiki: true` |
| `src/components/health/CommunitySection.astro` | Add `wikiPages` prop, render community→wiki links below Mermaid |
| `package.json` | Add 7 new dependencies + 3 devDependencies |

**Total estimated: ~930 LOC new, ~50 LOC modified.**
