# Wiki v2 — Rich Content + Agent Integration — Design Specification

> **spec_id:** 2026-04-20-wiki-v2-rich-content-0506
> **topic:** Wiki v2 — rich content + agent integration
> **status:** Approved
> **created_at:** 2026-04-20T05:06:25Z
> **reviewed_at:** 2026-04-20T05:15:00Z
> **approved_at:** 2026-04-20T05:25:00Z
> **approval_mode:** interactive
> **adversarial_review:** warnings
> **author:** zuvo:brainstorm

## Problem Statement

The `generate_wiki` feature in codesift-mcp produces wiki content that is too generic to be useful for either AI agents or humans. Five concrete problems were identified:

1. **Hub symbols are broken.** The hubs page surfaces JavaScript `Array`/`Date`/`Promise` prototype methods (`map`, `filter`, `slice`, `forEach`, `now`, `then`) with inflated caller counts (610+). Root cause: `buildAdjacencyIndex()` in `src/tools/graph-tools.ts` matches any `name(` call pattern against `nameToSymbols`. If any project file defines a symbol with a name matching a builtin, all `.map()` / `.filter()` call sites credit it with caller edges. The hubs page is the most prominent architectural signal in the wiki and it is currently useless.

2. **Community pages are identical boilerplate.** Every community page opens with the same generic paragraph ("A community is a group of files that are more tightly connected..."). There is no module-specific description, no exports listing, no inter-module dependency information. A reader — human or agent — cannot distinguish the purpose of one module from another without opening their files.

3. **No project overview page.** The index page lists community links only. `analyzeProject()` is already called during wiki generation and returns rich data (project identity, full stack info with versions, scripts, entry points, dependency graph, test conventions, framework conventions, known gotchas) — but only the `framework` field is extracted. All other data is discarded at `src/tools/wiki-tools.ts:265`. A developer or agent landing on the wiki has no starting point.

4. **Hook summaries injected to agents are too sparse.** The `.summary.md` files (2000-char budget) currently contain 4 lines: community name, cohesion percentage, top 3 files, top hub symbol. The "top hub" is frequently a builtin like `map` with fake call counts, making the summary actively misleading. The hook fires only for code files under 50 lines (larger files get redirected to CodeSift tools) so summary quality matters every time it fires.

5. **Manifest lacks structured metadata.** The wiki manifest contains page metadata but no structured project information or module-level metadata. Programmatic consumers (dashboard, MCP tools, external scripts) must scrape markdown to extract module purpose/exports/dependencies.

**Who is affected:**
- **AI agents** reading wiki content for project orientation (primary consumer — CodeSift's wiki is designed to survive context compaction and provide persistent project knowledge)
- **Developers** exploring new codebases via the codesift-dashboard wiki UI
- **Competitive positioning** — DeepWiki, Google Code Wiki, Mutable.ai all produce richer content; CodeSift's wiki appears shallower by comparison despite having deeper underlying analysis

**What happens if we do nothing:** The wiki feature remains "ubogo" (bare/impoverished, per user feedback on 2026-04-20). Users will continue to re-discover project structure via 5-10 tool calls per session instead of reading the wiki. The wiki is treated as a curiosity, not a load-bearing feature.

## Design Decisions

### D1: Full-stack scope (codesift-mcp + codesift-dashboard)
**Chosen:** Ship generator improvements AND dashboard improvements in one spec.
**Rationale:** The dashboard is content-agnostic at the rendering layer (`WikiContent.tsx` uses `react-markdown`), but the page list and excerpts require manifest structure awareness. Shipping in one spec ensures the dashboard takes advantage of the new structured manifest immediately. Alternative considered: generator-only (dashboard auto-benefits from richer markdown) — rejected because dashboard excerpts currently scrape markdown rather than read manifest metadata, so dashboard needs explicit work to benefit fully.

### D2: Add `is_exported` flag to TypeScript extractor
**Chosen:** Add `is_exported: boolean` field to `CodeSymbol`, set during extraction. A symbol is flagged `is_exported: true` when ANY of the following conditions hold:
1. Its AST node has an ancestor `export_statement` (covers: `export { X }`, `export { X as Y }`, `export * from`, `export type { X }`, `export default expr`)
2. Its declaration node has an `export` modifier child (covers: `export const X`, `export class X`, `export function X`, `export async function X`, `export type X`, `export interface X`, `export enum X`)
3. It is the subject of a `default_export` kind classification (covers: `export default function`, `export default class` where the declaration has a name)

Fixture tests must cover at minimum all 10 TS export syntaxes listed in the TypeScript specification plus `export * as ns from`.

**Rationale:** Reviewer flagged that `export_statement` ancestry alone misses the common `export const`/`export class`/`export function` patterns (modifier-based exports, NOT wrapped in an `export_statement` node in tree-sitter's grammar). Checking both the ancestor and the modifier child covers all syntaxes. Alternatives considered: (a) heuristic based on whether the file is imported elsewhere — rejected because it requires two passes over the graph and is less accurate; (b) heuristic based on `export` keyword prefix in `source` field — rejected because it misses re-exports and has edge cases with `export default` and `export { ... }` syntax.

### D3: Module descriptions — framework-aware cascade
**Chosen:** Three-level cascade: (1) framework-specific template using `analyzeProject` conventions (`nest_conventions`, `next_conventions`, `hono` modules, `astro_route_map`, `react_conventions`, Python framework detection), (2) dependency-lookup template (match top external packages against a curated role table), (3) file-pattern + keyword template.
**Rationale:** Framework conventions are already extracted by `analyzeProject()` — incremental cost is template code, not new analysis. Framework-aware descriptions are CodeSift's competitive advantage over generic wiki tools. Alternatives: (a) keywords only — rejected as too shallow; (b) LLM-generated descriptions — rejected for determinism, cost, and reproducibility.

**Cascade advancement rule:** For each community, attempt level N. Advance to level N+1 when ANY of: (a) the level's primary data source returns `null` or `undefined` (e.g., `nest_conventions === null`, or `framework === null`); (b) the level's primary data source returns an empty collection (e.g., `nest_conventions.controllers.length === 0` for a community that would otherwise use the NestJS template); (c) the community has zero files matching the level's selector (e.g., level 1 requires ≥1 file under a framework-conventions-known path); (d) the template function throws (caught by per-community try/catch). Level 3 (file-pattern + keyword) is the terminal fallback — it always produces a description from directory prefix + file extensions + fallback phrase "module of N files" if no signal at all.

### D4: Hub scoring — fix call-edge extraction + PageRank + blocklist (defense in depth)
**Chosen:** Three-layer fix, all required. None alone is sufficient.

**Layer 1 (root cause fix) — distinguish method calls from bare function calls in `extractCallSites`.** Currently `graph-tools.ts:extractCallSites` matches `name(` for any identifier. A call site preceded by `.` (e.g., `arr.map(...)`) is a method call whose target is the receiver's type, NOT a bare function named `map` in the project. Update `extractCallSites` to return `{ name, is_method_call: boolean }`. Method-call detection MUST handle: (a) dot-prefix `obj.map(` — detected by looking back one token for `.`; (b) optional chaining `obj?.map(` — detected by looking back for `?.`; (c) bracket notation `obj["map"](` — out of scope for regex detection in v2, accepted residual noise documented as known limitation. `buildAdjacencyIndex` only adds caller edges for bare function calls. Method calls (a+b cases) are discarded from hub-ranking. This eliminates the 610+ fake fan-in edges at the source for dot and optional-chain forms.

**Layer 2 (structural ranking) — PageRank on import graph.** Rank files by PageRank, then rank symbols within each file by fan-in. File-level PageRank further suppresses noise: stdlib/node_modules files aren't in the import graph, so even if any call edges leak through, those files can't rank.

**Layer 3 (defense in depth) — builtin name blocklist.** At hub-ranking output, filter any symbol whose name matches the known JS/TS Array/String/Object/Promise/Map/Set prototype method set (~60 names) AND whose defining file has `file_rank > 20` in PageRank ordering (`file_rank` is the 1-based position of the file when sorted by descending PageRank score). This catches edge cases where a legitimate project symbol is named `map` — preserved when its file is in the top-20 by PageRank — but rejects accidentally-matched stdlib method names in low-PageRank files. Gate metric is PageRank `file_rank`, NOT raw import count, to stay consistent with Layer 2.

**Rationale:** Reviewer consensus (3 independent providers) flagged that PageRank alone does NOT fix the core bug: if a project file defines a symbol named `map` AND has high PageRank, the inflated caller count from `extractCallSites` would still rank it top. The root cause is call-edge extraction treating `.map()` as "call to function named map." Fixing that at the extraction layer eliminates the signal pollution for all downstream consumers (hubs, fan-in, classifySymbolRoles). PageRank and blocklist provide layered protection against residual noise and future regressions.

Alternatives rejected: (a) PageRank only — fails when project has symbol colliding with a builtin name (reviewer caught this); (b) Blocklist only — 17-language maintenance burden, symptom-level fix; (c) Verify call edge via imports — method calls don't route through imports, would require type resolution.

### D5: Structured manifest, no new MCP tool
**Chosen:** Add structured `project` block and `modules[]` array to `wiki-manifest.json`. Agents consume via standard Read. Do not introduce a `query_wiki` MCP tool in v2.
**Rationale:** A new MCP tool requires discovery overhead (agent must know it exists). Reading the manifest file works with standard Read tooling. If future usage shows agents would benefit from a structured query interface, a v3 `query_wiki` tool can be added without breaking changes.

### D6: Section headers in community pages are stable contract
**Chosen:** New sections prepended in order: `## Overview`, `## Key Exports`, `## Files`, `## Dependencies`, `## Hub Symbols`, `## Hotspots`. External scrapers relying on existing headers (`## Files`, `## Hub Symbols`, `## Hotspots`) continue to work.
**Rationale:** Minimizes breakage for any external tools parsing wiki markdown.

### D7: Manifest schema versioning
**Chosen:** Add `schema_version: 2` to manifests. Treat missing field as v1.
**Rationale:** Enables clean backward compatibility in both directions (v2 tooling reading v1 manifests, v1 tooling reading v2 manifests via additive fields).

### D8: Hook summary budget raised to 2500 chars
**Chosen:** Raise `WIKI_SUMMARY_MAX_CHARS` from 2000 to 2500. Make configurable via `CODESIFT_WIKI_SUMMARY_MAX_CHARS` env var.
**Rationale:** Richer content (purpose + 3-5 key exports + dependencies + hotspot warning) needs more budget. 2500 chars ≈ 625 tokens, still cheap. Agents already handle truncation.

### D9: Rollback via env var + v1 generator preserved one cycle
**Chosen:** `CODESIFT_WIKI_V1=1` env var forces v1 generator. Keep v1 generator functions alongside v2 for one release cycle (one `npm version minor` bump).
**Rationale:** Enables emergency rollback without reverting published package. Low code cost since v1 functions already exist and are small.

## Solution Overview

Wiki v2 upgrades the existing `generateWiki()` orchestrator to consume the full `ProjectProfile` returned by `analyzeProject()`, replace the current caller-count-based hub ranking with PageRank, and produce framework-aware module descriptions. The manifest schema evolves to v2 with a structured `project` block and `modules[]` array. New page types (`overview`, `architecture`) are added. The codesift-dashboard reads the new structured data to render a project overview card and differentiated module excerpts.

```
                          ┌──────────────────┐
                          │  generateWiki()  │
                          └────────┬─────────┘
                                   │
                      Parallel analysis fan-out (unchanged)
            ┌──────────┬───────────┼───────────┬──────────┬──────────┐
            ▼          ▼           ▼           ▼          ▼          ▼
     detectCommunities classify  fanInOut   coChange   hotspots  analyzeProject
                      SymbolRoles                                (rich extraction)
                          │                                            │
                          └────┬──────────────────────────────────────┘
                               │ classifySymbolRoles output is consumed by
                               │ rankHubsByPageRank — this is a dependency,
                               │ not another parallel step.
                                   │
                                   ▼
              ┌──────────────────────────────────────────┐
              │ NEW: buildProjectOverview(projectResult) │
              │ NEW: rankHubsByPageRank(importEdges)     │
              │ NEW: buildModuleDescriptions(            │
              │        communities, projectResult,       │
              │        codeIndex)                        │
              │ NEW: buildRealCrossEdges(                │
              │        importEdges, fileToCommunity)     │
              └──────────────────────────────────────────┘
                                   │
                                   ▼
              ┌──────────────────────────────────────────┐
              │ Page generators (rewritten + new)        │
              │  - generateOverviewPage (NEW)            │
              │  - generateArchitecturePage (NEW)        │
              │  - generateCommunityPage (rewritten)     │
              │  - generateHubsPage (uses ranked output) │
              │  - generateCommunitySummary (rewritten)  │
              └──────────────────────────────────────────┘
                                   │
                                   ▼
                     wiki-manifest.json (schema v2)
                     .codesift/wiki/*.md + *.summary.md
                                   │
                                   ▼
              ┌──────────────────────────────────────────┐
              │ Consumers                                │
              │  - hooks.ts tryLoadWikiSummary           │
              │  - codesift-dashboard wiki-data.ts       │
              │  - codesift-dashboard wiki pages         │
              └──────────────────────────────────────────┘
```

## Detailed Design

### Data Model

**New interfaces in `src/tools/wiki-manifest.ts`:**

```ts
export interface WikiManifestV2 {
  schema_version: 2;
  generated_at: string;
  index_hash: string;
  git_commit: string;
  project: ProjectOverview;          // NEW
  modules: ModuleMetadata[];         // NEW
  pages: PageInfo[];                 // unchanged
  slug_redirects: Record<string, string>;
  token_estimates: Record<string, number>;
  file_to_community: Record<string, string>;
  lens_data?: LensData;              // unchanged
  degraded: boolean;
  degraded_reasons?: string[];
  modules_truncated?: boolean;            // true when modules[] was truncated; pages are always complete
  truncation_reason?: "module_count_cap" | "token_budget";
}

export interface ProjectOverview {
  name: string;
  git_remote: string | null;
  project_type: "monorepo" | "single";
  stack: {
    language: string;
    language_version: string | null;
    framework: string | null;
    framework_version: string | null;
    test_runner: string | null;
    package_manager: string | null;
    build_tool: string | null;
  };
  scripts: Record<string, string>;        // from package.json / pyproject.toml / Makefile
  entry_points: string[];                 // from dependency_graph.entry_points
  workspaces: string[];                   // empty array if not monorepo
  dependencies: DependencySummary;        // NEW — top prod/dev packages + total counts
  known_gotchas: { gotcha: string; severity: "high" | "medium" | "low" }[];
  stats: {
    total_files: number;
    total_commits: number | null;         // null if no git history or shallow
    contributors: number | null;
  };
}

export interface DependencySummary {
  prod_total: number;                     // count from package.json dependencies (or equivalent)
  dev_total: number;                      // count from devDependencies (or equivalent)
  key: Array<{
    name: string;
    version: string;                      // raw version range string from package.json/pyproject.toml/go.mod
    kind: "prod" | "dev";
  }>;                                     // top ~15 by architectural relevance (framework + DB + test runner + build tool + common libs)
}

export interface ModuleMetadata {
  slug: string;
  name: string;                           // human-readable, e.g. "Hono Framework Tools"
  description: string;                    // 1-2 sentences, no trailing period omissions
  role: ModuleRole;
  files: number;
  cohesion: number;                       // 0..1
  key_exports: KeyExport[];               // max 5, sorted by fan-in desc
  depends_on: string[];                   // other module slugs
  depended_by: string[];                  // other module slugs
  has_hotspot: boolean;                   // any file in this community is in top-20 hotspots
  workspace?: string;                     // monorepo workspace path (e.g. "apps/web"), omitted for single-package repos
}

export type ModuleRole =
  | "framework-tools" | "framework-routes" | "framework-components"
  | "core-library" | "data-access" | "utilities" | "parsers"
  | "storage" | "search" | "cli" | "tests" | "scripts"
  | "micro-module" | "unknown";

export interface KeyExport {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "component" | "hook" | "default_export";
  file: string;
  signature?: string;                     // from CodeSymbol.signature when available
}
```

**Updated `CodeSymbol` in `src/types.ts`:**

```ts
export interface CodeSymbol {
  // ... existing fields ...
  is_exported?: boolean;                  // NEW — set by TS extractor; optional for compat
}
```

**New page types in `PageInfo.type`:**
- `"overview"` — project overview page (always present)
- `"architecture"` — module dependency narrative (present when ≥ 3 communities)
- Existing types unchanged: `"community"`, `"hubs"`, `"surprises"`, `"hotspots"`, `"framework"`, `"index"`

### API Surface

**New exported functions in `src/tools/wiki-page-generators.ts`:**

```ts
export function generateOverviewPage(project: ProjectOverview, modules: ModuleMetadata[]): string;
export function generateArchitecturePage(modules: ModuleMetadata[]): string;
// rewritten signatures:
export function generateCommunityPage(data: CommunityPageData, module: ModuleMetadata): string;
export function generateCommunitySummary(data: CommunityPageData, module: ModuleMetadata): string;
export function generateIndexPage(pages: PageInfo[], project: ProjectOverview): string;
```

**New module `src/tools/wiki-module-builder.ts`:**

```ts
export function buildModuleMetadata(
  communities: CommunityInfo[],
  projectResult: ProjectProfile,
  codeIndex: CodeIndex,
  importEdges: ImportEdge[],
  fileHotspots: FileHotspot[],
  rankedHubs: RankedHubSymbol[],
): ModuleMetadata[];

export function buildProjectOverview(
  projectResult: ProjectProfile,
  codeIndex: CodeIndex,
): ProjectOverview;

// v2 writer (default)
export function buildWikiManifest(opts: BuildWikiManifestOptions): WikiManifestV2;

// v1 writer (rollback path — preserved for one release cycle)
// Produces manifest with NO schema_version, NO project, NO modules fields.
// Invoked only when CODESIFT_WIKI_V1=1 or --v1 flag present.
export function buildWikiManifestV1(opts: BuildWikiManifestV1Options): WikiManifestV1;

// Legacy v1 read support used by v2 writer only for slug_redirects preservation.
export function loadLegacyManifest(path: string): WikiManifest | null;
```

**New module `src/tools/wiki-hub-ranker.ts`:**

```ts
export interface RankedHubSymbol extends HubSymbol {
  pagerank: number;        // file-level PageRank (0..1, sums to 1 over all files)
  file_rank: number;       // 1-based rank of the file in PageRank order
}

export function rankHubsByPageRank(
  importEdges: ImportEdge[],
  symbolRoles: SymbolRole[],
  options?: { topK?: number; minFileRank?: number },
): RankedHubSymbol[];
```

**Graph utility addition in `src/utils/import-graph.ts`:**

```ts
export function buildFilePageRank(edges: ImportEdge[]): Map<string, number>;
```

**Hook summary format (stable contract, parseable by external tools):**

```
## [Module Name]

[Description — 1-2 sentences]

**Role**: [module role]  |  **Files**: [n]  |  **Cohesion**: [xx]%

**Key exports**: [name1], [name2], [name3]

**Depends on**: [module1], [module2]
**Used by**: [module3], [module4]

[Optional: "⚠ Hotspot: [file] ([n] commits)" line if has_hotspot]
```

**CLI commands unchanged:**
- `codesift wiki-generate` — produces v2 manifest and pages
- `codesift wiki-generate --v1` — forces v1 generator (rollback path, one release cycle only)
- `codesift wiki-lint` — unchanged, validates v2 manifest
- Env var `CODESIFT_WIKI_V1=1` — forces v1 via env (same effect as `--v1` flag)

### Integration Points

**codesift-mcp (primary changes):**

| File | Change Summary |
|---|---|
| `src/tools/wiki-tools.ts` | Orchestrator: extract full `projectResult`, call `buildFilePageRank`, `rankHubsByPageRank`, `buildProjectOverview`, `buildModuleMetadata`, `buildRealCrossEdges`. Pass structured data to new generators. V1 fallback via env var. |
| `src/tools/wiki-page-generators.ts` | Rewrite `generateCommunityPage`, `generateCommunitySummary`, `generateHubsPage`, `generateIndexPage`. Add `generateOverviewPage`, `generateArchitecturePage`. |
| `src/tools/wiki-manifest.ts` | Extend `WikiManifest` → `WikiManifestV2`. Keep v1 type for backward-compat reads. `buildWikiManifest` accepts and writes v2. |
| `src/tools/wiki-module-builder.ts` | NEW. `buildModuleMetadata`, `buildProjectOverview`, description cascade helpers. |
| `src/tools/wiki-hub-ranker.ts` | NEW. PageRank integration via `graphology-metrics`. |
| `src/utils/import-graph.ts` | Add `buildFilePageRank(edges)` utility. |
| `src/tools/graph-tools.ts` | Update `extractCallSites` to return `{ name, is_method_call: boolean }` (detect `.` prefix). `buildAdjacencyIndex` skips method calls when building caller edges. Add builtin-name blocklist constant (~60 entries) applied at hub-output filter, gated on "symbol's file is NOT in top-20 PageRank files" to avoid over-filtering legitimate project symbols named `map`/`get`/etc. |
| `package.json` (codesift-mcp) | Add `graphology-metrics` dependency at a pinned minor version (`^2.x`). Lockfile regenerated. `graphology` is already a dependency. |
| `src/parser/extractors/typescript.ts` | Set `is_exported: true` per the full D2 rule set: (a) AST ancestor is `export_statement` (covers `export { X }`, `export * from`, `export type { X }`, `export default <expr>`); AND (b) declaration node has `export` modifier child (covers `export const X`, `export class X`, `export function X`, `export async function X`, `export type X`, `export interface X`, `export enum X`); AND (c) `default_export` kind symbols where the declaration has a name. Fixture tests must cover all 10 TS export syntaxes plus `export * as ns from`. |
| `src/parser/extractors/_shared.ts` | Propagate `is_exported` through symbol construction. |
| `src/types.ts` | Add `is_exported?: boolean` to `CodeSymbol`. |
| `src/parser/extractors/index.ts` (or wherever `EXTRACTOR_VERSIONS` lives) | Bump `typescript` extractor version → triggers reindex via existing `extractor_version` cache check. |
| `src/cli/hooks.ts` | Raise `WIKI_SUMMARY_MAX_CHARS` to 2500. Add `CODESIFT_WIKI_SUMMARY_MAX_CHARS` env override. No format change to hook API. |
| `src/register-tools.ts` | No changes (no new MCP tools). |
| `src/instructions.ts` | Update the `generate_wiki` description line in `CODESIFT_INSTRUCTIONS` to explain the agent consumption model: "read `.codesift/wiki/wiki-manifest.json` for structured project overview (stack, modules, key exports) OR read `.codesift/wiki/*.md` for narrative content. Hook auto-injects `{community}.summary.md` on Read of small files." Add to TOOL MAPPING: "project overview / onboarding → read wiki-manifest.json project block". |
| `tests/tools/wiki-tools.test.ts` | Rewrite snapshot tests. Add hub builtin exclusion test. |
| `tests/tools/wiki-hub-ranker.test.ts` | NEW. PageRank unit tests. |
| `tests/tools/wiki-module-builder.test.ts` | NEW. Description cascade tests + edge cases. |
| `tests/fixtures/wiki-v2/` | NEW. Three minimal repos (TS monorepo, Python FastAPI, Go with go.mod) for integration tests. |

**codesift-dashboard (secondary changes):**

| File | Change Summary |
|---|---|
| `src/lib/wiki-data.ts` | Extend `WikiManifest` type to match v2. Add `ProjectOverview`, `ModuleMetadata` types. New helpers: `getProjectOverview(repoName)`, `getModuleMetadata(repoName, slug)`. Keep v1 readers as fallback. |
| `src/pages/wiki/[namespace]/[repo]/index.astro` | Render project overview card above community grid. Use `modules[]` for page list instead of scraping markdown. |
| `src/components/WikiPageList.tsx` | Accept `ModuleMetadata[]` prop. Use `description` for excerpts. Fall back to markdown scrape if `modules[]` absent. |
| `src/components/ProjectOverviewCard.astro` (or `.tsx`) | NEW. Render stack info, scripts, entry points, gotchas. |
| `src/components/WikiContent.tsx` | Minor: add CSS classes for new section headers (`## Overview`, `## Key Exports`, `## Dependencies`). Markdown rendering unchanged. |
| `src/styles/global.css` | Add styles for overview card, key-exports tables. |

**Schema and extractor changes summary:**
- No new MCP tools registered.
- No new database tables. No indexing schema changes beyond an additive optional field (`CodeSymbol.is_exported?: boolean`).
- TypeScript extractor version bumped (forces reparse of TS files on next session via existing `extractor_version` cache check). Other language extractors unchanged.
- No breaking changes to existing `CodeSymbol` consumers (field is optional).

### Interaction Contract

Not applicable — no cross-cutting behavioral changes to the agent. The wiki data layer is a data product, not an agent behavior contract. Hook injection format changes are documented as a stable contract above but do not override or classify agent behavior.

### Edge Cases

| Case | Handling |
|---|---|
| Community with only test files (`*.test.*`, `*.spec.*`, `__tests__/*`) | Detected via file-pattern classifier in module builder. Role = `"tests"`. Description template: "Test suite for [target-module-inferred-from-imports]". |
| Community < 4 files | Role = `"micro-module"`. Skip "Key Exports" if fewer than 2 exports. Skip "Hub Symbols" if none survive PageRank filter. Use compact template. |
| Community has no exported symbols (all internal) | `key_exports: []`. Generator skips "## Key Exports" section. Description falls through from exports-based template to dep-lookup template. |
| Community with no clear naming pattern → `community-N` from Louvain | Apply existing `nameCommunity()` logic first (deepest common prefix, directory+keyword), then fall back to export-name clustering (description level — NOT a cascade level for module name; produces description text like "Module exporting parse*, validate* functions"), then `community-N` as last resort for name. The "exports-based template" mentioned in description cascade D3 level 2 is the *dep-lookup template* — it combines external-dep role table with export-name prefix clustering as secondary signal. Cascade reference is unified here. |
| No `package.json` (Go / Rust / Python-only project) | `buildProjectOverview` falls back with source-order priority. Scope of extraction for non-JS configs is intentionally narrow in v2:<br>**`go.mod`** — regex `/^module\s+(\S+)/m` for module name. Dependencies: best-effort regex scan of `require (...)` block; if the regex fails on complex formatting, `dependencies.prod_total` is 0 and `dependencies.key` is empty.<br>**`Cargo.toml`** — regex-based extraction of the `[package]` section only: `name`, `version`, `description` via `/^\[package\]\s*\n([\s\S]*?)(?=^\[)/m` then `/^name\s*=\s*"([^"]+)"/m` etc. Dependency extraction is best-effort (regex scan of `[dependencies]` and `[dev-dependencies]` table entries of the simple form `name = "version"`). Tables-in-tables (`[dependencies.foo]`) are NOT parsed in v2 — deferred.<br>**`pyproject.toml`** — regex-based extraction of the `[project]` section for `name`, `version`, `description`. Dependency extraction is best-effort: `dependencies = [ ... ]` array parsed via regex. `[tool.poetry]`-style projects use equivalent regex on that section. Complex dependency specs (extras, markers, source URLs) are stored as raw strings.<br>**Not attempted in v2:** Makefile parsing (scripts remain empty for Makefile-only projects), full TOML spec compliance (tables-in-tables, array of tables, nested structures), `requirements.txt` dependency version ranges.<br>If all manifest files absent, overview shows `name = repo directory name, stack.language = detected from index files`. Any regex failure for a field → field is `null` or empty, NOT an exception. |
| Monorepo with same directory name across workspaces (`apps/web/src/utils` + `apps/api/src/utils`) | Community slug collision risk. `buildUniqueSlugs` in `wiki-manifest.ts` already handles collisions by appending numeric suffixes. For monorepo projects (`project_type === "monorepo"`), slug generation prepends the workspace path prefix (e.g., `apps-web-src-utils` vs `apps-api-src-utils`) before collision-check, eliminating the semantic ambiguity. `ModuleMetadata.workspace` field records the workspace for consumer use. |
| Monorepo with multiple packages | `project.project_type = "monorepo"`, `project.workspaces` listed. Module descriptions tagged with package path when community is entirely under one workspace. Root `package.json` scripts shown in overview; per-workspace scripts deferred to v3. |
| Project with both `package.json` and `pyproject.toml` | Both detected. `stack.language` lists primary (by file count); overview page "Stack" section notes secondary runtime. Scripts from both files are shown, prefixed by file source. |
| Project without scripts in `package.json` | `scripts: {}`. Overview page skips "## Setup" section. Falls back to first-found `README.md` heading match (`## Installation`, `## Getting Started`) — best-effort, not required. |
| Shallow clone (`git rev-parse --is-shallow-repository` returns `true`) or < 10 commits | Detected during `analyzeProject`. Degraded reason added: `"shallow_clone_or_insufficient_history"`. Overview stats shows `total_commits: null`. Hotspots page shows explicit degraded banner. Module `has_hotspot` computed from available data (may be underreporting). |
| `is_exported` reindex hasn't happened yet | All symbols have `is_exported === undefined`. `buildModuleMetadata` falls back: treat every named symbol (of a CALLABLE_KIND — function, class, type, interface, component, hook) in files that appear in `collectImportEdges` edge `to` list as potentially exported. Files with incoming import edges are the ones being imported, so at least some of their symbols are exports. Lexical depth is not filtered (CodeSymbol lacks depth info); the list may include locals and is trimmed to top-5 by caller fan-in to keep noise manageable. Generator includes a note: "Key exports list is approximate — rerun after reindex for accurate data." |
| Framework conventions extraction fails for a detected framework | `nest_conventions === null` despite `framework === "nestjs"`. Description cascade falls through to dep-lookup. No error; degraded reason logged. |
| `graphology-metrics` PageRank fails (disconnected graph, invalid input) | Caught by surrounding try/catch in `rankHubsByPageRank`. Falls back to `classifySymbolRoles` caller-count ordering. Degraded reason added. |
| `is_exported: true` but symbol has no callers (orphan export, public API) | Included in `key_exports` if symbol is in the top-5 ranked exports for the community — public API rank is preserved even without callers. |
| Community spans multiple packages in a monorepo | Role defaults to `"unknown"` if no majority package. Description notes cross-package composition. |
| Extremely large project (1000+ communities) | `modules[]` truncated to top-200 by file count. Page generation unaffected (still per-community). Manifest includes `modules_truncated: true` flag. |
| Import graph empty but repo has symbols (e.g., single-file project or unresolved imports) | Detected by `importEdges.length === 0`. PageRank skipped. Hubs page generator emits the structural fallback section: "No import relationships detected for this repository. Hub ranking unavailable — try `detect_communities` or add source files with imports." Degraded reason: `"import_graph_empty"`. Module dependencies (`depends_on`, `depended_by`) all empty arrays — descriptions still generated from file patterns and exports. `classifySymbolRoles` output is NOT used as fallback (see Failure Modes for aligned behavior). |
| File in index but deleted from disk between analyses | Existing handling in `analyzeProject` — file skipped with logged reason. `modules[]` may list a stale file in `key_exports`; next regeneration self-corrects. |

### Failure Modes

**Component: PageRank computation (wiki-hub-ranker.ts)**

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|---|---|---|---|---|---|---|
| `graphology-metrics/centrality/pagerank` import fails | Module load throws | Hub ranking only | Hubs page shows legacy ordering | Fall back to `classifySymbolRoles` output, add degraded reason `"pagerank_unavailable"` | Manifest written with legacy hubs; `schema_version: 2` still set | Immediate at start of generateWiki |
| Import graph is empty (fresh repo, no edges) | `edges.length === 0` | Hubs page | Empty-state message: "No import relationships detected for this repository" | Generate structural empty-state hubs page, add degraded reason `"import_graph_empty"`. NO classifySymbolRoles fallback (caller counts would be meaningless without structural anchor). | Empty hubs list in manifest | Immediate |
| File is a disconnected node in PageRank (no in-edges or out-edges) | Pre-filter: file must have ≥1 in-edge OR ≥1 out-edge to be ranked | File excluded from hub ranking | File's symbols don't appear as hubs | Skip file at pre-filter stage before calling `pagerank()` — never relies on NaN handling (graphology-metrics distributes rank across components natively, does not emit NaN for isolated nodes) | Manifest consistent — hubs come from ranked files only | Immediate |
| Graph has cycles (circular imports) | PageRank algorithm handles natively | None | Normal ranking | No action needed | Consistent | N/A |

**Cost-benefit:** Frequency: rare (PageRank library is stable, import graph rarely empty). Severity: medium (hubs page is a key feature). Mitigation cost: trivial (catch + fall back to existing ordering). **Decision: Mitigate.**

**Component: Module description builder (wiki-module-builder.ts)**

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|---|---|---|---|---|---|---|
| Framework conventions return `null` despite framework detected | `nest_conventions === null && framework === "nestjs"` | Single module description | Framework-aware template skipped | Fall through to dep-lookup template | `modules[i].description` still populated with fallback content | Immediate per community |
| Community has no files (empty array after filter) | `community.files.length === 0` | Single module | Module entry omitted from `modules[]` | Skip community in builder | Manifest consistent — page for this community also skipped | Immediate |
| `package.json` missing but TS files present | `stack.package_manager === null` | Dep-lookup template limited to inferred imports | Description quality degraded to keyword-only | Keyword template | Description field non-empty, lower information density | Immediate |
| Description computation throws | Per-community try/catch | Single module | Module gets generic description "[slug] — module of N files" | Catch + log, add minor degraded reason | `modules[i].description` set to fallback | Immediate per community |

**Cost-benefit:** Frequency: occasional (frameworks misdetected, unusual projects). Severity: low (graceful fallback produces usable content). Mitigation cost: trivial. **Decision: Mitigate.**

**Component: `is_exported` TypeScript extractor change**

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|---|---|---|---|---|---|---|
| Extractor version mismatch in existing index (user upgrades but hasn't reindexed) | `extractor_version !== EXTRACTOR_VERSIONS.typescript` | All TS files | Files rescheduled for reparse | First post-upgrade session triggers reindex of TS files | During reindex window, symbols lack `is_exported` → module builder uses fallback | Detected at index load; reindex completes within seconds to minutes depending on repo size |
| Tree-sitter AST change: `export_statement` node missed for edge case syntax (e.g., `export * from`, `export type { X }`) | Manual test review during implementation; integration test fixtures | Specific export syntaxes | Those exports flagged `is_exported === undefined` in output | Documented known limitation; add backlog item if found in testing | Affected symbols not listed in key_exports; rest of module data correct | Implementation time |
| TypeScript extractor throws unrelated error during refactor | Existing extractor error path | Single file skipped | File excluded from index | Existing behavior | Inconsistent only for that file until fix | Immediate |
| Reindex fails midway (disk full, process killed) | Index state partially updated | Extractor version only partially bumped | Mixed state — some files have new version, some old | Next session re-runs reindex for mismatched files | Self-healing via existing `extractor_version` check | Next index load |

**Cost-benefit:** Frequency: guaranteed one-time reindex, plus rare edge-case syntax misses. Severity: medium (key exports partially wrong until reindex; rare edge cases undetected). Mitigation cost: moderate (requires careful AST traversal + integration tests). **Decision: Mitigate (mandatory, since this is the feature).**

**Component: Hook summary injection**

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|---|---|---|---|---|---|---|
| V1 `.summary.md` file on disk (v1 format: 4 lines), V2 hook binary reads it | N/A — hook reads `.summary.md` file directly, does not parse manifest for versioning | Hook injection only | V2 hook injects the v1 4-line content verbatim | No special handling needed — hook is format-agnostic; reads file contents and writes to stdout | No corruption; older summary content injected | Immediate per hook fire |
| V1 manifest on disk, V2 dashboard reads it | `schema_version` absent in parsed manifest | Dashboard rendering only | V2 dashboard disables v2-only UI | Conditional render based on `schema_version === 2` check | No corruption; legacy UI rendered | Immediate on page load |
| V2 manifest on disk, V1 hook binary reads it | V1 hook ignores unknown fields | Hook injection | V1 hook works normally (reads `.summary.md`) | No action needed | Consistent — summary file content matches current manifest | N/A |
| Summary file > 2500 chars after raise | Length check at write time | Single summary | Truncation at 2500 (v2) or 2000 (v1 hook) | Existing truncation behavior; generator emits warning log | Content truncated mid-line possible; existing behavior | At generation time |
| `CODESIFT_WIKI_SUMMARY_MAX_CHARS` set to an invalid value | `parseInt` returns NaN | Hook injection | Falls back to default 2500 | `Number.isNaN` check | Consistent | Immediate |

**Cost-benefit:** Frequency: occasional during upgrade window. Severity: low (hook is bonus context). Mitigation cost: trivial. **Decision: Mitigate.**

**Component: Dashboard manifest read**

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|---|---|---|---|---|---|---|
| V2 dashboard reads V1 manifest (no `schema_version`, no `project`, no `modules`) | `schema_version === undefined` | All wiki pages for that repo | Project overview card hidden; module excerpts fall back to markdown scrape | Conditional render: only show v2 features when `schema_version >= 2` | Consistent — legacy behavior preserved | Immediate per page load |
| V1 dashboard (old deployment) reads V2 manifest | Unknown fields ignored | None visible | Legacy rendering | No action needed | Consistent | N/A |
| V2 manifest has empty `modules: []` (degraded generation) | `modules.length === 0` | Module excerpts | Falls back to markdown scrape for excerpts | Existing path | Consistent | Immediate |
| V2 `project.stack.framework === null` | Field check | Overview card | "Framework: (none detected)" or hidden row | Conditional render per field | Consistent | Immediate |
| `modules[i].description` is empty string | Length check | Single card | Falls back to truncated `modules[i].name` + file count | Conditional render | Consistent | Immediate |
| Manifest JSON is malformed (partial write during concurrent regen, disk corruption) | `JSON.parse` throws | Entire wiki index page for that repo | Error banner: "Wiki manifest unreadable — regenerate via `codesift wiki-generate`"; page list falls back to directory listing of `.codesift/wiki/*.md` | `wiki-data.ts` wraps parse in try/catch; on failure, degrade to scanning `.md` filenames | Consistent — partial data shown, never crash | Immediate on page load |
| Manifest file missing entirely | `existsSync === false` | Entire wiki index page | Empty state: "No wiki generated for this repo. Run `codesift wiki-generate`." | Existing `getWikiRepos` path handles this case | Consistent | Immediate |

**Cost-benefit:** Frequency: guaranteed during rollout (mixed v1/v2 in field). Severity: low (graceful degradation). Mitigation cost: trivial (conditional rendering). **Decision: Mitigate.**

## Acceptance Criteria

### Ship criteria (must pass for release — deterministic, fact-checkable)

1. **AC-SHIP-1 (Hub builtin exclusion — structural):** Two deterministic tests required:

   (a) **Synthetic unit test** (`tests/tools/wiki-hub-ranker.test.ts`): build a synthetic corpus — file A defines `function map()`, file B contains `arr.map(...)` — run `extractCallSites` on file B and assert the returned list has `is_method_call: true` for the `map` entry. Then run `buildAdjacencyIndex` and assert `map` from file A has zero caller edges from file B. Then run `rankHubsByPageRank` and assert `map` does NOT appear in the top-10 hubs regardless of file A's PageRank. This test proves the method-call fix at the extraction layer.

   (b) **Integration test on codesift-mcp**: generate wiki, parse `hubs.md`, and assert that the top 10 hub rows contain no symbol whose name matches the builtin blocklist (the test reads `hubs.md` only, no manifest cross-reference required). The blocklist is a static list maintained in `wiki-hub-ranker.ts` and imported by the test.

   Verifiable by: both tests pass in CI. No arbitrary numeric bounds. No manifest `file_rank` persistence required.

2. **AC-SHIP-2 (Community description uniqueness — v2 output only):** For manifests with `schema_version === 2`, no community page body contains the exact v1 boilerplate `"A community is a group of files that are more tightly connected"`. V1 rollback output is EXEMPTED from this check. Verifiable by: after a default (v2) generation run, `grep -L "A community is a group" .codesift/wiki/*.md` returns all community files (zero files contain it). Rollback output tested separately by AC-SHIP-9.

3. **AC-SHIP-3 (Manifest schema v2):** Generated `wiki-manifest.json` contains `schema_version: 2`, non-null `project` object with `name` and `stack.language` fields populated, and a `modules` array. "Community count" for the AC is defined as: communities detected by Louvain AND retained after empty-file-list filtering (i.e., the same set that receives generated `.md` pages). `modules` MAY be empty only when that filtered community count is zero — and in that case, `degraded_reasons` MUST include `"no_modules_after_filter"`. In all other cases, every `modules[]` element has `slug`, `name`, `description` (non-empty string), and `role`. Verifiable by: JSON schema validation test + conditional assertion tying `modules.length` to post-filter community count.

4. **AC-SHIP-4 (Dashboard v1 backward compat):** Dashboard (v2 code) loads a v1 manifest (missing `schema_version`) without throwing a runtime error. No v2-only features rendered. Verifiable by: dashboard integration test with v1 fixture manifest.

5. **AC-SHIP-5 (Dashboard v2 rendering):** Dashboard loads a v2 manifest and renders: (a) project overview card with stack info, (b) module descriptions in wiki page list, (c) differentiated excerpts (no two cards are string-identical). Verifiable by: dashboard integration test with v2 fixture manifest (the test fixture MUST contain ≥5 modules with intentionally-distinct descriptions — fixture configuration committed to repo). Assert rendered HTML contains project name, stack labels, and `min(modules.length, 5)` distinct excerpt strings.

6. **AC-SHIP-6 (Hook summary structure):** `.summary.md` files contain at minimum: a module name line, a purpose line, a key-exports line, and a dependencies line. Verifiable by: structural regex test on generated summary files.

7. **AC-SHIP-7 (All tests pass):** `npm test` passes in codesift-mcp (existing 2971 tests + new tests for builders/generators/PageRank). `npm test` passes in codesift-dashboard.

8. **AC-SHIP-8 (CLI smoke on three stacks):** `codesift wiki-generate` exits 0 on: codesift-mcp (TypeScript), a Python fixture repo, and a Go fixture repo. Each produces a non-empty `wiki-manifest.json` with `schema_version: 2`.

9. **AC-SHIP-9 (Rollback path):** `CODESIFT_WIKI_V1=1 codesift wiki-generate` or `codesift wiki-generate --v1` produces a v1-format manifest and v1-format pages. Verifiable by ALL of: (a) manifest lacks `schema_version` field; (b) manifest lacks `project` and `modules` top-level keys; (c) community pages contain no `## Overview` and no `## Key Exports` section headers; (d) community pages DO contain the v1 boilerplate substring `"A community is a group of files"` (structural check that v1 templates are in use). Note: D4 Layer 1 fixes `extractCallSites` globally, so v1 hub content will BENEFIT from the method-call fix (inflated builtin counts no longer appear). This is acceptable — rollback restores v1 templates and manifest schema, not the underlying graph extraction bug. Ship criterion validates rollback SCHEMA/TEMPLATES, not regression of the underlying bug.

10. **AC-SHIP-10 (Extractor reindex):** After bumping `EXTRACTOR_VERSIONS.typescript`, loading a repo with the old index triggers automatic reparse of TS files. New `CodeSymbol` records have `is_exported` populated for exported symbols. Verifiable by: unit test that loads a stale index, triggers lazy reindex, then queries a known exported symbol.

### Success criteria (value validation — measurable quality/efficiency)

1. **AC-SUCCESS-1 (Description differentiation, manual review):** For codesift-mcp wiki, manual review of 10 community pages confirms each has a distinct purpose sentence (not a close paraphrase of another). Reviewer: user + implementer.

2. **AC-SUCCESS-2 (Hub symbols look like real project symbols):** For codesift-mcp wiki, the top 20 entries on `hubs.md` are recognizable project symbols (not JS/Node builtins). Reviewer: user + implementer.

3. **AC-SUCCESS-3 (Hook summary usefulness):** For 5 randomly selected modules in codesift-mcp, the injected `.summary.md` contains: (a) a purpose sentence, (b) ≥ 2 key exports, (c) ≥ 1 depends-on entry, (d) ≤ 2500 chars. Measurable count.

4. **AC-SUCCESS-4 (Dashboard differentiated excerpts):** Dashboard wiki index page for codesift-mcp shows ≥ 10 community cards. No two cards have identical excerpt text. Reviewer: user screenshot comparison.

5. **AC-SUCCESS-5 (Framework-aware descriptions):** For at least 3 framework-detected fixture projects (NestJS, Next.js, and one of Hono/Astro/Django-FastAPI), the generated overview page contains framework-specific content (detected framework name + version, route/component/controller counts where available). Verifiable by: fixture integration test.

6. **AC-SUCCESS-6 (Architecture page content):** When generated (≥3 communities), `architecture.md` contains at minimum: one summary sentence, one line per module slug referencing it by `[[slug]]` wikilink, and a non-empty "key relationships" section listing the top 5 cross-module edges by weight. Verifiable by: structural regex test on generated `architecture.md`.

## Validation Methodology

1. **Fixture repos committed at `tests/fixtures/wiki-v2/`:**
   - `ts-monorepo/` — minimal pnpm workspace with `apps/web` (Next.js) and `apps/api` (Hono). 15-20 files total. Provides monorepo + multi-framework coverage.
   - `python-fastapi/` — minimal FastAPI app with `pyproject.toml`. 5-8 files. Provides non-JS + Python framework coverage.
   - `go-module/` — minimal Go module with `go.mod`. 4-6 files. Provides non-JS + no-package.json coverage.

2. **Snapshot tests:** `tests/tools/wiki-tools.test.ts` generates wiki for each fixture and snapshots the manifest JSON (with volatile fields redacted: `generated_at`, `index_hash`, `git_commit`) and snapshots each generated markdown page. Snapshots reviewed during code review; intentional changes require explicit snapshot update.

3. **Hub builtin exclusion test:** `tests/tools/wiki-hub-ranker.test.ts` builds a synthetic import graph with one file defining `map` and another containing `[].map(...)`. Assert the synthetic `map` does NOT appear as the top hub.

4. **Schema validation test:** JSON Schema file at `schemas/wiki-manifest-v2.schema.json` (committed). Test uses `ajv` (add as devDependency if absent) or simple structural assertions to validate each generated manifest.

5. **Description cascade unit tests:** `tests/tools/wiki-module-builder.test.ts` — for each cascade level (framework-aware, dep-lookup, keyword), provide an input that exercises that level and assert description contains expected substrings.

6. **Dashboard visual check:** Manual run of `npm run dev` in codesift-dashboard. Screenshot `/wiki/greglas/codesift-mcp` at regeneration time. Compare to design expectation (project overview card visible, module cards have distinct descriptions).

7. **Hook format regression test:** `tests/cli/hooks.test.ts` — generate a fixture wiki, simulate hook trigger, assert injected stdout matches the hook summary contract regex.

8. **Rollback test:** `tests/cli/wiki-v1-rollback.test.ts` — set `CODESIFT_WIKI_V1=1`, run generator, assert manifest lacks `schema_version` and community page contains v1 boilerplate.

9. **End-to-end smoke (CLI):** CI step that runs `codesift wiki-generate` on codesift-mcp itself, asserts exit code 0, asserts manifest validates against schema, asserts `modules.length > 0`.

## Rollback Strategy

**Kill switch:** Environment variable `CODESIFT_WIKI_V1=1` forces the v1 generator path. Takes effect at next `codesift wiki-generate` invocation. No service restart required (CLI is invoked fresh each run).

**CLI flag:** `codesift wiki-generate --v1` achieves the same effect per-invocation.

**Preserved code path:** V1 generator functions (`generateCommunityPage_v1`, `generateCommunitySummary_v1`, etc.) kept in `wiki-page-generators.ts` alongside v2 for one release cycle (one minor version bump). Marked with deprecation comment. Removed in the subsequent release.

**Data preservation:** Wiki regeneration is non-destructive to source code. `.codesift/wiki/` directory is overwritten with each generation. To fully roll back: delete `.codesift/wiki/` and re-run with `--v1` or `CODESIFT_WIKI_V1=1`.

**Extractor reindex rollback:** If the `is_exported` extractor change causes parsing regressions, revert the `EXTRACTOR_VERSIONS.typescript` bump in a hotfix release. Existing index persists; new symbols computed without `is_exported` flag. Module builder's fallback path handles missing flag. No user action required beyond upgrading.

**Hook binary:** V2 hook binary reads both v1 and v2 manifests. If wiki v2 content causes agent behavior regressions, users can downgrade the wiki content without touching the hook.

**Rollback boundaries:**
- ✅ Kill switch disables new generator; old generator produces old content.
- ✅ Extractor revert drops `is_exported`; module builder degrades gracefully.
- ❌ Cannot roll back dashboard code changes via env var — requires git revert + redeploy. Risk: low (dashboard renders v1 manifests by design).

## Backward Compatibility

**Manifest schema:**
- V1 manifests (no `schema_version` field): continue to work with v2 generator reading (for `slug_redirects` preservation) and v2 dashboard rendering (conditional features).
- V2 manifests: include `schema_version: 2`. Additive fields (`project`, `modules`) — v1 consumers ignore unknown fields.
- V1 generator can be forced via kill switch; v2 generator is default.

**Section headers in community pages:** Existing headers `## Files`, `## Hub Symbols`, `## Hotspots` are preserved. New headers `## Overview`, `## Key Exports`, `## Dependencies` prepended. External scrapers looking for existing headers continue to find them.

**Summary files (`.summary.md`):** Filename convention (`{slug}.summary.md`) unchanged. Content format extended from 4 lines to structured ~1200-char content. Old hook binaries reading these files see longer content; truncation at v1 budget (2000) still produces valid partial content.

**Hook environment variables:**
- `CODESIFT_READ_HOOK_MIN_LINES` — existing, unchanged.
- `CODESIFT_WIKI_SUMMARY_MAX_CHARS` — NEW, defaults to 2500. Honors old default if unset.

**CodeSymbol.is_exported:**
- Optional field (`is_exported?: boolean`). Absent on symbols from un-reindexed repos; present (true/false) on symbols from reindexed repos.
- Module builder's fallback path handles both cases.
- No breaking changes to existing CodeSymbol consumers.

**Dashboard:**
- `WikiManifest` type in dashboard extended with optional v2 fields.
- Rendering is conditional on `schema_version >= 2`. V1 manifests render with existing code paths.
- No breaking URL or routing changes.

**Deprecation timeline:**
- v2 release: both v1 and v2 code paths present. V2 default.
- +1 minor version: v1 generator functions removed. Kill switch no longer supported. Users who depend on v1 content remain on previous version.

## Out of Scope

### Deferred to v3 (future iteration)
1. **LLM-enhanced descriptions.** Optional `--enrich` flag that calls an LLM to rewrite template descriptions into more natural prose. Deferred because: template descriptions are the correctness baseline; LLM is enhancement that requires API keys, cost management, and non-reproducibility tolerance.
2. **`query_wiki` MCP tool.** Structured query interface for agents (`query_wiki(scope, name)`). Deferred because: reading manifest via Read works today; adding a tool requires discovery overhead. If v2 usage shows agents benefit from structured queries, add in v3.
3. **Per-workspace scripts in monorepo overview.** V2 shows root `package.json` scripts only. V3 would include per-workspace scripts and an aggregated "how to run this package" section.
4. **Architecture Mermaid diagram.** V2 "architecture" page uses narrative prose. V3 could render a Mermaid module dependency diagram embedded in markdown. Deferred because: requires dashboard Mermaid renderer integration (currently renders prose only).
5. **Framework conventions expansion for less-common stacks.** V2 covers NestJS, Next.js, Hono, Astro, React, Python (FastAPI/Django/Flask detection). V3 adds Ruby/Rails, Java/Spring, PHP/Laravel if usage data shows demand.
6. **`is_exported` for non-TypeScript extractors.** V2 adds the flag to TypeScript only. V3 propagates to JavaScript, Python, Go, Rust, Kotlin extractors. V2 fallback path handles missing flag across languages.
7. **Historical/diff view on dashboard.** Compare wiki between two git SHAs to see architectural evolution.

### Permanently out of scope
1. **Manual wiki editing.** Users do not edit `.codesift/wiki/*.md` files. Generated-only. Edits are overwritten on regeneration by design.
2. **Wiki as long-term persistence.** The wiki reflects the current state of the index. Historical snapshots are git's job.
3. **Remote wiki hosting.** The wiki is local-first. Hosting a shared wiki server is a separate product direction.

## Open Questions

All design decisions in scope are resolved. No open questions remain.

## Adversarial Review

**Ran:** 2026-04-20T05:16:27Z. **Providers:** codex-5.3, gemini, cursor-agent (3 independent reviews, claude host auto-excluded to prevent self-review).

### Critical findings — ALL FIXED in spec revision

1. **PageRank alone does not fix builtin contamination** (all 3 providers converged). If a project file defines a symbol named `map` AND has high PageRank, fake caller edges from regex-based `extractCallSites` still inflate its fan-in. **Fixed in D4** with three-layer approach: (1) update `extractCallSites` to detect method-call prefix (`.map()` vs `map()`) at the extraction layer, eliminating fake edges at the source; (2) PageRank for file-level structural ranking; (3) builtin blocklist as defense-in-depth, gated on file-rank to prevent over-filtering legitimate project symbols. AC-SHIP-1 rewritten to match.

2. **`is_exported` via `export_statement` ancestry misses modifier-based exports** (codex-5.3). `export const X`, `export class X`, `export function X` use modifiers, not wrapping `export_statement` nodes in tree-sitter TS grammar. **Fixed in D2** — definition extended to check BOTH ancestor `export_statement` AND `export` modifier child AND `default_export` classification. Fixture tests required to cover all 10+ syntaxes.

3. **Rollback produced v2 manifest despite v1 flag** (codex-5.3). Integration Points said "`buildWikiManifest` accepts and writes v2" but rollback requires v1 output. **Fixed in API Surface** — explicit `buildWikiManifestV1` writer function with distinct signature, documented as "invoked only when `CODESIFT_WIKI_V1=1` or `--v1` present."

4. **`is_exported` fallback used `from` list but should use `to` list** (gemini). Files that appear as `from` in import edges are importers; files appearing as `to` are the ones being imported (thus the ones with exports). **Fixed in Edge Cases** — fallback changed to `to` list.

5. **TOML/Makefile parsing not specified** (gemini). Spec referenced parsing `pyproject.toml`/`Cargo.toml`/`go.mod` but no parser dependency listed. Original revision hallucinated `@iarna/toml` as existing dep (verified: not present). **Fixed in Edge Cases** — regex-based extraction specified explicitly for the standard sections we need (`[package]`, `[project]`, `[dependencies]`). No new dependencies. Same approach `detectStack` already uses.

### Warning findings — ALL FIXED

6. **`modules_truncated` referenced but not in schema** (codex-5.3, cursor-agent). **Fixed** — added optional `modules_truncated?: boolean` and `truncation_reason?` to `WikiManifestV2`.

7. **AC-SHIP-1 regex false-positives on legitimate project symbols named `map`/`get`/etc.** (cursor-agent). **Fixed** — AC rewritten to combine file-rank check with blocklist rather than name-only regex.

8. **Dashboard has no failure mode for malformed/missing manifest** (codex-5.3, cursor-agent). **Fixed** — added two rows to Dashboard failure modes table.

9. **AC-SHIP-3 could fail on degenerate repos with zero communities** (cursor-agent). **Fixed** — AC amended to allow empty `modules[]` only when `communities.length === 0` with degraded reason.

10. **`graphology-metrics` dependency not listed** (cursor-agent). **Fixed** — added to `package.json` change row in Integration Points.

11. **Exports-based template contradiction** (gemini) — Edge Cases referenced it, D3 did not define it. **Fixed** — unified as part of D3 level 2 (dep-lookup uses export-name prefix clustering as secondary signal).

12. **Hook/manifest version-detection contradiction** (gemini) — Failure Modes said hook parses manifest, Backward Compat said hook reads `.summary.md`. **Fixed** — Hook failure mode rewritten: hook reads `.summary.md` directly (format-agnostic), no manifest parsing. Manifest-version detection is the dashboard's responsibility.

13. **Monorepo slug collisions** (gemini). **Fixed** — added Edge Cases row specifying workspace-prefix slug generation when `project_type === "monorepo"`.

14. **Architecture page has no content AC** (spec-reviewer from internal pass). **Fixed** — AC-SUCCESS-6 added.

### Info findings — accepted
- AC-SHIP-9(d) reference to "v1 hub rows" is acknowledged as a soft signal. The primary rollback checks (a/b/c) are structural (manifest field presence, section header presence). Item (d) is supplementary.
- AC-SUCCESS-4 tying to "≥10 community cards" is pinned to codesift-mcp which is the spec's canonical fixture. Not brittle across refactors since codesift-mcp has 20+ communities.

### Round 2 adversarial review (re-run after round 1 fixes) — findings addressed

15. **D2 Integration Points row described only `export_statement` ancestry, contradicting D2's three-rule definition** (codex-5.3). **Fixed** — Integration Points row for `typescript.ts` now explicitly lists all three rules (ancestor, modifier child, default_export).

16. **Empty import graph behavior contradicted between Edge Cases (fall back to classifySymbolRoles) and Failure Modes (emit empty page)** (codex-5.3). **Fixed** — both sections now agree: emit structural empty-state page, do NOT fall back to classifySymbolRoles (which would be misleading without graph anchor). Degraded reason `"import_graph_empty"`.

17. **Blocklist gate used "top-20 most-imported" in one place and `file_rank <= 20` in another** (codex-5.3). **Fixed** — standardized to `file_rank > 20` (PageRank `file_rank`) throughout.

18. **AC-SHIP-1 referenced manifest PageRank ranks not persisted in schema** (codex-5.3, cursor-agent). **Fixed** — AC-SHIP-1 rewritten into two tests: (a) synthetic unit test on `rankHubsByPageRank`, (b) integration test that reads `hubs.md` and checks blocklist. No manifest persistence required.

19. **AC-SHIP-9 assumed v1 rollback would reproduce original hub bug** (gemini). **Fixed** — AC-SHIP-9 re-scoped: Layer 1 fixes `extractCallSites` GLOBALLY, so v1 rollback ALSO gets the fix. Rollback validates schema + templates, not bug regression.

20. **AC-SHIP-1 "2x sanity bound" was an arbitrary heuristic** (gemini). **Fixed** — replaced with synthetic graph test + blocklist check.

21. **Non-JS dep parsing assumed `detectStack` does TOML content extraction** (gemini — verified: `detectStack` only detects file presence via `readJson` which fails silently on TOML). **Fixed** — Edge Cases rewritten to specify regex-based extraction narrowly scoped to `[package]` / `[project]` sections, with explicit out-of-scope list (tables-in-tables, array of tables, requirements.txt version ranges). Any regex failure → null field, not exception.

22. **`is_exported` fallback required "top-level" filter that CodeSymbol cannot provide** (gemini). **Fixed** — fallback updated: filter by CALLABLE_KIND (function/class/type/interface/component/hook) instead of lexical depth. Top-5 by caller fan-in.

23. **PageRank NaN check was dead code** (gemini). **Fixed** — Failure Modes updated: pre-filter by edge-count ≥1 before calling `pagerank()`. `graphology-metrics` distributes rank across disconnected components natively.

24. **Method-call detection didn't cover optional chaining / bracket notation** (gemini). **Fixed** — D4 Layer 1 now explicitly lists: (a) dot-prefix (handled), (b) optional chaining `?.` (handled), (c) bracket notation `["map"]` (documented as out-of-scope known residual for v2).

25. **AC-SHIP-2 banned v1 boilerplate globally but AC-SHIP-9 requires v1 rollback to produce it** (cursor-agent). **Fixed** — AC-SHIP-2 scoped to `schema_version === 2` outputs only; v1 rollback exempted.

26. **AC-SHIP-3 "communities.length === 0" condition was ambiguous after filtering** (cursor-agent). **Fixed** — AC-SHIP-3 explicitly defines "community count" as "post-filter communities", requires `"no_modules_after_filter"` degraded reason when empty.

27. **"No changes to CodeSift index schema" claim was wrong** (cursor-agent). **Fixed** — replaced with precise summary: additive optional field + TS extractor version bump.

28. **AC-SHIP-5 excerpt distinctness might fail on small repos** (cursor-agent). **Fixed** — requires fixture with ≥5 modules, uses `min(modules.length, 5)` threshold.

### Remaining provider comments — accepted with rationale
- Some success criteria (manual review of descriptions, screenshot comparison) retain subjective elements. Accepted because: (a) they are SUCCESS criteria, not ship criteria; (b) parallel objective ship criteria (AC-SHIP-1/2/5/6) mechanically verify the same outcomes; (c) user-visible quality is genuinely subjective and a pure automated check cannot validate "looks useful to humans."
- The v2 spec does not promise comprehensive TOML parsing. This is explicit and documented in Edge Cases and Out of Scope. Full TOML compliance is a future iteration item if usage demands it.

**Final status:** All critical findings addressed across 2 adversarial rounds. All warnings either fixed or explicitly accepted with rationale. Spec ready for Approved status.

