# Astro Deep Support for CodeSift MCP — Design Specification

> **spec_id:** 2026-04-11-astro-deep-support-2017
> **topic:** Astro Deep Support for CodeSift MCP
> **status:** Approved
> **created_at:** 2026-04-10T20:17:12Z
> **approved_at:** 2026-04-10T20:33:31Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift is a 72-tool MCP server for code intelligence. Its current Astro support is a ~117-line regex-based extractor that covers only the frontmatter section of `.astro` files. The extractor has at least 10 active defects (wrong `end_line`, missing `tokens`, fragile CRLF/BOM handling, HTML source pollution for template-only files, `kind: "function"` search pollution) and the rest of the 72-tool system is completely blind to Astro conventions:

- `analyzeProject()` returns `status: "partial"` for every Astro project (no Astro branch in the orchestrator).
- `trace_route` has no Astro handler — Astro's file-based routing is invisible.
- `BUILTIN_PATTERNS` has zero Astro patterns, so anti-pattern detection on Astro projects is not possible.
- `import-graph.ts` does not normalize `.astro` extensions, so community detection, impact analysis, and call chain tracing silently drop `.astro`-to-`.astro` edges.
- `framework-detect.ts` knows nothing about Astro, so dead-code analysis flags `getStaticPaths` and `prerender` as unused.
- `.mdx` files are entirely unindexed (not in `EXTENSION_MAP`).

**Competitive landscape**: No other code intelligence MCP server (Serena 22.5K★, jcodemunch 1.5K★, codedb, CKB, CodeGraph) supports Astro. The three existing Astro-specific MCP servers (`withastro/docs-mcp`, `morinokami/astro-mcp`, `tryastro.app`) do runtime introspection only — they require a running dev server and do not provide static code intelligence. CodeSift is uniquely positioned to be the first and only static code intelligence tool for Astro.

**Who is affected**: Every developer working on an Astro project who uses CodeSift. Without deep Astro support, agents either produce incorrect results (wrong line numbers, missing references, silent edge drops in community detection) or admit ignorance (`status: "partial"` on `analyze_project`).

**What happens if we do nothing**: CodeSift remains competitive on general code intelligence but loses the opportunity to be the definitive tool for a fast-growing framework ecosystem. The existing bugs in `extractAstroSymbols` continue to produce wrong results silently, eroding trust in other CodeSift tools on Astro codebases.

## Design Decisions

| # | Decision | Chosen | Alternatives considered | Rationale |
|---|----------|--------|------------------------|-----------|
| D1 | Scope of v1 | Full Option C (7 items: extractor overhaul + 4 new tools + 3 extensions) | A (foundation-only), B (foundation + 2 tools) | User prefers complete vision shipped in one release |
| D2 | Template parsing strategy | Hybrid — regex-based `parseAstroTemplate()` with stable interface; WASM upgrade path as v2 | A (regex-only), B (tree-sitter WASM now) | Unverified WASM availability from `virchau13/tree-sitter-astro`; regex is expected to parse ~90% of real-world `.astro` files without degraded confidence (file-level coverage metric). Within successfully parsed files, precision/recall on island detection is expected to be much higher — see Success Criterion 1 for measurement thresholds |
| D3 | Symbol format migration | Auto re-index on `EXTRACTOR_VERSIONS["astro"]` bump | A (silent upgrade), C (warn only) | Astro projects are small (20-200 files); stale bugs are worse than one-time 1-3s delay; establishes pattern for future extractor bumps |
| D4 | `astro.config.mjs` parsing | AST walk via existing `tree-sitter-javascript.wasm` with `config_resolution` honesty field | A (regex), C (execute) | Zero new dependencies; distinguishes static from dynamic values honestly; rejects execution for security |
| D5 | Code organization | Feature-split: 1 shared parser + 3 tool files | 1 (monolithic astro-tools.ts), 3 (extend-first) | Matches codebase convention (route-tools, pattern-tools, audit-tools); focused test files; reusable `parseAstroTemplate()` |
| D6 | New `SymbolKind` | Add `"component"` to the union | Keep `"function"` | Current usage pollutes `search_symbols(kind: "function")` results; `"component"` is semantically correct |
| D7 | Tool visibility | All 4 new tools in `CORE_TOOL_NAMES` | Hidden behind `discover_tools` | Option C's intent is discoverable Astro capabilities; core tools are more valuable for agents |

## Solution Overview

The implementation is split into three layers:

**Layer 1 — Foundation (existing files, bug fixes + extensions)**
- `src/parser/extractors/astro.ts` — fix 10 bugs, integrate `parseAstroTemplate()`, extract SSR endpoints, `getStaticPaths`, `prerender`
- `src/utils/import-graph.ts` — normalize `.astro` extensions
- `src/tools/framework-detect.ts` — add Astro detection + entry-point rules
- `src/parser/parser-manager.ts` — map `.mdx` → `"markdown"`
- `src/tools/project-tools.ts` — add `EXTRACTOR_VERSIONS["astro"]`, Astro branch in `analyzeProject()`
- `src/tools/route-tools.ts` — add `findAstroHandlers()`
- `src/tools/pattern-tools.ts` — add 6 Astro built-in patterns
- `src/types.ts` — add `"component"` to `SymbolKind`, extend `RouteHandler.framework` union

**Layer 2 — Shared template parser (new module)**
- `src/parser/astro-template.ts` — exports `parseAstroTemplate()`: the single source of truth for extracting islands, slots, component usages, and directives from `.astro` template sections

**Layer 3 — New tools (new modules)**
- `src/tools/astro-islands.ts` — `astro_analyze_islands`, `astro_hydration_audit`
- `src/tools/astro-routes.ts` — `astro_route_map`
- `src/tools/astro-config.ts` — `astro_config_analyze`, `extractAstroConventions()` (also consumed by `project-tools.ts`)

**Cache invalidation flow**: On index load, `getCodeIndex()` compares the stored `EXTRACTOR_VERSIONS` snapshot against the current constant. If `astro` version differs, all `.astro` files are re-extracted before serving queries. A one-time log message announces the migration. The version snapshot is persisted after re-extract completes.

**Data flow for a new tool** (example: `astro_analyze_islands`):
1. Tool reads `CodeIndex` via `getCodeIndex(repo)`
2. Iterates `index.files` filtering `language === "astro"` under optional `path_prefix`
3. For each file, reads source, calls `parseAstroTemplate(source, frontmatterImports)` where `frontmatterImports` comes from the indexed symbols
4. Aggregates all `Island[]` results, groups by directive/framework, computes summary stats, applies recommendation heuristics
5. Returns structured JSON

## Detailed Design

### Data Model

**New types in `src/types.ts`:**

```typescript
export type SymbolKind =
  | "function" | "class" | "method" | "variable" | "constant"
  | "type" | "interface" | "enum" | "namespace" | "module"
  | "property" | "test" | "test_suite" | "section" | "metadata"
  | "component";  // NEW — for Astro components and similar JSX-like units

export type RouteFramework =
  | "nestjs" | "nextjs" | "express" | "astro" | "unknown";  // "astro" added
```

**New interfaces in `src/parser/astro-template.ts`:**

```typescript
export interface AstroTemplateParse {
  islands: Island[];
  slots: Slot[];
  component_usages: ComponentUsage[];
  directives: Directive[];
  parse_confidence: "high" | "partial" | "degraded";
  scan_errors: string[];
}

export interface Island {
  component_name: string;
  directive: "client:load" | "client:idle" | "client:visible" | "client:media" | "client:only" | "server:defer";
  directive_value?: string;
  line: number;
  column: number;
  conditional: boolean;
  in_loop: boolean;
  uses_spread: boolean;
  resolves_to_file?: string;
  target_kind: "astro" | "framework" | "unknown";
  framework_hint?: "react" | "vue" | "svelte" | "solid" | "preact" | "lit";
  // Position fields required by AH04 (client-load-below-fold) heuristic:
  document_order: number;            // 0-based ordinal within the template (first island = 0)
  parent_tag?: string;               // immediate enclosing tag name in lowercase (e.g., "footer", "nav", "main")
  is_inside_section?: "header" | "footer" | "aside" | "nav" | "main" | null;  // nearest landmark ancestor
}

export interface Slot {
  name: string;
  line: number;
  has_fallback: boolean;
}

export interface ComponentUsage {
  name: string;
  line: number;
  imported_from?: string;
}

export interface Directive {
  name: string;
  value?: string;
  line: number;
  target_tag: string;
}

export function parseAstroTemplate(
  source: string,
  frontmatterImports?: Map<string, string>
): AstroTemplateParse;
```

**New interfaces in `src/tools/astro-config.ts`:**

```typescript
export interface AstroConventions {
  output_mode: "static" | "server" | "hybrid" | null;
  adapter: string | null;
  integrations: string[];
  site: string | null;
  base: string | null;
  i18n: {
    default_locale: string;
    locales: string[];
  } | null;
  redirects: Record<string, string>;
  config_resolution: "static" | "partial" | "dynamic";
  config_file: string | null;
  pages: Array<{
    path: string;
    route: string;
    rendering: "static" | "server";
    dynamic_params: string[];
    has_getStaticPaths: boolean;
  }>;
  islands_summary: {
    total: number;
    by_directive: Record<string, number>;
    by_framework: Record<string, number>;
  };
}
```

**Extractor symbol format changes** (breaking, managed via `EXTRACTOR_VERSIONS` bump):
- Function symbols: `end_line` reflects actual function span (was always `= start_line`)
- All symbols: `tokens` field populated via `tokenizeIdentifier()`
- Component symbol: `kind: "component"` (was `"function"`)
- Template-only files: `source` is sanitized (no raw HTML attribute noise)
- CRLF/BOM: normalized at entry before frontmatter regex
- `interface Props` AND `type Props = {...}` both recognized

**`EXTRACTOR_VERSIONS`** in `src/tools/project-tools.ts`:
```typescript
export const EXTRACTOR_VERSIONS = {
  stack_detector: "1.0.0",
  // ... existing entries ...
  "astro": "1.0.0",  // NEW
};
```

**`config_resolution` decision table** — canonical mapping used by both Edge Cases and Failure Modes. Implementer must use this single rule:

| Config file state | `config_resolution` value | `AstroConventions` fields populated |
|-------------------|--------------------------|-------------------------------------|
| All top-level fields (`output`, `adapter`, `integrations`, `site`, `base`, `i18n`, `redirects`) are literal values | `"static"` | All fields extracted from AST |
| AST parse succeeds but ≥1 field has non-literal value (ternary, identifier, spread, env var reference) | `"partial"` | Literal fields extracted; non-literal fields set to `null` (or empty array/object as appropriate) |
| AST parse fails entirely (syntax error, file not found, unsupported export form) | `"dynamic"` | All fields `null` or empty; only `config_file` path populated |

This table overrides any contradictory mapping elsewhere in the spec. EC-9 (i18n with ternary locales) and the `astro.config.mjs` failure mode row ("ternary/env vars") both resolve to `"partial"` per this table — not `"dynamic"`.

**`getStaticPaths` canonical detection forms** — implementer must match both:

```typescript
// Form 1: function declaration (most common)
export async function getStaticPaths() { ... }
export function getStaticPaths() { ... }

// Form 2: const arrow (valid Astro, seen in newer code)
export const getStaticPaths = async () => { ... };
export const getStaticPaths = () => { ... };
```

Both forms MUST be recognized by: extractor (symbol emission), route-tools (`findAstroHandlers`), pattern-tools (`astro-missing-getStaticPaths`). One conformance test per form required.

**Concurrent re-index locking** — `EXTRACTOR_VERSIONS` auto re-index uses a lockfile-based first-writer-wins strategy:

- Lockfile path: `<index-root>/.codesift/astro-reindex.lock`
- Acquire: `fs.openSync(path, "wx")` (exclusive create) — fails if file exists
- On failure: log "Re-index in progress by another session, skipping" and serve current index (stale until next load)
- Release: `fs.unlinkSync(path)` in `finally` block
- Stale lock cleanup: if lockfile mtime > 60s old, treat as orphan and overwrite
- After successful re-extract, write new version snapshot to `<index-root>/.codesift/extractor-versions.json` via atomic rename (`fs.writeFileSync(tmp)` + `fs.renameSync(tmp, final)`)

This prevents partial mixing of old+new symbol formats across concurrent sessions.

### API Surface

**4 new MCP tools** (added to `TOOL_DEFINITIONS` in `src/register-tools.ts`, all in `CORE_TOOL_NAMES`):

```typescript
// 1. astro_analyze_islands
{
  name: "astro_analyze_islands",
  category: "analysis",
  description: "Scan all .astro files for client:*/server:defer directives; report islands, hydration budget, and performance recommendations",
  schema: {
    repo: z.string().optional(),
    path_prefix: z.string().optional(),
    include_recommendations: z.boolean().default(true),
  },
  returns: {
    islands: Island[],
    summary: {
      total_islands: number,
      by_directive: Record<string, number>,
      by_framework: Record<string, number>,
      warnings: string[],
    },
    server_islands: Array<{ file: string; line: number; component: string; has_fallback: boolean }>,
  }
}

// 2. astro_hydration_audit
{
  name: "astro_hydration_audit",
  category: "analysis",
  description: "Detect hydration anti-patterns (AH01-AH12) across all .astro files: see Hydration Anti-Pattern Codes table below",
  schema: {
    repo: z.string().optional(),
    severity: z.enum(["all", "warnings", "errors"]).default("all"),
    path_prefix: z.string().optional(),
  },
  returns: {
    issues: Array<{
      code: string,               // AH01..AH12
      severity: "error" | "warning" | "info",
      message: string,
      file: string,
      line: number,
      component?: string,
      fix: string,
    }>,
    anti_patterns_checked: string[],
    score: "A" | "B" | "C" | "D",
  }
}

// 3. astro_route_map
{
  name: "astro_route_map",
  category: "navigation",
  description: "Complete route map from src/pages/: all routes with rendering mode (SSG/SSR), dynamic params, API endpoints, conflicts, and layout chains",
  schema: {
    repo: z.string().optional(),
    include_endpoints: z.boolean().default(true),
    output_format: z.enum(["json", "tree", "table"]).default("json"),
  },
  returns: {
    routes: Array<{
      path: string,
      file: string,
      type: "page" | "endpoint" | "layout",
      rendering: "static" | "server",
      dynamic_params: string[],
      has_getStaticPaths: boolean,
      methods?: string[],
      layout?: string,
    }>,
    warnings: string[],
    summary: {
      total_routes: number,
      static_pages: number,
      server_pages: number,
      api_endpoints: number,
      dynamic_routes: number,
    },
    virtual_routes_disclaimer: string[],
  }
}

// 4. astro_config_analyze
{
  name: "astro_config_analyze",
  category: "analysis",
  description: "Parse astro.config.(mjs|ts|cjs) and report project configuration: output mode, adapter, integrations, i18n, redirects, with honesty flag for dynamic values",
  schema: {
    repo: z.string().optional(),
  },
  returns: {
    conventions: AstroConventions,
    issues: Array<{
      code: string,
      severity: "error" | "warning" | "info",
      message: string,
    }>,
  }
}
```

**Hydration Anti-Pattern Codes (AH01-AH12):**

These are the full set of anti-patterns `astro_hydration_audit` detects. Each code has a canonical name, detection signal, severity, and fix guidance. Implementer must write one detector per row.

| Code | Name | Detection signal | Severity | Fix guidance |
|------|------|------------------|----------|--------------|
| AH01 | `client-on-astro-component` | Directive `client:*` on a component where `Island.target_kind === "astro"` (resolved via frontmatter imports map) | **error** | Remove `client:*` directive — Astro components cannot hydrate; convert to framework component if interactivity needed |
| AH02 | `island-in-loop` | Island where `Island.in_loop === true` (inside `{items.map(...)}`) | **warning** | Lift hydration boundary: wrap the loop in a single framework component instead of N islands |
| AH03 | `framework-component-without-directive` | Frontmatter import of a `.tsx`/`.vue`/`.svelte`/`.jsx` file used in template with NO `client:*` directive | **warning** | Either add `client:load|idle|visible` if interactivity needed, or remove the import (dead framework dependency) |
| AH04 | `client-load-below-fold` | Island with `client:load` where `Island.document_order > 3` OR `Island.is_inside_section` is one of `"footer"`, `"aside"`, `"nav"` | **warning** | Use `client:visible` or `client:idle` for below-fold components |
| AH05 | `client-only-missing-framework-hint` | `client:only` directive without a framework value (should be `client:only="react"`) | **error** | Add framework hint: `client:only="react"` (or vue/svelte/solid/preact/lit) |
| AH06 | `layout-wrapped-in-framework` | A layout file (`src/layouts/*.astro`) whose root non-whitespace tag is an uppercase framework component with a `client:*` directive | **warning** | Layouts should be Astro components; wrap only the interactive part in a framework island, not the whole layout |
| AH07 | `client-load-on-static-props` | Island with `client:load` whose props in template are all static literals (no dynamic expressions via balanced-brace detection) | **info** | No interactivity detected; consider `client:idle` or removing hydration entirely |
| AH08 | `multiple-frameworks-same-file` | A single `.astro` file imports components from 2+ different frameworks (e.g., both React and Vue) | **warning** | Consolidate to one framework per file to minimize bundle overhead |
| AH09 | `heavy-import-eager-hydration` | Island with `client:load` whose frontmatter import path (`imported_from` in `ComponentUsage`) matches a known-heavy npm package name: `react-chartjs-2`, `chart.js`, `recharts`, `@nivo/*`, `mapbox-gl`, `leaflet`, `monaco-editor`, `@monaco-editor/*`, `codemirror`, `@fullcalendar/*`, `react-big-calendar`, `three`, `@react-three/*`. Local component names (e.g., your own `Chart.tsx`) do NOT trigger this code — only imports from listed packages. | **info** | Use `client:visible` to defer heavy library until in-viewport |
| AH10 | `server-defer-without-fallback` | Component with `server:defer` directive where the enclosing tag has no `<slot name="fallback">` or default slot content | **warning** | Add fallback slot content for better perceived performance |
| AH11 | `transition-persist-without-props` | Component with `transition:persist` directive but no `transition:persist-props` | **info** | If the component holds prop-dependent state across navigation, add `transition:persist-props` to preserve it |
| AH12 | `dynamic-component-with-client` | `client:*` directive on a tag whose name starts with a lowercase letter or variable reference (`<Comp client:load/>` where `Comp` is not a capitalized import) | **warning** | Dynamic components cannot be statically analyzed for hydration; use a static component name or wrapper |

**A/B/C/D score calculation**:
- A: 0 errors, ≤2 warnings
- B: 0 errors, 3-5 warnings
- C: 1-2 errors, OR 6-10 warnings
- D: 3+ errors, OR 11+ warnings

**Extensions to existing tools** (no new MCP tools, richer results):

- `trace_route(path)` — now resolves Astro routes via `findAstroHandlers()` in `src/tools/route-tools.ts`
- `search_patterns(name)` — 6 new built-in Astro patterns in `BUILTIN_PATTERNS`:
  - `astro-client-on-astro` — client directive on `.astro` component (silent build error)
  - `astro-glob-usage` — deprecated `Astro.glob()`
  - `astro-set-html-xss` — `set:html` with dynamic content
  - `astro-img-element` — raw `<img>` instead of `<Image>` from `astro:assets`
  - `astro-missing-getStaticPaths` — dynamic route without `getStaticPaths`
  - `astro-legacy-content-collections` — `src/content/config.ts` (should be `src/content.config.ts`)
- `analyze_project()` — returns `astro_conventions` block + `status: "complete"` for Astro projects

### Integration Points

**Cross-cutting file modifications:**

| File | Change |
|------|--------|
| `src/types.ts` | Add `"component"` to `SymbolKind`; extend `RouteHandler.framework` union with `"astro"` |
| `src/parser/parser-manager.ts` | Add `.mdx` → `"markdown"` in `EXTENSION_MAP` |
| `src/parser/extractors/astro.ts` | Fix 10 bugs (end_line, tokens, CRLF/BOM, kind, source sanitization, type alias Props, nested interface, end_line for multiline functions); integrate `parseAstroTemplate()` for island extraction; detect `export const GET/POST/...`, `export const prerender`, `export async function getStaticPaths` |
| `src/parser/symbol-extractor.ts` | Add `case "astro"` to dispatch switch (currently falls through to generic) |
| `src/utils/import-graph.ts` | `resolveImportPath()` and `buildNormalizedPathMap()` strip `.astro` extension |
| `src/tools/framework-detect.ts` | Add `"astro"` to `detectFrameworks()`; add Astro entry-point rules to `isFrameworkEntryPoint()` |
| `src/tools/project-tools.ts` | Add `"astro": "1.0.0"` to `EXTRACTOR_VERSIONS`; add `else if (fw === "astro")` branch in `analyzeProject()` calling `extractAstroConventions()`; add Astro branch to `buildConventionsSummary()` |
| `src/tools/route-tools.ts` | Add `findAstroHandlers()`; invoke from `traceRoute()` dispatch; include `"astro"` in `RouteHandler.framework` values |
| `src/tools/pattern-tools.ts` | Add 6 Astro entries to `BUILTIN_PATTERNS` dict |
| `src/register-tools.ts` | Add 4 new `ToolDefinition` objects; add tool names to `CORE_TOOL_NAMES` |

**New files:**

| File | Purpose |
|------|---------|
| `src/parser/astro-template.ts` | Shared template parser (`parseAstroTemplate()`) — single source of truth for island/slot/component extraction |
| `src/tools/astro-islands.ts` | `astro_analyze_islands` + `astro_hydration_audit` tool handlers |
| `src/tools/astro-routes.ts` | `astro_route_map` tool handler |
| `src/tools/astro-config.ts` | `astro_config_analyze` tool handler + `extractAstroConventions()` (imported by `project-tools.ts`) |
| `tests/parser/astro-template.test.ts` | 25 test cases for template parser |
| `tests/parser/astro-extractor.test.ts` | 15 test cases for extractor (new file — currently none exist) |
| `tests/tools/astro-islands.test.ts` | 12 test cases for islands + hydration audit tools |
| `tests/tools/astro-routes.test.ts` | 10 test cases for route map tool |
| `tests/tools/astro-config.test.ts` | 10 test cases for config analyzer |
| `tests/fixtures/astro-project/` | Minimal real Astro project for integration test |

**Consumers of `parseAstroTemplate()`:**
1. `src/parser/extractors/astro.ts` — called during symbol extraction
2. `src/tools/astro-islands.ts` — walks all `.astro` files for tool output
3. `src/tools/astro-routes.ts` — uses parsed imports to build layout chains
4. `src/tools/pattern-tools.ts` — 6 new Astro patterns scan parsed results, not raw source

### Edge Cases

| Code | Edge case | v1 handling |
|------|-----------|-------------|
| EC-1 | Template-only `.astro` file (no `---`) | Emit 1 `component` symbol; sanitize source (strip HTML attr noise) |
| EC-2 | Frontmatter-only file (no template body) | Guard against zero-content function symbols |
| EC-3 | Nested `{items.map(i => <X client:load/>)}` | Balanced-brace counter; mark `in_loop: true`; `parse_confidence: "partial"` |
| EC-4 | Spread attributes `{...props}` | Detect and set `uses_spread: true` on Island; still count directive |
| EC-5 | String interpolation in attributes | Treat as computed; skip value extraction |
| EC-6 | Astro vs framework component | Resolve via `frontmatterImports` map; `.astro` → `target_kind: "astro"` (ERROR for client:*) |
| EC-7 | `.mdx` files using Astro components | Add `.mdx` → `"markdown"` in `EXTENSION_MAP`; frontmatter scan only; template body parsing deferred to v2 |
| EC-8 | Route conflicts `[slug]` vs `[...rest]` | Sort by specificity (static > named > rest); emit warning on prefix overlap |
| EC-9 | i18n routing | AST walk `astro.config.i18n` block; group locale variants; see `config_resolution` decision table below for how dynamic i18n values are classified |
| EC-10 | Virtual routes from integrations | Emit `virtual_routes_disclaimer` listing known integrations detected in `package.json` |
| EC-11 | Redirects in `astro.config` | AST walker extracts `redirects: {...}` literal; include in trace_route results |
| EC-12 | Conditional island `{show && <X client:load/>}` | Set `conditional: true` when directive is inside `{...}` starting with `&&`/`?` |
| EC-13 | Imported but not rendered | Two-pass scan: frontmatter imports diff against template JSX tags |
| EC-14 | Dynamic component `<Comp client:load/>` where `Comp` is a var | Flag `target_kind: "unknown"`, `resolves_to_file: null` |
| EC-15 | CRLF line endings + BOM | Normalize `\r\n` → `\n`, strip BOM at entry before frontmatter regex |
| EC-16 | `interface Props extends BaseProps` | Extend regex to accept `extends` clause |
| EC-17 | `type Props = {...}` alias | Add second regex pattern for type alias Props |
| EC-18 | Config file is `.ts` not `.mjs` | Fallback order: `.mjs` → `.ts` → `.cjs` |
| EC-19 | Path alias imports (`@components/...`) | V1 limitation: logged as unresolved; v2 will read `tsconfig.json` paths |

**v1 accepted limitations** (documented):
- EC-3 conditional inside nested `map`: detected but not fully classified
- EC-7 MDX template body: not parsed (frontmatter only)
- EC-14 dynamic components: flagged as unresolvable, not analyzed
- EC-19 path alias imports: logged as unresolved

### Failure Modes

#### `parseAstroTemplate()` (core template scanner)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Malformed HTML (unbalanced `{...}`) | Brace counter exceeds depth limit of 100 | Current file only | `parse_confidence: "degraded"`, partial Island list returned | Bail early; return what was parsed; `scan_errors` populated | Symbol emitted with degraded confidence flag | Immediate |
| Template >500KB | Size guard checked before scan | Current file only | `parse_confidence: "degraded"`, template scan skipped | Return frontmatter symbols only; log warning | Frontmatter symbols valid, template data missing | Immediate |
| HTML comment containing `<X client:load/>` | Comment stripper regex pre-pass before scan | All island analysis | False positive prevented (correct) | Strip `<!--...-->` regions before scanning | N/A | N/A |
| CRLF/BOM file | Normalize to `\n`, strip BOM at entry | All parse paths | None (fixed) | Normalization is first step in parse | N/A | N/A |
| Recursive nested expressions | Depth limit check | Current file | Degraded confidence; bail at depth 100 | Partial parse results | Scan errors logged | Immediate |

**Cost-benefit:** Frequency: occasional (1-5%) × Severity: medium (wrong analysis) × Mitigation: trivial → **Mitigate**

#### `astro.config.mjs` AST walker

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Config uses ternary/env vars | AST walker finds non-literal value | Config analysis only | `config_resolution: "partial"`, non-literal fields marked `null` | Literal fields still extracted per decision table | Partial conventions returned | Immediate |
| Config file is `.ts` (not `.mjs`) | Extension fallback: `.mjs` → `.ts` → `.cjs` | None | Found via fallback | Try each extension in order | N/A | Immediate |
| `tree-sitter-javascript` parse error | try/catch around AST parse | Config analysis only | `config_resolution: "dynamic"`, log warning | Fall back to empty `AstroConventions` | `status: "partial"` for analyze_project | Immediate |
| `defineConfig` aliased | Match by call expression name only | Config analysis only | Alias not followed, call missed | Log as v1 limitation; partial result | Partial | Immediate |
| Config file not found | `fs.existsSync` check | Config tool only | Returns empty `AstroConventions`, `config_file: null` | Graceful empty result | None | Immediate |

**Cost-benefit:** Frequency: occasional (~5%) × Severity: medium × Mitigation: trivial → **Mitigate with `config_resolution` honesty field**

#### `findAstroHandlers()` in route-tools

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Endpoint file is `.ts` not `.astro` | Walk includes `src/pages/**/*.{ts,js}` | `trace_route` completeness | Handler found | Scan both extensions | Full | Immediate |
| Dynamic route without `getStaticPaths` | Check for `export const getStaticPaths` | Route map accuracy | Warning in route map output | Emit warning; still include route | N/A | Immediate |
| Route path alias (`@pages/...`) | Import resolver doesn't handle alias | Import graph accuracy | Some imports unresolved | Log as unresolved (v1 limitation) | Partial | Immediate |
| Rest route `[...rest].astro` matches everything | Specificity ranking | Route conflicts | Route map ordered by priority | Static > named > rest | N/A | Immediate |

**Cost-benefit:** Frequency: occasional × Severity: low-medium × Mitigation: trivial → **Mitigate core; defer path alias to v2**

#### `EXTRACTOR_VERSIONS` auto re-index

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Re-index fails mid-way (I/O error) | try/catch in re-extract loop | Astro symbols only | Partial re-index; next load retries | Version snapshot not bumped until full success; retry on next load | Old + new symbols briefly mixed until retry | Next load |
| Large project (500+ files) slow first load | Measured at index load | First load only | One-time 3-10s delay with progress log | Progress log every 100 files; still serves queries during re-extract | N/A | Once |
| `EXTRACTOR_VERSIONS` snapshot not persisted | Snapshot written to index metadata after successful re-extract | None | Re-index runs every load (bug) | Persist snapshot atomically | Eventually consistent | Resolved after first successful persist |
| Concurrent re-extract (two CodeSift sessions) | File lock or atomic write | Index corruption risk | None | Atomic write of version snapshot | N/A | Immediate |

**Cost-benefit:** Frequency: rare (once per version bump) × Severity: low × Mitigation: trivial → **Mitigate**

#### `extractAstroSymbols()` (foundation fixes)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Frontmatter regex fails on edge format | `fmMatch === null` | Current file | Treated as template-only (existing fallback) | Existing fallback path | Symbol count = 1 | Immediate |
| `const` RHS matches pattern unexpectedly | Regex overshoots | Current file | Spurious variable symbol | V1 limitation; log if multiple matches on same line | Extra symbol | Immediate |
| `interface Props` with complex generics | Regex doesn't match | Current file | Props symbol missed | Fall through to no Props (existing behavior) | No Props symbol | Immediate |

**Cost-benefit:** Frequency: occasional × Severity: low × Mitigation: trivial → **Mitigate common cases; accept rare edge cases**

#### `src/utils/import-graph.ts` — `.astro` extension normalization

This component is explicitly called out in the Problem Statement as the source of silent `.astro`-to-`.astro` edge drops. Because the bug is silent by nature, the failure modes here need explicit guards.

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `.astro` double-stripped (`Card.astro` → `Card` → `Car`) | Unit test asserts idempotency: `normalize(normalize(path)) === normalize(path)` | Community detection, impact analysis, call chain | Wrong symbol links (`Card` resolves to unrelated file named `Car`) | Strip extension once using exact match (`path.endsWith(".astro")`) not regex | Stale edges in graph; silent | Caught only by dogfood on Astro-heavy repo |
| Aliased path (`@components/Card`) bypasses normalization | `resolveImportPath` returns unchanged path that doesn't exist in index | `.astro`-to-`.astro` edges | Edge silently dropped (existing v1 limitation) | Log unresolved as `v2-path-alias-limitation` counter | Edge missing | Immediate (logged counter) |
| Case-sensitivity mismatch (`Card.Astro` vs `card.astro`) | Normalize case before extension strip on macOS/Windows; preserve case on Linux | Cross-platform consistency | Wrong file matched on case-insensitive filesystems | Use `path.resolve()` + OS-aware case handling | Wrong edge | Immediate |
| Mixed extensions in same import (`./Card` could be `.ts` OR `.astro`) | Resolution order: `.ts` → `.tsx` → `.js` → `.jsx` → `.mjs` → `.cjs` → `.astro` | Import graph accuracy | First-match wins, may be wrong | Log ambiguous resolutions | First match wins | Immediate |

**Cost-benefit:** Frequency: frequent (every Astro project) × Severity: high (the silent-bug problem statement) × Mitigation: trivial (~20 LoC + idempotency test) → **Mitigate — this is the core reason the spec exists**

#### `src/tools/framework-detect.ts` — Astro detection

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Astro not in dependencies but `.astro` files present | Check both `package.json` deps AND file extension presence | `analyzeProject`, dead-code, hotspots | False negative: Astro classified as non-Astro | Dual-signal detection: package.json dep OR `.astro` file count > 0 | `status: "partial"` returned | Immediate |
| Astro dev dependency only | `package.json` `devDependencies` scan | Framework detection | Astro still detected (correct) | Scan both `dependencies` and `devDependencies` | Full | Immediate |
| Monorepo with Astro in subdir only | `analyzeProject` walks from project root | Framework detection | Astro missed if scanned from wrong root | Accept `path_prefix` parameter; scan all `package.json` files in subtree | Partial if wrong root | Immediate |
| `getStaticPaths` flagged as dead code pre-fix | `isFrameworkEntryPoint` checks for Astro page file pattern | Dead-code false positives | `find_dead_code` reports `getStaticPaths` as unused | Add Astro entry-point rules: `src/pages/**/*.astro`, `getStaticPaths`, `prerender`, `GET`, `POST`, etc. | False positive removed | Immediate |

**Cost-benefit:** Frequency: frequent (every Astro project) × Severity: medium (wrong downstream results, not crashes) × Mitigation: trivial → **Mitigate**

#### `src/parser/symbol-extractor.ts` — dispatch switch

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `case "astro"` missing from switch | Unit test asserts `extractSymbols(source, "astro", ...)` returns non-empty for known-good input | All Astro symbol extraction | Silent fall-through to `extractGenericSymbols` (empty or wrong symbols) | Add dispatch case; test asserts correct extractor invoked | Symbols wrong or missing | Caught by extractor test suite |
| Extractor throws during dispatch | try/catch in dispatch switch | Current file | Falls through to generic extractor; logged error | try/catch wraps extractor call; log error with file path | Symbols wrong for this file | Immediate (logged) |
| Multiple extractors both claim `.astro` | Single switch case per language | N/A (prevented by switch structure) | N/A | Switch structure prevents this | N/A | N/A |

**Cost-benefit:** Frequency: rare (once, if dispatch case is missed in implementation) × Severity: high (all Astro extraction silently broken) × Mitigation: trivial (one test) → **Mitigate via regression test**

## Acceptance Criteria

### Ship criteria (must pass for release)

**Must have:**

1. `extractAstroSymbols` correctly handles `\r\n` line endings and BOM-prefixed files without falling back to template-only mode.
2. Function symbols in Astro files have `end_line > start_line` for multi-line function bodies.
3. All Astro symbols (Props, const, function, component) have `tokens` field populated.
4. Component symbols use `kind: "component"` (new `SymbolKind` member).
5. Template-only `.astro` files emit exactly one `component` symbol with sanitized source.
6. `EXTRACTOR_VERSIONS` includes `"astro": "1.0.0"`.
7. On version mismatch at index load, all `.astro` files are auto re-extracted with a one-time log message.
8. `resolveImportPath()` and `buildNormalizedPathMap()` strip `.astro` extensions correctly.
9. `.mdx` files are mapped to `"markdown"` in `EXTENSION_MAP` and indexed.
10. `detectFrameworks()` returns `"astro"` for Astro projects; `isFrameworkEntryPoint()` correctly classifies Astro pages.
11. `analyzeProject()` returns `status: "complete"` with an `astro_conventions` block for Astro projects.
12. `trace_route("/blog/[slug]")` resolves Astro routes via `findAstroHandlers()` and surfaces associated symbols.
13. `parseAstroTemplate()` extracts all 6 directive types: `client:load`, `client:idle`, `client:visible`, `client:media`, `client:only`, `server:defer`.
14. `parseAstroTemplate()` distinguishes `.astro` targets (ERROR) from framework targets (legitimate islands) via `frontmatterImports` map.
15. `astro_analyze_islands` returns structured results with `summary`, `islands`, and `server_islands` fields.
16. `astro_hydration_audit` detects all 12 anti-pattern codes (AH01-AH12) with severity, file, line, and fix fields.
17. `astro_route_map` enumerates all `.astro` pages + `.ts/.js` endpoints under `src/pages/`, sorted by Astro route priority.
18. `astro_route_map` detects and reports route conflicts with specific warnings.
19. `astro_config_analyze` parses `.mjs`/`.ts`/`.cjs` config files via existing `tree-sitter-javascript.wasm`.
20. `astro_config_analyze` returns `config_resolution: "static"` for literal configs, `"partial"` for configs with some dynamic values, `"dynamic"` for configs that cannot be parsed statically.
21. `search_patterns` includes 6 new Astro built-in patterns: `astro-client-on-astro`, `astro-glob-usage`, `astro-set-html-xss`, `astro-img-element`, `astro-missing-getStaticPaths`, `astro-legacy-content-collections`.
22. Total test count: at least **87** new test cases across 5 new test files + extensions to 5 existing test files (per the Validation Methodology test distribution table). This is the authoritative count; any earlier mention of "74" is obsolete.
23. All 4 new tools are in `CORE_TOOL_NAMES` (visible in `ListTools`).
24. Tool count increases **total 72 → 76** AND **core 36 → 40** (all 4 new tools join `CORE_TOOL_NAMES`). Both deltas must be updated in all relevant documentation (`CLAUDE.md`, `src/instructions.ts`, `README.md`, website files). Verification: `grep -rn "72 tools\|72 MCP\|36 core" src/ ../codesift-website/src/` must return no stale occurrences before merge.

**Should have:**

1. `astro_hydration_audit` produces an A/B/C/D score based on issue counts.
2. `astro_analyze_islands` includes recommendations for each `client:load` flagged as potentially below-fold.
3. `astro_route_map` emits a `virtual_routes_disclaimer` listing integration-generated routes when those integrations are detected in `package.json`.
4. `astro_config_analyze` detects missing `site` URL and emits a warning.
5. `analyze_project` for an Astro repo produces an `AstroConventions` block including rendering strategy, integrations, island count, and route count.
6. The shared `parseAstroTemplate()` interface is stable enough that a future WASM upgrade can swap the implementation without changing consumers.

**Edge case handling:**

1. Template-only files produce a single component symbol with no HTML noise in source.
2. Frontmatter-only files do not emit zero-content function symbols.
3. Nested `{...}` expressions are handled via balanced-brace counting up to depth 100.
4. HTML comments containing `<X client:load/>` do not produce false-positive islands.
5. Route specificity ordering: static > named param > rest param.
6. Config file with ternary `output` value returns `config_resolution: "partial"` with `output_mode: null`.
7. `interface Props extends BaseProps` is recognized.
8. `type Props = {...}` alias is recognized.
9. CRLF-encoded files parse correctly.
10. BOM-prefixed files parse correctly.

### Success criteria (must pass for value validation)

1. **Quality — island detection accuracy**: Run `astro_analyze_islands` on 3 reference Astro projects (codesift-website, Astro starter-blog, Astro docs repo). Manually verify island list against source. Target: ≥90% precision and ≥90% recall on island detection.
2. **Quality — route map completeness**: Run `astro_route_map` on the same 3 reference projects. Manually enumerate expected routes. Target: ≥95% route coverage with zero incorrect rendering-mode classifications.
3. **Efficiency — analyze_project status**: Before: `analyze_project` on any Astro repo returns `status: "partial"` with empty Astro data. After: returns `status: "complete"` with populated `astro_conventions`. Measurable via one-command diff.
4. **Efficiency — trace_route coverage**: Before: `trace_route("/any/astro/route")` on an Astro project returns no handlers. After: returns the correct `.astro` page or endpoint file with line number. Measurable via integration test.
5. **Validation — hydration audit signal**: Run `astro_hydration_audit` on a fixture project with 5 known anti-patterns (one per AH01-AH05). Tool must detect all 5 with correct codes. Measurable via `tests/tools/astro-islands.test.ts`.
6. **Validation — CodeSift dogfood**: Run full CodeSift tool suite on codesift-website repo before and after the feature. Document observable improvements: `analyze_project` output size (before/after), `search_symbols` results for Astro components (before showed `kind: "function"`, after shows `kind: "component"`), `find_references` on shared components (before missed `.astro`-to-`.astro` edges, after finds them). Measurable via before/after JSON diff.

## Validation Methodology

**Automated unit tests** (Vitest, following `tests/parser/typescript-extractor.test.ts` pattern):

Test file counts and distribution:

| Test file | Purpose | Min test cases |
|-----------|---------|----------------|
| `tests/parser/astro-template.test.ts` | `parseAstroTemplate()` unit tests | 25 |
| `tests/parser/astro-extractor.test.ts` | `extractAstroSymbols()` unit tests (new) | 15 |
| `tests/tools/astro-islands.test.ts` | `astro_analyze_islands` + `astro_hydration_audit` | 12 |
| `tests/tools/astro-routes.test.ts` | `astro_route_map` + `findAstroHandlers` integration | 10 |
| `tests/tools/astro-config.test.ts` | `astro_config_analyze` + `extractAstroConventions` | 10 |
| `tests/parser/import-graph.test.ts` (existing, extended) | `.astro` normalization | 2 |
| `tests/tools/framework-detect.test.ts` (existing, extended) | Astro detection | 2 |
| `tests/tools/route-tools.test.ts` (existing, extended) | `findAstroHandlers` unit | 2 |
| `tests/tools/pattern-tools.test.ts` (existing, extended) | 6 Astro patterns | 6 |
| `tests/tools/project-tools.test.ts` (existing, extended) | Astro branch in analyzeProject | 3 |

**Total new test cases: ~87** across 5 new files + extensions to 5 existing files.

**Integration test** (single end-to-end):
- Fixture: `tests/fixtures/astro-project/` — minimal real Astro project:
  - `astro.config.mjs` with static output + react + tailwind integrations + i18n
  - `src/pages/index.astro` (static page)
  - `src/pages/blog/[slug].astro` (dynamic route with `getStaticPaths`)
  - `src/pages/api/data.ts` (server endpoint)
  - `src/layouts/BaseLayout.astro`
  - `src/components/Counter.tsx` (React island)
  - `src/components/Footer.astro`
  - `src/content.config.ts` (content collections)
- Integration test in `tests/integration/astro-pipeline.test.ts`:
  - `index_folder(fixture)` → assert indexed file count
  - `astro_analyze_islands` → assert 1 React island found (Counter with `client:visible`)
  - `astro_hydration_audit` → assert zero anti-patterns on clean fixture
  - `astro_route_map` → assert 3 routes (/, /blog/[slug], /api/data) with correct rendering modes
  - `astro_config_analyze` → assert `config_resolution: "static"`, 2 integrations, i18n extracted
  - `analyze_project` → assert `status: "complete"` with `astro_conventions` populated
  - `trace_route("/api/data")` → assert handler found at `src/pages/api/data.ts`
  - `search_symbols("Footer")` → assert the `.astro` result has `kind: "component"` (Footer.astro is an Astro component; Counter.tsx remains `kind: "function"` since the TS extractor is unchanged — the new SymbolKind only applies to `.astro` files)

**Manual validation** (post-implementation, pre-ship):
- Run full feature on `../codesift-website` (a real Astro project)
- Document before/after output of `analyze_project` → status changes from `"partial"` to `"complete"`
- Document before/after output of `search_symbols` on Astro component names → kind changes from `"function"` to `"component"`
- Run `astro_analyze_islands` → manually verify island count against source grep
- Run `astro_hydration_audit` → file any false positives/negatives as follow-up issues

**Measurement script** (`scripts/validate-astro-support.sh`) — full definition, not a stub:

```bash
#!/usr/bin/env bash
# Usage: ./scripts/validate-astro-support.sh <path-to-astro-repo> <snapshot-dir>
# Exits 0 if all metrics meet thresholds, 1 otherwise.
# Prints a TSV metrics report to stdout and appends to scripts/validate-astro-support.log.

set -euo pipefail
REPO_PATH="${1:?repo path required}"
SNAPSHOT_DIR="${2:-tests/fixtures/astro-snapshots/$(basename "$REPO_PATH")}"
THRESHOLD_PRECISION=0.90
THRESHOLD_RECALL=0.90
THRESHOLD_ROUTE_COVERAGE=0.95

# 1. Index the repo via MCP
node dist/cli.js index --path "$REPO_PATH"

# 2. Call each tool, capture JSON output
node dist/cli.js call astro_analyze_islands --repo "$(basename "$REPO_PATH")" > /tmp/islands.json
node dist/cli.js call astro_route_map --repo "$(basename "$REPO_PATH")" > /tmp/routes.json
node dist/cli.js call astro_config_analyze --repo "$(basename "$REPO_PATH")" > /tmp/config.json
node dist/cli.js call astro_hydration_audit --repo "$(basename "$REPO_PATH")" > /tmp/audit.json

# 3. Compare against manually curated snapshots
#    Each snapshot file is a hand-verified expected output — ground truth.
#    Snapshots live in tests/fixtures/astro-snapshots/<repo-name>/expected-*.json
ACTUAL_ISLANDS=$(jq '.islands | length' /tmp/islands.json)
EXPECTED_ISLANDS=$(jq '.islands | length' "$SNAPSHOT_DIR/expected-islands.json")

# Compute precision + recall by file+line+directive tuple set comparison
PRECISION=$(node scripts/compute-set-metrics.js precision /tmp/islands.json "$SNAPSHOT_DIR/expected-islands.json")
RECALL=$(node scripts/compute-set-metrics.js recall /tmp/islands.json "$SNAPSHOT_DIR/expected-islands.json")

# Route coverage: fraction of snapshot routes that appear in actual output
ROUTE_COVERAGE=$(node scripts/compute-set-metrics.js coverage /tmp/routes.json "$SNAPSHOT_DIR/expected-routes.json")

# 4. Report + threshold check
printf "metric\tvalue\tthreshold\tstatus\n"
printf "island_precision\t%s\t%s\t%s\n" "$PRECISION" "$THRESHOLD_PRECISION" "$(awk -v v="$PRECISION" -v t="$THRESHOLD_PRECISION" 'BEGIN{print (v>=t)?"PASS":"FAIL"}')"
printf "island_recall\t%s\t%s\t%s\n" "$RECALL" "$THRESHOLD_RECALL" "$(awk -v v="$RECALL" -v t="$THRESHOLD_RECALL" 'BEGIN{print (v>=t)?"PASS":"FAIL"}')"
printf "route_coverage\t%s\t%s\t%s\n" "$ROUTE_COVERAGE" "$THRESHOLD_ROUTE_COVERAGE" "$(awk -v v="$ROUTE_COVERAGE" -v t="$THRESHOLD_ROUTE_COVERAGE" 'BEGIN{print (v>=t)?"PASS":"FAIL"}')"

# 5. Exit code
awk -v p="$PRECISION" -v r="$RECALL" -v c="$ROUTE_COVERAGE" -v tp="$THRESHOLD_PRECISION" -v tr="$THRESHOLD_RECALL" -v tc="$THRESHOLD_ROUTE_COVERAGE" \
  'BEGIN{exit (p>=tp && r>=tr && c>=tc) ? 0 : 1}'
```

Supporting script `scripts/compute-set-metrics.js` — computes precision/recall/coverage by comparing two JSON arrays using a tuple key:

```javascript
// scripts/compute-set-metrics.js
// Usage: node compute-set-metrics.js <precision|recall|coverage> <actual.json> <expected.json>
// Tuple key for islands: `${file}:${line}:${directive}:${component_name}`
// Tuple key for routes: `${path}:${rendering}`
// Prints single float to stdout.
```

**Reference snapshot creation protocol** (one-time, before shipping):

For each of the 3 reference repos (`../codesift-website`, `astro/starter-blog`, `astro/docs`):
1. Clone or identify local path
2. Manually grep source for `client:` directives → record file, line, directive, component name → save as `tests/fixtures/astro-snapshots/<repo>/expected-islands.json`
3. Manually enumerate routes by walking `src/pages/` → record path, rendering mode → save as `tests/fixtures/astro-snapshots/<repo>/expected-routes.json`
4. Commit snapshots. These become the ground truth for the validate script.

**Traceability matrix** — success criteria → validation step → output:

| Success criterion | Validation step | Output signal |
|-------------------|-----------------|---------------|
| 1. Island detection ≥90% precision/recall | `./scripts/validate-astro-support.sh ../codesift-website` with snapshot at `tests/fixtures/astro-snapshots/codesift-website/` | `island_precision PASS/FAIL`, `island_recall PASS/FAIL` lines in TSV output; exit code 0/1 |
| 2. Route map ≥95% coverage | Same script, reads `expected-routes.json` snapshot | `route_coverage PASS/FAIL` line in TSV output; exit code 0/1 |
| 3. `analyze_project` status = complete | `diff <(mcp call analyze_project) expected-analyze-project.json` | Shell `diff` exit code + `.status` field equals `"complete"` |
| 4. `trace_route` coverage | Integration test in `tests/integration/astro-pipeline.test.ts` — assertion that `trace_route("/api/data")` returns non-empty | Vitest `expect(...).toBeDefined()` pass/fail |
| 5. Hydration audit signal | `tests/tools/astro-islands.test.ts` — fixture with 5 known anti-patterns (AH01-AH05) | Vitest assertion: all 5 codes appear in `issues[]` |
| 6. Dogfood before/after | Manual: run `analyze_project` on codesift-website pre- and post-feature; JSON diff | Human review + committed diff in PR description |

This script (`validate-astro-support.sh`) is a prerequisite for implementation, not a deliverable — it must exist with a working body before the first tool ships so success can be measured objectively. The script and its supporting `compute-set-metrics.js` are listed in the spec's integration point table and must be written as part of the first implementation task.

## Rollback Strategy

**Kill switch mechanism:**

1. **Tool-level rollback**: Remove tool names from `CORE_TOOL_NAMES` in `src/register-tools.ts`. Tools still exist but hide from `ListTools`. Single-line change per tool. No data loss.
2. **Extension rollback**: Comment out `findAstroHandlers()` invocation in `traceRoute()` dispatch → `trace_route` reverts to previous behavior (no Astro routes but no crash).
3. **Pattern rollback**: Remove 6 new entries from `BUILTIN_PATTERNS` dict. `search_patterns` existing patterns unaffected.
4. **Extractor rollback**: Cannot fully roll back (foundation fixes are bug fixes). Partial rollback possible by reverting `parseAstroTemplate()` integration while keeping the bug fixes.
5. **`EXTRACTOR_VERSIONS` rollback**: Revert `astro` entry. Next index load triggers re-extract with old logic — idempotent.

**Fallback behavior:**

- If `parseAstroTemplate()` throws unhandled, caller catches and falls back to regex-only extraction (existing behavior)
- If `findAstroHandlers()` returns empty, `trace_route` continues with other framework handlers (no crash)
- If `extractAstroConventions()` throws, `analyzeProject()` catches and falls back to `status: "partial"` (existing behavior)
- If auto re-index fails mid-way, next load retries (idempotent)

**Data preservation:**

- No data loss on rollback — index files are regenerated from source on next load
- User source code is read-only; never modified
- `EXTRACTOR_VERSIONS` snapshot is stored in index metadata, not in git-tracked files

**Rollback smoke test:**

Before shipping, verify:
1. Revert the entire feature branch locally → `npm run build` succeeds → existing tests pass → existing tool behavior preserved (except the pre-existing bugs remain).
2. Disable only the 4 new tools via `CORE_TOOL_NAMES` removal → `ListTools` shows 72 tools → Astro-aware extensions (extractor fixes, framework-detect, analyze_project branch, trace_route extension, pattern-tools extensions) still work.

## Backward Compatibility

**Breaking:**

1. **Symbol kind change**: Astro components now use `kind: "component"` instead of `kind: "function"`. Consumers that filter `search_symbols(kind: "function")` expecting to see Astro components will no longer see them. Mitigation: `EXTRACTOR_VERSIONS` bump forces re-extract. Downstream tools (pattern search, find_references) work with either kind.

2. **Function `end_line` change**: Multi-line Astro frontmatter functions had `end_line === start_line` (bug). Now correct. Consumers that rely on zero-height function spans will see accurate spans.

3. **Tokens field now populated**: Symbols previously had empty or missing `tokens` field on Astro symbols. BM25 search recall will increase. No consumer relies on empty tokens.

4. **Symbol source content**: Template-only files previously had raw HTML as symbol source. Now sanitized. BM25 recall on Astro components changes (both positive and negative) — users may see different search results for Astro-related queries.

5. **`.mdx` files are now indexed**: Previously unindexed. Users who expected `.mdx` to be ignored will see new search results from `.mdx` content.

6. **`.astro` extensions normalized in import graph**: Community detection, impact analysis, and call chain tracing will now include `.astro`-to-`.astro` edges. Results will differ from previous versions for Astro-heavy repos.

**Non-breaking (additive):**

1. New MCP tools (`astro_analyze_islands`, `astro_hydration_audit`, `astro_route_map`, `astro_config_analyze`) are additive — no existing tool signatures change.
2. `RouteHandler.framework` union extension (`"astro"` added) is additive. Existing consumers that pattern-match on the union get an unknown variant but don't crash.
3. `BUILTIN_PATTERNS` gains 6 new entries. Existing patterns unchanged.
4. `EXTRACTOR_VERSIONS` gains `"astro"` entry. Existing entries unchanged.
5. `CORE_TOOL_NAMES` gains 4 new names. Existing tools stay core.

**Migration path:**

- **Users on current → next**: Transparent. First index load detects `EXTRACTOR_VERSIONS["astro"]` mismatch, triggers auto re-extract of all `.astro` files with one-time log message. Subsequent loads fast.
- **Users downgrading next → current**: Previous version sees mismatch and re-extracts with old logic. Old symbol format restored. Round-trip is lossless (index is ephemeral).

**Config files affected:**

- `CLAUDE.md` — update tool count from 72 → 76, update architecture summary
- `src/instructions.ts` — update CODESIFT_INSTRUCTIONS with Astro tool summary (if tool count mentioned)
- `README.md` — update tool count
- Website files in `../codesift-website/` — tool count updates (deferred to follow-up PR per CLAUDE.md checklist)

## Out of Scope

### Deferred to v2

1. **Tree-sitter Astro WASM grammar**: Current implementation uses regex-based `parseAstroTemplate()`. A WASM upgrade would unlock accurate template AST (resolves EC-3, EC-12, EC-14 fully). Deferred because `tree-sitter-astro` WASM availability is unverified and the regex approach covers ~90% of real-world files. The `parseAstroTemplate()` interface is designed to be swap-able.

2. **Path alias resolution (`@components/...`)**: V1 logs unresolved aliases; V2 will read `tsconfig.json` `paths` config to resolve them in `import-graph.ts`. Deferred because it affects multiple extractors, not just Astro.

3. **MDX template body parsing**: V1 indexes `.mdx` frontmatter only. V2 will parse the MDX template body for Astro component usage. Deferred because MDX has its own AST requirements separate from `.astro`.

4. **LSP bridge for Astro (`@astrojs/language-server`)**: Would unlock go-to-definition, find-references, rename, diagnostics for Astro files. Deferred because LSP integration is a separate subsystem and the static analysis provides 80% of the value.

5. **Astro Actions analysis tool** (`astro_action_map`): Astro Actions are a newer feature with smaller user base. Deferred to next iteration.

6. **Content Collections schema analysis** (`astro_analyze_collections`): Parsing `src/content.config.ts` Zod schemas and cross-collection references. Deferred because content collection coverage is a large subfeature worth its own spec.

7. **View Transitions audit** (`astro_transition_audit`): `transition:name` consistency checks, `transition:persist` analysis. Niche feature; deferred.

8. **Slot analysis tool** (`astro_slot_analysis`): Named slot definitions vs consumer usage. Narrow scope; can be achieved via existing `search_text` + `parseAstroTemplate()` output in v1.

9. **Component dependency graph** (`astro_component_graph`): Extension of `detect_communities` with Astro layout chain awareness. Depends on v2 path alias resolution.

10. **Migration checker** (`astro_migration_check` v4→v5→v6): Breaking change detection for Astro version upgrades. Useful but not foundational.

### Permanently out of scope

1. **Running Astro's build or dev server**: CodeSift is a static analysis tool. Runtime introspection belongs to `morinokami/astro-mcp` and `tryastro.app`.

2. **Bundling/minification analysis**: Bundle size estimation requires running Rollup/Vite. Out of scope for static analysis.

3. **SSR runtime behavior prediction**: Cannot predict what `Astro.request.headers` will look like without running. Static analysis surfaces the *presence* of SSR features, not their runtime semantics.

4. **Automatic code fixes**: Hydration audit reports issues; it does not apply fixes. Auto-fixes would require write access and a separate refactoring subsystem.

5. **Visual regression or accessibility testing**: Belongs to Playwright-based tools, not static code intelligence.

6. **Integration with Astro compiler (`@astrojs/compiler`)**: The official compiler is a ~1MB WASM dependency. Not a good fit for a lightweight MCP server.

## Open Questions

The following items were surfaced during adversarial review (cross-provider validation). They are NOT implementation blockers but should be resolved during `zuvo:plan` or noted as accepted v1 limitations.

1. **External consumer impact of `SymbolKind = "component"`**: Any downstream client (other MCP servers, notebooks, scripts) that pattern-matches on `SymbolKind` enum values will encounter an unknown variant. CodeSift has no published external API version bump mechanism today. Decision needed: bump a package `minor` version and add a changelog note, OR add a legacy compatibility mode that re-maps `"component"` to `"function"` for older clients via a flag. Recommendation: bump minor, add changelog, accept that strict external consumers need updating.

2. **`parseAstroTemplate()` interface stability test**: Acceptance criterion "stable for future WASM swap" is soft. Concrete check: snapshot the exported type signature (`AstroTemplateParse`, `Island`, `Slot`, `ComponentUsage`, `Directive`) in a `.d.ts.snap` file under `tests/`. Any change to these types fails a snapshot test, forcing deliberate decision. Decision needed: add snapshot test now, or defer to first swap attempt.

3. **Offline/unavailable external reference repos for validation**: Success Criterion 1/2 run `validate-astro-support.sh` against `../codesift-website`, `astro/starter-blog`, `astro/docs`. In CI or offline environments these may be unavailable. Decision needed: (a) vendor frozen fixture copies into `tests/fixtures/astro-snapshots/` and mark external-repo validation as optional/informational; OR (b) gate the validate script on a `SKIP_IF_MISSING` env var so offline runs pass without the script.

4. **Per-file I/O performance for `astro_analyze_islands`**: The tool scans all `.astro` files and re-reads source on every call. Large Astro repos (500+ files) could hit measurable latency. Decision needed: (a) cache parsed `AstroTemplateParse` artifacts alongside symbols in the index, invalidated by file mtime; OR (b) add `max_files` guard (default 1000) and return warning when exceeded; OR (c) accept v1 I/O cost and measure before optimizing.

5. **Path alias resolution (`@components/...`)** — already documented as v2 deferral in Out of Scope, but flagged again here as a known v1 limitation users will encounter.

6. **`import-graph.ts` extension resolution order performance**: Walking `.ts → .tsx → .js → .jsx → .mjs → .cjs → .astro` for every unresolved import is O(imports × 7). Decision needed: pre-build a `basename → actual extension` map once per rebuild and look up O(1), OR cache extension-resolution results keyed by specifier. Recommendation: pre-built map (simpler).

7. **AH09 false-positive rate**: Even after the fix (npm-package-name matching, not local component names), new heavy libraries enter the ecosystem constantly. Decision needed: how to update the known-heavy list (hardcoded constant with version bump, or config file users can extend). Recommendation: hardcoded constant in v1, config file in v2.

These are deferred to `zuvo:plan` for scheduling.
