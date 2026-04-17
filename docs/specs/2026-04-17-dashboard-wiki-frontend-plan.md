# Implementation Plan: Dashboard Wiki Frontend

**Spec:** docs/specs/2026-04-16-dashboard-wiki-frontend-spec.md
**spec_id:** 2026-04-16-dashboard-wiki-frontend-1622
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-17
**Tasks:** 10
**Estimated complexity:** 7 standard, 3 complex

**Target repo:** `/Users/greglas/DEV/codesift-dashboard`

## Architecture Summary

Adding wiki browser to existing Astro 5 + React 19 dashboard. 10 new files + 5 modified files.

Data flow: Astro frontmatter → `wiki-data.ts` reads `{repo.root}/.codesift/wiki/manifest.json` + `.md` files → passes data as props to React islands → React renders markdown (react-markdown), D3 charts (d3-chord/force), search (MiniSearch).

Route structure: `/wiki` (index) → `/wiki/[namespace]/[repo]` (repo wiki) → `/wiki/[namespace]/[repo]/[...slug]` (page content).

## Technical Decisions

- **Markdown:** react-markdown + @portaljs/remark-wiki-link + remark-gfm (client:visible React island)
- **D3:** Raw D3 (d3-chord, d3-force, d3-shape) — Pattern A for force, Pattern B for chord
- **Search:** MiniSearch (client-side BM25, ~14KB)
- **Data:** Direct filesystem reads via WikiDataSource abstraction in `src/lib/wiki-data.ts`
- **Routing:** `[namespace]/[repo]` split segments (reversible, unambiguous)
- **Cross-links:** PortfolioTable.astro (wiki badge), CommunitySection.astro (wikiPages prop)

## Quality Strategy

- **Unit tests:** wiki-data.ts (manifest parsing, error handling, filesystem edge cases)
- **Component tests:** Limited — dashboard has minimal test infrastructure for React components
- **Integration:** Manual dev server verification for each page route
- **CQ gates:** CQ8 (error handling on file reads), CQ6 (bounded manifest reads), CQ3 (URL param validation)

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| SC-1 | /wiki renders with 0 wiki repos, shows EmptyState | requirement | Task 2 | |
| SC-2 | /wiki shows all registry repos with wiki status | requirement | Task 2 | |
| SC-3 | /wiki/[ns]/[repo] shows page list + Lens | requirement | Task 7 | |
| SC-4 | /wiki/[ns]/[repo]/[slug] renders markdown with wikilinks | requirement | Task 8 | |
| SC-5 | 404 inline for bad slug | requirement | Task 8 | |
| SC-6 | Broken wikilinks styled, never raw [[...]] | requirement | Task 5 | |
| SC-7 | Stale/degraded wiki shows warning | requirement | Task 7, Task 8 | |
| SC-8 | Sidebar Wiki item, active on all /wiki/* | requirement | Task 9 | |
| SC-9 | Portfolio rows link to wiki | requirement | Task 10 | |
| SC-10 | Lens chord for 2+ communities, empty for 0-1 | requirement | Task 6 | |
| SC-11 | DashboardLayout + dark/light theme | requirement | Task 2, Task 7, Task 8 | |
| SC-12 | Mobile responsive | requirement | Task 6 | |
| SC-13 | Search filters page list | requirement | Task 4 | |
| DD1 | react-markdown + @portaljs/remark-wiki-link | constraint | Task 5 | |
| DD2 | Raw D3 for Lens | constraint | Task 6 | |
| DD4 | WikiDataSource abstraction | constraint | Task 1 | |
| DD5 | [namespace]/[repo] URL split | constraint | Task 7, Task 8 | |
| DD6 | MiniSearch client-side | constraint | Task 4 | |

## Review Trail

- Plan reviewer: revision 1 -> APPROVED (zero issues)
- Cross-model validation: executed -> 4 WARNINGs accepted (manual verification inherent to Astro, local dashboard no observability, Task 10 scope acceptable, no spike needed for marked-complex Task 5)
- Status gate: Approved (auto-approved per user instruction)

## Task Breakdown

### Task 1: Install dependencies + wiki-data.ts
**Files:** `src/lib/wiki-data.ts`, `tests/lib/wiki-data.test.ts`, `package.json`
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier
**Target repo:** /Users/greglas/DEV/codesift-dashboard

- [ ] RED: Write tests in `tests/lib/wiki-data.test.ts`. Mock filesystem. Assert: (1) `getWikiRepos()` returns repos from registry with `hasWiki` flag based on manifest existence, (2) repo without manifest → `hasWiki: false`, (3) `getWikiManifest(name)` returns parsed manifest, (4) malformed manifest JSON → returns null, (5) `getWikiPageContent(name, slug)` returns markdown string, (6) missing .md file → returns null, (7) `getWikiSearchEntries(name)` returns array with slug/title/excerpt, (8) `repoNameToUrlSegments(name)` splits "local/repo" → ["local", "repo"], (9) `urlSegmentsToRepoName(ns, repo)` joins → "local/repo"
- [ ] GREEN: Install deps: `npm install react-markdown @portaljs/remark-wiki-link remark-gfm d3-force d3-chord d3-shape minisearch`. Install devDeps: `npm install -D @types/d3-force @types/d3-chord @types/d3-shape`. Implement `WikiDataSource` interface + `FilesystemWikiDataSource` class in `wiki-data.ts`. Uses `readFileSync` + `existsSync` from `node:fs`. Reads registry via existing `getRepos()` from `registry-data.ts`. Exports helper functions: `repoNameToUrlSegments`, `urlSegmentsToRepoName`.
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npx vitest run tests/lib/wiki-data.test.ts`
  Expected: 9 tests pass, 0 fail
- [ ] Acceptance: DD4, DD5
- [ ] Commit: `feat: add wiki data layer with filesystem reader and URL helpers`

### Task 2: Wiki index page + WikiRepoCard
**Files:** `src/pages/wiki/index.astro`, `src/components/WikiRepoCard.astro`
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default implementation tier

- [ ] RED: No unit test (Astro pages not unit-testable). Manual verification: dev server → navigate `/wiki` → see repo grid or EmptyState.
- [ ] GREEN: Create `WikiRepoCard.astro` — glass card with repo name, page count badge, last-generated date, degraded warning badge. Props: `{ name, hasWiki, pageCount, lastGenerated, degraded, namespace, repo }`. Create `wiki/index.astro` — imports DashboardLayout, calls `getWikiRepos()` in frontmatter, renders grid of WikiRepoCard. Shows EmptyState when no repos have wiki. Responsive grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.
- [ ] Verify: `cd /Users/greglas/DEV/codesift-dashboard && npm run dev` then open `http://localhost:4321/wiki`
  Expected: Page renders with repo cards (or EmptyState), no console errors
- [ ] Acceptance: SC-1, SC-2, SC-11
- [ ] Commit: `feat: add /wiki index page with multi-repo grid`

### Task 3: WikiBreadcrumb component
**Files:** `src/components/WikiBreadcrumb.astro`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: No unit test (pure Astro component). Manual verification.
- [ ] GREEN: Create `WikiBreadcrumb.astro` — accepts `{ namespace, repo, pageTitle? }`. Renders: `Wiki > {namespace}/{repo}` or `Wiki > {namespace}/{repo} > {pageTitle}`. Each segment is a link. Uses `aria-label="breadcrumb"` and `aria-current="page"` on last item.
- [ ] Verify: Component used in Tasks 7 and 8. Visual verification during those tasks.
  Expected: Breadcrumb renders with working links
- [ ] Acceptance: (supports SC-3, SC-4)
- [ ] Commit: `feat: add WikiBreadcrumb navigation component`

### Task 4: WikiPageList (searchable list + MiniSearch)
**Files:** `src/components/WikiPageList.tsx`
**Complexity:** standard
**Dependencies:** Task 1 (WikiSearchEntry type)
**Execution routing:** default implementation tier

- [ ] RED: No unit test (React island, dashboard lacks @testing-library setup). Manual verification.
- [ ] GREEN: Create `WikiPageList.tsx` — React component accepting `{ pages: WikiSearchEntry[], namespace, repo }`. On mount: build MiniSearch index from page titles + excerpts. Search input filters list. Each result: title (linked to `/wiki/{ns}/{repo}/{slug}`), excerpt, type badge. Empty state when no results.
- [ ] Verify: Used in Task 7. Visual verification: type in search → list filters.
  Expected: Search works, results link correctly
- [ ] Acceptance: SC-13, DD6
- [ ] Commit: `feat: add WikiPageList with MiniSearch client-side search`

### Task 5: WikiContent (markdown renderer + wikilinks)
**Files:** `src/components/WikiContent.tsx`
**Complexity:** complex
**Dependencies:** Task 1 (deps installed)
**Execution routing:** deep implementation tier

- [ ] RED: No unit test. Manual verification with test wiki page containing [[wikilinks]], code blocks, tables.
- [ ] GREEN: Create `WikiContent.tsx` — React component accepting `{ content, namespace, repo, knownSlugs }`. Uses `react-markdown` with plugins: `remark-gfm` (tables), `@portaljs/remark-wiki-link` (wikilinks with `pageResolver` mapping to `/wiki/{ns}/{repo}/{slug}` and `permalinks` from knownSlugs). Fallback regex post-processor: any remaining `[[...]]` in rendered output wrapped in `<span class="wiki-broken-link">`. ErrorBoundary wrapper for crash safety. CSS classes: `.wiki-content h1/h2/h3/p/code/table/a` styles.
- [ ] Verify: Used in Task 8. Visual verification with wiki page containing mixed content.
  Expected: Markdown renders correctly, wikilinks are clickable, broken links styled with red underline
- [ ] Acceptance: SC-6, DD1
- [ ] Commit: `feat: add WikiContent markdown renderer with wikilink support`

### Task 6: Lens components (LensChord + LensForce)
**Files:** `src/components/LensChord.tsx`, `src/components/LensForce.tsx`
**Complexity:** complex
**Dependencies:** Task 1 (deps installed)
**Execution routing:** deep implementation tier

- [ ] RED: No unit test. Manual verification with fixture community data.
- [ ] GREEN: Create `LensChord.tsx` — D3 Pattern B (d3-chord math, React SVG DOM). Props: `{ communities, crossEdges }`. Uses `d3.chord()` + `d3.arc()` from d3-shape. Theme-reactive via MutationObserver on `data-theme` (matching AreaChart.tsx pattern). Hidden when communities < 2 ("low modularity" notice). Create `LensForce.tsx` — D3 Pattern A (useRef + useEffect). Props: `{ communities, crossEdges }`. Uses `d3.forceSimulation` with forceLink, forceCenter, forceManyBody. Node = community (sized by file count), edge = cross-community connection. Click → navigate to community wiki page. ResizeObserver for responsive sizing. Empty state for 0-1 communities.
- [ ] Verify: Used in Task 7. Visual verification: chord shows arcs, force shows nodes + edges, hover shows tooltips.
  Expected: Both charts render, theme switching works, responsive on resize
- [ ] Acceptance: SC-10, SC-12, DD2
- [ ] Commit: `feat: add Lens chord diagram and force graph D3 components`

### Task 7: Repo wiki page ([namespace]/[repo]/index.astro)
**Files:** `src/pages/wiki/[namespace]/[repo]/index.astro`
**Complexity:** standard
**Dependencies:** Task 1, Task 3, Task 4, Task 6
**Execution routing:** default implementation tier

- [ ] RED: No unit test. Manual verification: dev server → `/wiki/local/codesift-mcp` → see Lens + page list.
- [ ] GREEN: Create `[namespace]/[repo]/index.astro`. Frontmatter: reconstruct repo name from params, call `getWikiManifest()`, `getWikiSearchEntries()`. If no manifest: redirect to `/wiki` or show EmptyState. Render: DashboardLayout with WikiBreadcrumb, degraded warning banner if `manifest.degraded`, LensChord + LensForce (client:visible) with community data from manifest, WikiPageList (client:visible) with search entries. `export const prerender = false`.
- [ ] Verify: `npm run dev` → navigate to `/wiki/local/codesift-mcp`
  Expected: Page shows Lens charts + searchable page list, breadcrumb works
- [ ] Acceptance: SC-3, SC-7, SC-11, DD5
- [ ] Commit: `feat: add repo wiki page with Lens and page list`

### Task 8: Wiki content page ([namespace]/[repo]/[...slug].astro)
**Files:** `src/pages/wiki/[namespace]/[repo]/[...slug].astro`
**Complexity:** standard
**Dependencies:** Task 1, Task 3, Task 5
**Execution routing:** default implementation tier

- [ ] RED: No unit test. Manual verification: dev server → `/wiki/local/codesift-mcp/src-tools` → see rendered markdown.
- [ ] GREEN: Create `[...slug].astro`. Frontmatter: reconstruct repo name, get manifest, get page content by slug. If page not found: render inline 404 message (not server error). Extract backlinks from manifest outbound_links (inverted). Render: DashboardLayout with WikiBreadcrumb (with pageTitle), degraded banner if needed, WikiContent (client:visible) with content + knownSlugs from manifest. Backlinks section below content. `export const prerender = false`.
- [ ] Verify: `npm run dev` → navigate to a wiki page → click wikilink → navigate
  Expected: Content renders, wikilinks work, backlinks shown, 404 for invalid slug
- [ ] Acceptance: SC-4, SC-5, SC-7, DD5
- [ ] Commit: `feat: add wiki content page with markdown rendering and backlinks`

### Task 9: Sidebar + wiki styles
**Files:** modify `src/components/Sidebar.astro`, `src/styles/global.css`
**Complexity:** standard
**Dependencies:** Task 2 (wiki page must exist for active state to work)
**Execution routing:** default implementation tier

- [ ] RED: No unit test. Manual verification: sidebar shows Wiki item, active on all /wiki/* routes.
- [ ] GREEN: Add Wiki entry to `navItems[]` in Sidebar.astro with book icon SVG. Change active state detection: for wiki item use `currentPath.startsWith('/wiki')`, keep exact match for others. Add `.wiki-content` styles to global.css: headings (h1-h4), tables, code blocks, blockquotes, `.wiki-broken-link` (red underline, cursor help), `.wiki-backlinks` section styling. All using CSS vars for theme compatibility.
- [ ] Verify: Navigate to `/wiki`, `/wiki/local/codesift-mcp`, `/wiki/local/codesift-mcp/some-page` — sidebar Wiki item is active on all three.
  Expected: Wiki nav item visible, active state correct, dark/light theme correct
- [ ] Acceptance: SC-8, SC-11
- [ ] Commit: `feat: add Wiki to sidebar navigation and wiki content styles`

### Task 10: Cross-links (portfolio + health → wiki)
**Files:** modify `src/pages/portfolio.astro`, modify `src/components/PortfolioTable.astro`, modify `src/components/health/CommunitySection.astro`
**Complexity:** standard
**Dependencies:** Task 1, Task 7 (wiki pages must exist for links to resolve)
**Execution routing:** default implementation tier

- [ ] RED: No unit test. Manual verification: portfolio → click repo → navigates to wiki. Health → community links visible.
- [ ] GREEN: In `portfolio.astro`: call `getWikiRepos()`, pass `wikiRepos` data to page. In `PortfolioTable.astro`: add "Wiki" column — repos with `hasWiki: true` get `<a href="/wiki/{ns}/{repo}">Wiki</a>` badge; others get "—". In `CommunitySection.astro`: add optional `wikiPages` prop (array of `{slug, title}`). When provided, render a "Community Pages" list below the Mermaid diagram with links to `/wiki/{ns}/{repo}/{slug}`. Health page passes community wiki pages from manifest.
- [ ] Verify: Navigate to `/portfolio` → see Wiki column → click → navigates. Navigate to `/health` → see community wiki links below Mermaid.
  Expected: Cross-links work, repos without wiki show "—", no errors
- [ ] Acceptance: SC-9
- [ ] Commit: `feat: add cross-links from portfolio and health to wiki pages`
