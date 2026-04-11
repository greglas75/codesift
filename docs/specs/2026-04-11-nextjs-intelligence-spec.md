# Next.js Framework Intelligence -- Design Specification

> **spec_id:** 2026-04-11-nextjs-intelligence-2017
> **topic:** Next.js Framework Intelligence
> **status:** Approved
> **created_at:** 2026-04-11T20:17:28Z
> **approved_at:** 2026-04-11T20:17:28Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift is a code-intelligence MCP server with 72 tools, but its Next.js support is fragmentary. Audit results show:

- **Parser level**: No detection of `"use client"`/`"use server"` directives. Cannot distinguish Server from Client components.
- **Route tracing**: `trace_route` handles App Router `route.ts` only. No middleware chain, no layout hierarchy, no Server Actions, no Pages Router support.
- **Pattern detection**: 4 basic Next.js patterns (quick wins D1-D5 already landed). Missing: fetch waterfalls, metadata gaps, unnecessary `"use client"`, `layout.tsx` client boundary violations, App Router convention mistakes.
- **Framework detection**: `detectFrameworks()` fires `nextjs` only when `app/api/route.ts` exists -- Pages Router projects and App Router projects without API routes are invisible. This is a latent bug with blast radius across `find_dead_code`, `analyze_project`, and any tool calling `isFrameworkEntryPoint`.
- **Monorepo**: File matchers assume single-project layout. Monorepos with `apps/web/` Next.js apps are not supported.
- **Rendering strategy**: Config exports (`dynamic`, `revalidate`, `generateStaticParams`) are recognized as names but their values are never read, so CodeSift cannot classify routes as SSG/SSR/ISR.

**Affected users**: Agents and developers using CodeSift to analyze Next.js codebases (App Router, Pages Router, or hybrid). The gap is especially acute for AI agents that depend on CodeSift to understand component boundaries, data flow, and rendering strategy -- information that is invisible to generic code-intelligence tools.

**If we do nothing**: CodeSift remains a generic TypeScript intelligence tool for Next.js projects, missing the framework-specific concepts that dominate real development work (server actions, boundary classification, rendering strategy, middleware). Competitors like Vercel's `next-devtools-mcp` require a running dev server; no static-analysis MCP server exists that handles Next.js properly. This is a clear competitive gap.

## Design Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Router scope | **Hybrid first-class** (App Router + Pages Router + hybrid projects) | Covers 100% of Next.js projects including active migrations. Pages Router is legacy but still ~30-40% of enterprise projects. |
| 2 | Blocker sequencing | **Foundation phase first** (dedicated pre-work PR) | Clean separation, bugs are fixed even if feature work slips, each feature PR starts from a clean base. |
| 3 | Classification accuracy | **Full AST (tree-sitter)** for `analyze_nextjs_components` | 99% accuracy, scope-aware (hooks in component body vs inner function), extensible, matches the `eslint-plugin-react-server-components` algorithm. |
| 4 | Monorepo handling | **Hybrid auto-detect + override** | Auto-detect via `next.config.*` discovery activates only when ≥2 configs found; `workspace` parameter for explicit override. Zero-config for single-app projects. |
| 5 | Delivery phasing | **5 sequential PRs** | Small reviews, each PR independently testable, incremental value delivery, can ship partial after any phase. |
| 6 | File organization | **Single `nextjs-tools.ts` + shared `utils/nextjs.ts`** | Consistent with existing codebase conventions (single-file tools), shared utils avoid duplication between `route-tools.ts` and `nextjs-tools.ts`. |
| 7 | Transitive client boundaries | **Out of scope for v1** | Re-exported client components via barrel files are not tracked. Documented limitation. v2 may add import-graph propagation. |
| 8 | Kill switch | **Per-tool `disable()` via env var** | `CODESIFT_DISABLE_TOOLS=analyze_nextjs_components,nextjs_route_map` bypasses registration. No rebuild needed. |

## Solution Overview

Five sequential PRs deliver hybrid-router Next.js intelligence on top of the existing CodeSift 72-tool architecture.

```
PR #1: Foundation (prerequisites)
  ├─ src/utils/framework-detect.ts  (broaden detectFrameworks, export constants)
  ├─ src/utils/nextjs.ts            (NEW: shared helpers)
  ├─ src/utils/walk.ts              (symlink traversal + cycle detection)
  └─ src/tools/project-tools.ts     (pages_router flag, 512-byte directive window)

PR #2: search_patterns extension
  └─ src/tools/pattern-tools.ts     (6 new Next.js patterns + router-type guard)

PR #3: trace_route extension
  ├─ src/tools/route-tools.ts       (middleware, layouts, server actions, Pages Router)
  └─ src/formatters.ts              (extended trace formatter)

PR #4: analyze_nextjs_components
  ├─ src/tools/nextjs-tools.ts             (NEW: AST-based Server/Client classifier)
  ├─ src/register-tools.ts                 (tool registration)
  ├─ src/formatters.ts                     (component report formatter)
  ├─ tests/tools/nextjs-tools.test.ts
  ├─ tests/fixtures/nextjs-app-router/     (NEW: 20+ component fixture)
  ├─ tests/fixtures/nextjs-app-router/expected.json  (frozen ground truth for SC1)
  ├─ scripts/validate-nextjs-accuracy.ts   (NEW: SC1 validator)
  └─ scripts/benchmark-nextjs-tools.ts     (NEW: SC3+SC4 benchmark)

PR #5: nextjs_route_map
  ├─ src/tools/nextjs-tools.ts             (add route-map function)
  ├─ src/register-tools.ts                 (tool registration)
  ├─ src/formatters.ts                     (route map formatter)
  ├─ src/formatters-shortening.ts          (compact/counts modes for large outputs)
  ├─ tests/tools/nextjs-tools.test.ts      (extended)
  ├─ tests/fixtures/nextjs-pages-router/   (NEW: Pages Router fixture)
  ├─ tests/fixtures/nextjs-hybrid/         (NEW: hybrid monorepo fixture)
  └─ scripts/validate-nextjs-route-count.ts (NEW: SC2 validator)
```

**Data flow for `analyze_nextjs_components`**:
```
user call
  → discover workspaces (next.config.* auto-detect OR explicit workspace param)
  → walk app/ + src/app/ for .tsx files
  → for each file:
      1. Fast-reject: read first 512 bytes, strip comments/BOM, check for "use client"/"use server" substring
      2. Parse file via tree-sitter TypeScript grammar (required for all files, not just directive matches)
      3. Confirm directive: if stage 1 matched, verify via AST that Program.body[0] is an ExpressionStatement with StringLiteral "use client" / "use server" -- reject if in conditional or nested scope
      4. Walk CallExpression for hooks (/^use[A-Z]/ + exclusion list)
      5. Walk JSXOpeningElement for event handlers (onClick, onChange, ...)
      6. Walk MemberExpression for browser globals (window, document, ...)
      7. Check for next/dynamic({ ssr: false }) -- import source literal match on "next/dynamic"
      8. Classify: server | client_explicit | client_inferred | ambiguous
      9. Detect unnecessary_use_client if directive confirmed but no client signals
  → return { files: [...], counts: {...}, parse_failures: [...], scan_errors: [...], truncated, workspaces_scanned: [...], limitations: [...] }
```

**Data flow for `nextjs_route_map`**:
```
user call
  → discover workspaces
  → walk app/ collecting page/layout/loading/error/route/not-found/default/template
  → walk pages/ collecting .tsx files + api/ + _app/_document/_error
  → for each route file:
      1. Derive URL path (strip route groups, translate [param])
      2. Parse file for route segment config exports (dynamic, revalidate, ...)
      3. READ VALUES via AST (not just symbol names)
      4. Classify rendering strategy (SSG | SSR | ISR | Edge | Client)
      5. Check metadata export (metadata | generateMetadata)
      6. Extract HTTP methods for route.ts files
      7. Walk ancestor layouts for layout_chain
  → check middleware.ts config.matcher for per-route coverage
  → detect hybrid conflicts (same route in both routers)
  → return { routes: [...], conflicts: [...], scan_errors: [...] }
```

## Detailed Design

### Data Model

**Extended `NextConventions` interface** (`src/tools/project-tools.ts`):
```typescript
export interface NextConventions {
  pages: {
    path: string;
    type: "page" | "layout" | "loading" | "error" | "not-found" | "global-error" | "default" | "template"
        | "app" | "document" | "error_page";  // Pages Router additions
  }[];
  middleware: {
    file: string;
    matchers: string[];  // populated by reading config.matcher
  } | null;
  api_routes: {
    path: string;
    methods: string[];   // populated by scanning exported HTTP method symbols
    file: string;
    router: "app" | "pages";
  }[];
  services_count: number;
  client_component_count: number;
  server_action_count: number;
  inngest_functions: string[];
  webhooks: string[];
  config: {
    app_router: boolean;
    pages_router: boolean;   // NEW
    src_dir: boolean;
    i18n: boolean;
  };
}
```

**Extended `RouteTraceResult` and `RouteHandler`** (`src/tools/route-tools.ts`):
```typescript
interface RouteHandler {
  // ... existing fields ...
  framework: "nestjs" | "nextjs" | "express" | "yii2" | "laravel" | "unknown";
  router?: "app" | "pages";  // NEW: only populated when framework === "nextjs"
}

interface RouteTraceResult {
  // ... existing fields ...
  middleware?: {
    file: string;
    matchers: string[];
    applies: boolean;  // whether matcher covers the traced path
  };
  layout_chain?: string[];  // root-to-segment, e.g. ["app/layout.tsx", "app/(auth)/layout.tsx"]
  server_actions?: {
    name: string;
    file: string;
    called_from: string;
  }[];
}
```

**Note on Pages Router path derivation**: `pages/api/users.ts` maps to URL path `/api/users` (stripping `pages/api/` prefix). When both routers define the same path, `trace_route` returns all matches and the caller disambiguates via the `router` field on each `RouteHandler`. Next.js itself prioritizes App Router at runtime, which CodeSift surfaces via the `conflicts` field in `nextjs_route_map`.

**New types** (`src/tools/nextjs-tools.ts`):
```typescript
export type ComponentClassification =
  | "server"
  | "client_explicit"       // has "use client" directive
  | "client_inferred"       // no directive but uses hooks/events/browser APIs
  | "ambiguous";

export interface NextjsComponentEntry {
  path: string;
  classification: ComponentClassification;
  directive: "use client" | "use server" | null;
  signals: {
    hooks: string[];           // e.g. ["useState", "useEffect"]
    event_handlers: string[];  // e.g. ["onClick", "onChange"]
    browser_globals: string[]; // e.g. ["window", "document"]
    dynamic_ssr_false: boolean;
  };
  violations: string[];  // e.g. ["unnecessary_use_client", "async_client_component"]
}

export interface NextjsComponentsResult {
  files: NextjsComponentEntry[];
  counts: {
    total: number;
    server: number;
    client_explicit: number;
    client_inferred: number;
    ambiguous: number;
    unnecessary_use_client: number;
  };
  parse_failures: string[];   // per-file errors: tree-sitter parse errors AND read permission errors
  scan_errors: string[];      // walk-level errors: symlink cycles, inaccessible directories, filesystem issues
  truncated: boolean;
  truncated_at?: number;
  workspaces_scanned: string[];
  limitations: string[];  // e.g. ["no transitive client boundary detection"]
}

export type RenderingStrategy =
  | "static"      // SSG
  | "ssr"         // force-dynamic or getServerSideProps
  | "isr"         // revalidate = N > 0
  | "edge"        // runtime = "edge"
  | "client"      // "use client" on page
  | "unknown";

export interface NextjsRouteEntry {
  url_path: string;           // e.g. "/products/[id]"
  file_path: string;          // e.g. "app/products/[id]/page.tsx"
  router: "app" | "pages";
  type: "page" | "route" | "layout" | "loading" | "error" | "not-found"
      | "default" | "template" | "global-error"
      | "parallel" | "intercepting"  // App Router organizational
      | "app" | "document" | "error_page";  // Pages Router special (_app, _document, _error)
  rendering: RenderingStrategy;
  config: {
    dynamic?: "auto" | "force-dynamic" | "force-static" | "error";
    dynamic_non_literal?: boolean;     // true if `dynamic = someVariable` or expression
    revalidate?: number | false;
    revalidate_non_literal?: boolean;  // true if `revalidate = 60 * 60` or identifier
    runtime?: "nodejs" | "edge";
    has_generate_static_params: boolean;
  };
  has_metadata: boolean;
  methods?: string[];  // for route.ts
  layout_chain: string[];
  middleware_applies: boolean;
  is_client_component: boolean;
}

export interface NextjsRouteMapResult {
  routes: NextjsRouteEntry[];
  conflicts: { url_path: string; app: string; pages: string }[];
  middleware: { file: string; matchers: string[] } | null;
  workspaces_scanned: string[];
  scan_errors: string[];
  truncated: boolean;
}
```

### API Surface

**`search_patterns` additions** (no API change, 6 new named patterns):
```
nextjs-fetch-waterfall         -- 2+ sequential await fetch() in server component
nextjs-missing-metadata        -- page.tsx without metadata or generateMetadata export
nextjs-unnecessary-use-client  -- "use client" without hooks/events/browser APIs
nextjs-pages-in-app            -- Pages Router convention files inside app/
nextjs-missing-error-boundary  -- page.tsx without sibling error.tsx
nextjs-use-client-in-layout    -- "use client" in layout.tsx
```

Existing `nextjs-wrong-router` gains a router-type guard: suppressed when file path matches `pages/`.

**`trace_route` extension** (non-breaking, new optional fields):
```typescript
trace_route(repo, path, output_format?)
  → result.middleware?.{ file, matchers, applies }
  → result.layout_chain?: string[]
  → result.server_actions?: { name, file, called_from }[]
```

**New tool: `analyze_nextjs_components`**:
```typescript
analyze_nextjs_components(repo, options?: {
  workspace?: string;          // e.g. "apps/web"
  file_pattern?: string;       // scope filter, e.g. "app/products/**"
  max_files?: number;          // default 2000
})
  → NextjsComponentsResult
```

**New tool: `nextjs_route_map`**:
```typescript
nextjs_route_map(repo, options?: {
  workspace?: string;
  router?: "app" | "pages" | "both";  // default "both"
  include_metadata?: boolean;          // default true
  max_routes?: number;                 // default 1000
})
  → NextjsRouteMapResult
```

Both new tools register in `TOOL_DEFINITIONS` with category `"analysis"`. `nextjs_route_map` is added to `CORE_TOOL_NAMES` (visible in ListTools). `analyze_nextjs_components` stays hidden (discoverable via `discover_tools`).

### Integration Points

**Files modified** (per PR):

| PR | File | Change |
|----|------|--------|
| #1 | `src/utils/framework-detect.ts` | Broaden `detectFrameworks` to fire on `next.config.*` OR `pages/` OR `app/`; export regex constants |
| #1 | `src/utils/nextjs.ts` | NEW -- shared directive scanner (512-byte window, skip-past-comments), monorepo discovery, route path normalizer |
| #1 | `src/utils/walk.ts` | Add `followSymlinks: true` option with cycle detection (tracks inode set) |
| #1 | `src/tools/project-tools.ts` | Add `pages_router: boolean` to `NextConventions.config`; use shared directive scanner |
| #2 | `src/tools/pattern-tools.ts` | Add 6 new patterns to `BUILTIN_PATTERNS`; add `router_type_context` hint to suppress `nextjs-wrong-router` on Pages Router files |
| #3 | `src/tools/route-tools.ts` | Add `.tsx`/`.jsx` match to `findNextJSHandlers`; add `findNextJSPageHandlers` (page.tsx routes); add `findPagesRouterHandlers` (pages/ default exports); add `traceMiddleware` (reads config.matcher); add `computeLayoutChain`; add `findServerActions` |
| #3 | `src/formatters.ts` | Extend `formatTraceRoute` with middleware/layout/server-action rendering; update Mermaid |
| #4 | `src/tools/nextjs-tools.ts` | NEW -- `analyzeNextjsComponents()` function with AST-based classifier |
| #4 | `src/register-tools.ts` | Add `analyze_nextjs_components` to `TOOL_DEFINITIONS` |
| #4 | `src/formatters.ts` | Add `formatNextjsComponents` |
| #5 | `src/tools/nextjs-tools.ts` | Add `nextjsRouteMap()` function |
| #5 | `src/register-tools.ts` | Add `nextjs_route_map` to `TOOL_DEFINITIONS` + `CORE_TOOL_NAMES` |
| #5 | `src/formatters.ts` | Add `formatNextjsRouteMap` |
| #5 | `src/formatters-shortening.ts` | Register compact/counts modes for `nextjs_route_map` |

**Blast radius of `detectFrameworks` broadening**: Existing consumers are `find_dead_code` (via `isFrameworkEntryPoint`) and `analyze_project`. Wider detection = more symbols whitelisted as framework entry points = fewer results in `find_dead_code` on Next.js projects. This is a behavior improvement, not a regression, but requires release-notes mention.

### Edge Cases

| Edge case | Handling |
|-----------|----------|
| `"use client"` after `/* copyright */` docblock (EC1.1) | Scanner reads first 512 bytes, strips C-style and line comments before directive search |
| BOM marker before directive | Scanner strips BOM before check |
| Backtick-quoted directive (``"use client"`` vs `` `use client` ``) | Regex accepts `["'\`]` |
| Re-exported client component via barrel file (EC1.3) | Documented limitation -- no transitive propagation in v1. Output includes `limitations: ["no transitive client boundary detection"]` |
| Component library in monorepo with `"use client"` on many files (EC1.4) | Auto-detect workspaces via `next.config.*`; only scan files within detected workspace roots |
| Conditional directive (`if (x) { "use client" }`) (EC1.5) | Two-stage detection: (1) fast-reject via 512-byte textual scan (skips most files with no directive); (2) on positive match, verify via tree-sitter AST that the directive is `Program.body[0]` ExpressionStatement with StringLiteral value "use client" -- not inside a conditional or function body. If stage 1 matches but stage 2 does not confirm top-level position, the directive is rejected and the file is treated as not having a directive. Files that cannot be parsed (stage 2 fails hard) fall back to stage 1 result and are logged in `parse_failures` |
| `app/route.tsx` root route with JSX (EC2.1) | `findNextJSHandlers` regex broadened to `.tsx`/`.jsx`/`.ts`/`.js` |
| Parallel route `app/@modal/page.tsx` (EC2.3) | Route file matcher allows `@folder` segments; output entry has `type: "parallel"` |
| Intercepting routes `(.)`, `(..)`, `(...)` (EC2.4) | Route file matcher detects these prefixes; output entry has `type: "intercepting"` |
| Pages Router `_app.tsx`, `_document.tsx`, `_error.tsx` (EC2.6) | Added to `NextConventions.pages[].type` enum: `"app" \| "document" \| "error_page"` |
| `dynamic = "force-dynamic"` vs `dynamic = "force-static"` (EC3.1) | Route map reads initializer VALUE from AST, not just symbol name |
| `revalidate = 60` ISR detection (EC3.2) | AST initializer read as numeric literal |
| `next/dynamic({ ssr: false })` flips component to client (EC5.1) | AST walker detects import from `next/dynamic` + call expression with `ssr: false` option |
| Pages Router `getServerSideProps` export (EC3.3) | Classified as `rendering: "ssr"` via symbol-name detection. `NextjsRouteEntry.config` left empty for Pages Router routes -- the `config` fields (`dynamic`, `revalidate`, `has_generate_static_params`) are App Router-specific |
| Pages Router `getStaticProps` without `revalidate` (EC3.4) | Classified as `rendering: "static"` via symbol-name detection |
| Pages Router `getStaticProps` with `revalidate` in returned object (EC3.5) | Classified as `rendering: "isr"` only if AST can read the object literal's `revalidate` field from the function return statement. If return is computed, falls back to `rendering: "static"` with `config.revalidate: undefined` (honest degraded classification) |
| Pages Router `getStaticPaths` (EC3.6) | Informs ISR classification when combined with `getStaticProps + revalidate`; does not independently change rendering strategy |
| `_app.tsx`, `_document.tsx`, `_error.tsx` in Pages Router (EC3.7) | Classified with `type: "app" \| "document" \| "error_page"`, `rendering: "unknown"` (they are not route endpoints) |
| Symlinked directories in `app/` tree (FM4) | `walk.ts` follows symlinks with cycle detection via visited-inode set |
| Circular symlink inside `app/components/` during component scan (EC6.1) | Same cycle detection as workspace scan -- `walk.ts` maintains a visited-inode set across the entire walk. Detection triggers once per cycle; affected subtree is pruned and recorded in `scan_errors` |
| Empty or non-existent workspace in monorepo | `workspaces_scanned: []` in output, no crash |
| Tree-sitter parse fails on malformed `.tsx` (FM1) | File added to `parse_failures: []`, classification = `"ambiguous"` |
| Very large project (1000+ components) (FM5) | `max_files` default 2000, `truncated: true` flag set when exceeded, async batched reads |

### Failure Modes

#### Tree-sitter TSX Parser

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Malformed JSX (unclosed tag) | parser returns error tree / 0 symbols | single file classification | file appears as `"ambiguous"` with entry in `parse_failures` | Continue scan; user can inspect `parse_failures` list | File excluded from counts | Immediate |
| Experimental syntax not in grammar (decorators, pipeline operator) | AST walk returns unexpected node types | single file classification | file appears as `"ambiguous"` | Continue scan; log parse warning | File excluded from counts | Immediate |
| File >2MB (parser hard cap) | size check before parse | single file | entry in `parse_failures: "file too large"` | Continue scan | File excluded from counts | Immediate |
| Binary content accidentally named `.tsx` | parser errors | single file | entry in `parse_failures` | Continue scan | File excluded from counts | Immediate |

**Cost-benefit**: Frequency: occasional (~2% on real codebases) × Severity: medium (degraded UX, classification gap) → Mitigation cost: trivial (try/catch + list) → **Decision: Mitigate**

#### Directive Scanner (first-512-bytes read)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| File with >512 bytes of comments before directive | directive not found in window | single file classification | server classification instead of client | None (accepted limitation) | File misclassified, documented | Silent |
| Directive in conditional block (`if (x) "use client"`) | directive not first program statement | single file classification | treated as no directive | Intentional -- position check | Correct classification (directive is ineffective) | Immediate |
| BOM marker at start of file | scanner strips BOM prefix before check | single file | correct classification | Automatic | None | Immediate |
| `.tsx` file missing read permissions | `readFileSync` throws | single file | entry in `parse_failures: "read error"` | Continue scan | File excluded | Immediate |

**Cost-benefit**: Frequency: rare (<0.1% for >512-byte docblock) × Severity: low (misclassification in rare case) → Mitigation cost: moderate (would require full file read) → **Decision: Accept and document**

#### Monorepo Workspace Discovery

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `next.config.js` file exists but is a stub (no Next.js app) | discovery finds file but no `app/` or `pages/` | monorepo workspace list | workspace included with 0 results | User passes explicit `workspace` param | Empty results, not wrong results | Immediate |
| Nested Next.js apps (`apps/web/packages/sub-app/`) | discovery finds multiple configs | all workspaces scanned independently | reported under their own workspace paths | Automatic | Each workspace has own scope | Immediate |
| Symlinked workspace via pnpm | `walk.ts` follows symlink with cycle detection | workspace scan | workspace scanned | Automatic | Correct | Immediate |
| Circular symlinks | cycle detection via visited-inode set | workspace scan | scan stops at cycle, no infinite loop | Automatic | Partial scan, logged warning | Immediate |
| No `next.config.*` found | discovery returns empty list | fallback to single-workspace scan | tool runs on whole repo (existing behavior) | Automatic | Correct for single-app projects | Immediate |

**Cost-benefit**: Frequency: occasional (monorepos ~20% of projects) × Severity: medium (wrong scope = wrong results) × Mitigation cost: moderate → **Decision: Mitigate**

#### Rendering Strategy Classification

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `dynamic = someVariable` (not literal) | AST initializer is Identifier, not Literal | single route classification | `rendering: "unknown"`, `config.dynamic: undefined`, `config.dynamic_non_literal: true` | Caller inspects `dynamic_non_literal` flag | Honest unknown, not wrong guess | Immediate |
| `revalidate = 60 * 60` (expression) | AST initializer is BinaryExpression | single route classification | `rendering: "unknown"`, `config.revalidate: undefined`, `config.revalidate_non_literal: true` | Could add expression evaluator in v2 | Honest unknown | Immediate |
| Route with no config exports | No export matches pattern | single route classification | `rendering: "static"` (Next.js default) per Next.js 15 behavior | Matches framework default | Correct | Immediate |
| `generateStaticParams` present without `dynamic` export | AST walk finds function | single route classification | `rendering: "static"` with `has_generate_static_params: true` | Correct per Next.js semantics | Correct | Immediate |

**Cost-benefit**: Frequency: occasional (non-literal configs are common) × Severity: low (honest unknown, not false positive) × Mitigation cost: moderate → **Decision: Accept + document** (literals cover ~85% of real usage)

#### Middleware Matcher Parsing

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `config.matcher` is an array of regexes | AST walker extracts string literals from array | middleware tracing | matchers compared against path | Automatic | Correct for literal patterns | Immediate |
| `config.matcher` is computed at runtime | AST returns non-literal | middleware tracing | `matchers: ["<computed>"]`, `applies: true` (fail-open) | Default to "applies" | Over-inclusive | Immediate |
| `middleware.ts` not at root, in `src/` | regex accepts `^(src/)?middleware` | middleware detection | found correctly | Automatic | Correct | Immediate |
| Complex matcher with regex backrefs | regex construction fails | middleware tracing | `matchers: ["<invalid>"]`, `applies: true` (fail-open) | Default to "applies" | Over-inclusive | Immediate |

**Cost-benefit**: Frequency: rare (most matchers are simple strings) × Severity: low (over-inclusive = false positive, not false negative) × Mitigation cost: moderate → **Decision: Accept** (fail-open is safer than fail-closed)

#### Large Project Scaling

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| 1000+ component files | file count exceeds `max_files` | component analysis | `truncated: true`, `truncated_at: 2000` | User narrows `file_pattern` | Partial results, flagged | Immediate |
| 500+ routes | route count exceeds `max_routes` | route map | `truncated: true` | User narrows `workspace` | Partial results, flagged | Immediate |
| Synchronous read blocks event loop | concurrency limit via p-limit pattern | tool latency | tool returns slower but doesn't hang | Async batched reads (concurrency=10) | Correct | Immediate |
| Memory pressure on 5000+ file scan | Node heap warning | tool completion | tool may OOM on very large repos | `max_files` cap + early truncation | Truncated, flagged | Immediate |
| Circular symlink inside `app/` subtree during `analyze_nextjs_components` scan (not at workspace root) | `walk.ts` visited-inode set detects revisit | single workspace's component list | affected subtree pruned, other components scanned normally; entry in `scan_errors` | Automatic | Partial component list (subtree beyond cycle excluded), flagged | Immediate |
| Circular symlink inside `app/` subtree during `nextjs_route_map` scan | same cycle detection | route enumeration | affected routes pruned from output; entry in `scan_errors` | Automatic | Partial route list, flagged | Immediate |

**Cost-benefit**: Frequency: rare (enterprise monorepos only) × Severity: medium (blocks user on large projects) × Mitigation cost: moderate → **Decision: Mitigate** (async batching + limits)

#### Hybrid Router Conflicts

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Same URL path in both `app/` and `pages/` | post-scan collision check | route map | `conflicts: [{ url_path, app, pages }]` field populated | User informed; Next.js prioritizes App Router | Both entries reported, plus conflict | Immediate |
| `pages/api/foo.ts` and `app/api/foo/route.ts` | post-scan collision check | route map | conflict reported with both file paths | User decides which to keep | Correct | Immediate |
| Hybrid project with no conflicts | no collisions found | route map | `conflicts: []` | None needed | Correct | N/A |

**Cost-benefit**: Frequency: occasional (migration projects) × Severity: medium (can cause production bugs if user unaware) × Mitigation cost: trivial (set comparison) → **Decision: Mitigate**

#### Route Tracing Extension (PR #3)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `computeLayoutChain` — missing root `app/layout.tsx` (migration in progress) | walker finds no layout file at target segment or any ancestor | single trace call | `layout_chain: []`, no crash | Continue tracing; user informed via empty array | Correct (empty is accurate) | Immediate |
| `computeLayoutChain` — target route path doesn't resolve to a filesystem segment | path-to-filesystem resolution fails | single trace call | `layout_chain: []` with `scan_errors: ["route not found"]` | Continue with empty chain | Partial result, flagged | Immediate |
| `findServerActions` — `"use server"` in nested function scope (not top-level directive) | AST walker checks directive position relative to function body top | single trace call | nested server action NOT detected (documented limitation) | User informed via spec documentation only | Under-count, silent | Silent |
| `findServerActions` — `"use server"` file-scope directive (whole file is server actions) | AST walker detects top-level directive | single trace call | all exported functions treated as server actions | Automatic | Correct | Immediate |
| `findPagesRouterHandlers` — `export default` assigned to variable rather than function declaration (`const h = (req,res)=>{}; export default h;`) | default export resolution walks variable declaration | single trace call | resolved to variable initializer; if initializer is function expression, handler found; else `handlers: []` with file in `scan_errors` | User reviews `scan_errors` list | Partial (common case handled, exotic case documented) | Immediate |
| `findPagesRouterHandlers` — `pages/api/*.ts` with no default export (invalid Next.js) | AST walker finds no default export | single trace call | `handlers: []` for that file, file in `scan_errors` | Continue tracing | Honest empty | Immediate |
| `traceMiddleware` — `middleware.ts` exists but exports no `config` object | symbol scan finds no `config` export | single trace call | `middleware.applies: true` (fail-open per middleware default behavior) | Automatic | Over-inclusive (matches Next.js default: no matcher = all routes) | Immediate |
| Hybrid project: same URL path matches both App Router and Pages Router | post-collection dedup step | single trace call | BOTH handlers returned, each with distinct `router` field | Caller disambiguates via `router` field on each handler | Correct (both are real, App Router wins at runtime) | Immediate |

**Cost-benefit**: Frequency: occasional (each scenario) × Severity: medium (tracing gaps mislead implementers) × Mitigation cost: trivial to moderate → **Decision: Mitigate all except nested `"use server"`** (rare, documented limitation acceptable in v1)

## Acceptance Criteria

### Ship Criteria (must pass for release)

**PR #1 -- Foundation**:
1. `detectFrameworks` fires on projects with `next.config.*` OR `app/` directory OR `pages/` directory (not just `app/api/route.ts`)
2. `NextConventions.config.pages_router: boolean` populated from `pages/` directory presence
3. Directive scanner reads first 512 bytes, strips comment blocks, detects `"use client"` and `"use server"` correctly on 8 fixture cases (plain, with docblock, with BOM, with shebang, single-quoted, double-quoted, backtick-quoted, after multi-line comment)
4. `walk.ts` follows symlinks in test fixture without infinite loop on circular link
5. All existing tests pass (no regressions in `find_dead_code`, `analyze_project`, existing trace_route tests)

**PR #2 -- search_patterns**:
6. Each of 6 new patterns returns ≥1 match on a positive fixture and 0 matches on a negative fixture
7. `nextjs-wrong-router` is suppressed on files under `pages/` directory
8. Pattern descriptions are surfaced in `listPatterns()` output
9. All existing patterns return same results as before (no regressions)

**PR #3 -- trace_route**:
10. `trace_route("/some/page")` returns `layout_chain` as ordered array from root layout to segment layout
11. `trace_route("/some/page")` returns `middleware.applies` per this rule: (a) if `config.matcher` is a literal string or array of string literals AND no literal matches the path → `false`; (b) if any literal matches → `true`; (c) if `config.matcher` is computed, contains non-literal expressions, complex regex with backrefs, or cannot be statically evaluated → `true` (documented fail-open per Middleware Matcher Parsing failure mode). Tests MUST cover all three branches with explicit fixtures
12. `trace_route("/api/action")` returns `server_actions: [{ name, file, called_from }]` when route calls `"use server"` function
13. `trace_route("/api/users")` on a Pages Router fixture (where `pages/api/users.ts` exists with a default-exported handler) returns the default-exported function and includes `router: "pages"` on the handler entry. When the same fixture also has `app/api/users/route.ts`, `trace_route` returns BOTH handlers, each tagged with its `router` field, allowing the caller to disambiguate
14. `trace_route("/app/route.tsx")` matches `.tsx` route files (not just `.ts`)
15. Mermaid output includes middleware actor and layout chain nodes

**PR #4 -- analyze_nextjs_components**:
16. Returns `NextjsComponentsResult` with per-file classification on a fixture of 20+ components
17. Classification recall: 100% on **successfully-parsed** files with explicit `"use client"` directive. The test fixture MUST contain zero parse failures (`parse_failures.length === 0` is a fixture invariant). Files that fail tree-sitter parsing are excluded from the recall calculation and tracked separately via the `parse_failures` field per the Tree-sitter failure mode
18. `unnecessary_use_client` flag: precision ≥95% on fixture (measured as correctly-flagged / all-flagged)
19. Detects `next/dynamic({ ssr: false })` and flags as `client_boundary_via_dynamic`
20. Parse failures listed in `parse_failures` field without crashing tool
21. `truncated: true` set when file count exceeds `max_files`
22. Monorepo: `workspaces_scanned` field populated when `next.config.*` auto-detect finds ≥2 configs
23. Explicit `workspace` parameter scopes analysis correctly

**PR #5 -- nextjs_route_map**:
24. Returns route entries for all App Router conventions in fixture (`page`, `route`, `layout`, `loading`, `error`, `not-found`, `default`, `template`, `global-error`)
25. Returns route entries for Pages Router (`pages/*.tsx`, `pages/api/*.ts`, `_app`, `_document`, `_error`)
26. Route groups stripped from URL path: `app/(auth)/login/page.tsx` → `/login`
27. Parallel routes: `type: "parallel"`; intercepting routes: `type: "intercepting"`
28. Rendering strategy correctly classified: fixture with `dynamic = "force-dynamic"` → `"ssr"`, `revalidate = 60` → `"isr"`, `dynamic = "force-static"` → `"static"`, `generateStaticParams` → `"static"`
29. HTTP methods extracted from `route.ts` files (e.g., `["GET", "POST"]`)
30. Metadata presence detected (`has_metadata: true` when `export const metadata` or `export function generateMetadata` present)
31. `layout_chain` populated for each page route
32. Middleware applies check per route (`middleware_applies: boolean`)
33. Hybrid project: conflicts between `app/` and `pages/` routes reported in `conflicts` field
34. Progressive shortener active for large outputs (compact/counts modes)

### Success Criteria (must pass for value validation)

1. **Quality (SC1)**: On 3 real Next.js repos (App Router only, Pages Router only, hybrid monorepo), `analyze_nextjs_components` classification matches manual inspection with ≥95% accuracy (measured as agreement count / total components). Validated by `scripts/validate-nextjs-accuracy.ts`.
2. **Quality (SC2)**: `nextjs_route_map` route enumeration is complete. Canonical rule: `routes[]` returns EVERY App Router convention file (`page`, `route`, `layout`, `loading`, `error`, `not-found`, `default`, `template`, `global-error`) AND every Pages Router convention file including the non-endpoint specials `_app` (`type: "app"`), `_document` (`type: "document"`), and `_error` (`type: "error_page"`). For each of the 3 fixture repos, the count of routes returned equals the count of convention files found by a filesystem walk over the **exact same canonical convention set**. Validated by `scripts/validate-nextjs-route-count.ts` which walks using glob patterns: App Router (`app/**/{page,route,layout,loading,error,not-found,default,template,global-error}.{tsx,jsx,ts,js}`) and Pages Router (`pages/**/*.{tsx,jsx,ts,js}` including `_app`, `_document`, `_error`, and `pages/api/**/*.{ts,js}`). Script asserts `walked_count === tool_routes_count` per repo. Tolerance: exact equality; mismatch by ≥1 is a failure.
3. **Efficiency (SC3)**: `nextjs_route_map` on a 500-route project completes in <5 seconds (p95 latency). Validated by `scripts/benchmark-nextjs-tools.ts`.
4. **Efficiency (SC4)**: `analyze_nextjs_components` on a 200-component project completes in <3 seconds. Validated by `scripts/benchmark-nextjs-tools.ts`.
5. **Value (SC5)**: Real-world smoke test -- running `analyze_nextjs_components` on a test project surfaces at least 1 actionable finding (unnecessary use-client OR async client component OR missing metadata) that the developer confirms is a real issue. Validated manually and documented in PR #4 description.

## Validation Methodology

**Unit tests** (per PR):
- vitest test files in `tests/tools/` and `tests/utils/`
- `createFixture()` + `mockIndex()` pattern as used in existing tests
- Each PR adds ≥5 test cases for new functionality
- Run command: `npx vitest run tests/tools/nextjs-tools.test.ts tests/utils/nextjs.test.ts`

**Integration fixtures** (added in PR #1, used in PR #4 and #5):
- `tests/fixtures/nextjs-app-router/` -- 20+ files: pages, layouts, server components, client components, route handlers, middleware
- `tests/fixtures/nextjs-pages-router/` -- 15+ files: pages, api routes, `_app.tsx`, `_document.tsx`, `_error.tsx`
- `tests/fixtures/nextjs-hybrid/` -- monorepo layout with `apps/web-app/` (App Router) + `apps/web-pages/` (Pages Router) + shared `packages/ui/`
- Each fixture has a documented expected-output JSON file for regression testing

**Accuracy validation script** (`scripts/validate-nextjs-accuracy.ts`) -- validates SC1:
- Runs `analyze_nextjs_components` on fixture
- Compares output against `expected.json`
- Computes precision/recall for classification and `unnecessary_use_client`
- CI gate: fails if recall <100% or precision <95%
- Output: numerical precision/recall scores + pass/fail
- Run command: `npx tsx scripts/validate-nextjs-accuracy.ts`

**Route count validation script** (`scripts/validate-nextjs-route-count.ts`) -- validates SC2:
- Walks each fixture repo using glob patterns for the CANONICAL convention set:
  - App Router: `app/**/{page,route,layout,loading,error,not-found,default,template,global-error}.{tsx,jsx,ts,js}`
  - Pages Router: `pages/**/*.{tsx,jsx,ts,js}` (includes `_app`, `_document`, `_error`, and `pages/api/**/*.{ts,js}` which the glob naturally covers)
- Calls `nextjs_route_map` on the same repo (with `router: "both"`)
- Compares walked file count with `routes.length` from tool output
- Asserts `walked_count === tool_routes_count` per repo (exact equality)
- CI gate: fails on any mismatch
- Output: per-repo walked count vs tool count + pass/fail
- Run command: `npx tsx scripts/validate-nextjs-route-count.ts`

**Performance benchmark** (`scripts/benchmark-nextjs-tools.ts`) -- validates SC3 and SC4:
- Generates synthetic 500-route and 1000-component projects
- Measures tool latency
- Fails if `nextjs_route_map` >5s or `analyze_nextjs_components` >3s on target sizes
- Run command: `npx tsx scripts/benchmark-nextjs-tools.ts`

**Real-world smoke test** (manual, pre-merge):
- Run both new tools on at least 1 real Next.js project accessible to the author
- Manual inspection of output; confirm ≥1 actionable finding
- Document output sample in PR description

## Rollback Strategy

**Per-PR rollback**: Each PR is atomic. Rollback = `git revert <merge-commit-sha>`.

**Kill switch per tool**: Environment variable `CODESIFT_DISABLE_TOOLS=analyze_nextjs_components,nextjs_route_map` causes `registerTools()` to call `disable()` on listed tool names at startup. No rebuild required. Documented in README.

**Fallback behavior**: Tools are read-only (no file modifications), so no state rollback is needed. If a tool throws an error, the existing `wrapTool()` error handler in `server-helpers.ts` returns a structured error response -- the MCP server continues serving other tools.

**Data preservation**: No persistent state is written by new tools. Existing `.codesift/index.json` schema is unchanged. `NextConventions` additions (`pages_router`, etc.) are optional fields on an existing JSON structure -- old indices remain readable.

**Foundation PR rollback consideration**: PR #1 modifies `detectFrameworks` and `walk.ts`. Rolling back these changes reverts ALL downstream PRs to broken state (they depend on foundation). If a critical bug is found in foundation post-merge, the remediation order is: revert PR #5 → PR #4 → PR #3 → PR #2 → PR #1. Each revert is independent.

## Backward Compatibility

**MCP tool output schema** (consumer-facing):
- `NextConventions` gains `pages_router: boolean` field -- additive, non-breaking for existing consumers
- `NextConventions.pages[].type` enum adds Pages Router types -- additive, non-breaking
- `RouteTraceResult` gains `middleware?`, `layout_chain?`, `server_actions?` optional fields -- non-breaking
- `NextConventions.api_routes[]` gains `router: "app" | "pages"` field -- additive

**Migration of stored state**:
- `.codesift/index.json` schema unchanged -- no migration needed
- If an old `project-profile.json` exists without `pages_router` field, code reads as `undefined` which is treated as `false` -- graceful degradation

**Framework detection behavior change**:
- `detectFrameworks` now returns `nextjs` for more projects (Pages Router only, App Router without API routes, projects with `next.config.*`)
- Effect: `isFrameworkEntryPoint` whitelists more symbols → `find_dead_code` returns fewer results on Next.js projects → this is a bug fix, not a regression
- **Release note required** (both README and CHANGELOG `[Unreleased] → Changed`): "Framework detection now recognizes Pages Router and App Router projects without API routes. `find_dead_code` results on these projects will include fewer false positives. This is a minor version bump behavior change -- downstream consumers setting dead-code count thresholds may see step-change in results on first run after upgrade."

**Existing pattern semantics**:
- `nextjs-wrong-router` now suppressed on files under `pages/` -- this is a bug fix (was firing as false positive)
- Other existing patterns (`nextjs-img-element`, `nextjs-a-element`, `nextjs-async-client`) unchanged
- **Release note**: "`nextjs-wrong-router` no longer fires on Pages Router files."

**Tool discovery**:
- `nextjs_route_map` added to `CORE_TOOL_NAMES` (visible in ListTools)
- `analyze_nextjs_components` registered as hidden tool, discoverable via `discover_tools(query="nextjs component")`
- Tool count: 72 → 74 (update `README.md`, `CLAUDE.md`, website content per the existing checklist)

## Out of Scope

### Deferred to v2

1. **Transitive client boundary propagation** -- If a file has `"use client"` and is imported by a barrel file, the barrel file is not currently classified as client. Would require import-graph traversal via existing `CodeSift` adjacency index. Rationale: adds significant complexity; file-level detection covers ~90% of real queries.

2. **Expression-based config exports** -- `dynamic = someVariable` or `revalidate = 60 * 60` currently return `rendering: "unknown"`. Would require AST expression evaluator. Rationale: literal values cover ~85% of real usage.

3. **`pattern-tools.ts` file-scope patterns** -- Some Next.js patterns (like `missing-metadata`, `pages-in-app`) conceptually need file-path context, not just symbol source. Current implementation works via symbol-source regex but is less precise. A `file_scope` pattern type could be added later.

4. **Runtime rendering verification** -- This spec covers static analysis only. Running the Next.js dev server to verify static analysis against runtime behavior is out of scope (that's what Vercel's `next-devtools-mcp` does).

5. **Next.js config parsing** -- `next.config.js` options like `output: "export"` (full SSG), `basePath`, `i18n` config are not parsed for rendering-strategy influence. v1 reads only route segment config exports. v2 could incorporate project-level config.

6. **Server Action trust boundaries** -- v1 detects server actions and their call sites but does not analyze security properties (input validation, auth checks). v2 could add security-audit integration.

7. **Transitive import-graph resolution for component classification** -- Currently `nextjs-unnecessary-use-client` pattern is a regex on file source. A more precise version would WALK the import graph to check if any transitively imported module has `"use client"` (which would propagate). Requires import-graph traversal and is out of scope for v1. **In scope for v1**: single-file local import source literal matching (e.g., detecting `import dynamic from "next/dynamic"` by matching the string literal `"next/dynamic"` in an ImportDeclaration AST node) -- this is NOT graph traversal, it is a single-file AST walk and is used by the `next/dynamic({ ssr: false })` detection.

### Permanently out of scope

1. **Runtime Next.js intelligence** -- CodeSift is a static analysis MCP. Users needing runtime insights should use Vercel's `next-devtools-mcp`.

2. **Code generation / autofix** -- CodeSift is read-only. Fixes for detected issues (e.g., "add missing `"use client"` directive") are not generated. Users apply fixes manually.

3. **Bundle size analysis** -- That's `@next/bundle-analyzer`. Not a code intelligence concern.

4. **Next.js version upgrade assistance** -- Codemods for migrating between Next.js versions are handled by `@next/codemod`. Not a CodeSift concern.

5. **React Server Components outside of Next.js** -- This spec is Next.js-specific. Remix, TanStack Start, and other RSC-compatible frameworks are separate concerns.

## Open Questions

Phase 2 clarifying questions were all resolved (see Design Decisions). The following non-blocking items were raised by adversarial review and are recorded here for implementer awareness; none are spec-blocking:

**OQ1 (WARNING from adversarial review)** -- SC5 is subjective. Resolution path: during PR #4 smoke test, the author MUST commit the real-world project's relevant snippet and resulting tool finding into `tests/fixtures/nextjs-smoke-test-YYYY-MM-DD/` as a reproducible artifact. The "developer confirms" language is kept but PR description must include the fixture snapshot and the specific file:line of the finding.

**OQ2 (WARNING)** -- Parser initialization failure (tree-sitter grammar load failure) is a global failure mode not covered by per-file recovery. Resolution path: at tool entry, wrap the tree-sitter init call in try/catch. On init failure, return a structured tool error `{ error: "nextjs_tools_unavailable", reason: "tree-sitter grammar init failed", details: <message> }` and skip file iteration. Add a test in PR #4 that simulates init failure.

**OQ3 (WARNING)** -- Problem Statement mentions "4 basic Next.js patterns" but also "quick wins D1-D5". Clarification: D1-D5 are 5 quick wins in total, of which D4 added 4 new search patterns (the other Ds were convention enum updates, framework entry points, directive counter, route group stripping). The "4 basic Next.js patterns" language refers specifically to D4's contribution.

**OQ4 (WARNING)** -- Validation scripts (`validate-nextjs-accuracy.ts`, `validate-nextjs-route-count.ts`, `benchmark-nextjs-tools.ts`) need explicit PR ownership. Resolution: the scripts and their fixture `expected.json` files are part of PR #4 (for accuracy + benchmark of components) and PR #5 (for route-count validation). The Solution Overview file plan is updated accordingly.

**OQ5 (WARNING)** -- SC1 ground truth reconciliation. Resolution: the authoritative ground truth is the checked-in `expected.json` file per fixture. The "manual inspection" language in SC1 means the `expected.json` is produced by manual inspection ONCE at fixture creation time, then frozen. Future runs compare against this frozen baseline, not against re-running manual inspection.

**OQ6 (WARNING)** -- `client_boundary_via_dynamic` field placement. Resolution: it is a violation-like flag but is actually a classification signal. Placed on `signals.dynamic_ssr_false: boolean` in `NextjsComponentEntry` (already present in the interface). AC #19 is satisfied when `signals.dynamic_ssr_false === true` for files using `next/dynamic({ ssr: false })`.

**OQ7 (WARNING)** -- Migration blind spot for `find_dead_code` consumers. Resolution: add CHANGELOG entry under `[Unreleased] → Changed` section describing the behavior change. Recommend version bump to minor (not patch). No opt-out flag -- the old behavior was a bug.

**OQ8 (INFO)** -- `spec_id` suffix `-2017` is a timestamp (HHMM format in UTC). This is intentional per the spec_id convention in the brainstorm skill. No fix needed.
