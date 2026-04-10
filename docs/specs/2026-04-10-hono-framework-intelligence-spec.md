# Hono Framework Intelligence -- Design Specification

> **spec_id:** 2026-04-10-hono-framework-intelligence-2013
> **topic:** Hono framework intelligence in CodeSift MCP
> **status:** Approved
> **created_at:** 2026-04-10T20:13:59Z
> **approved_at:** 2026-04-10T20:35:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm
> **reviewers:** spec-reviewer (sonnet), adversarial-review (cross-provider)

## Problem Statement

Hono is the fastest-growing backend web framework in JavaScript (28K+ GitHub stars, 9.3M+ weekly npm downloads, 26.6% MoM growth as of April 2026). It is the de facto standard for building MCP servers on Cloudflare Workers and is used in production by Cloudflare themselves.

Despite this, **there is a complete vacuum in Hono code intelligence tooling**. No MCP tool, no VSCode extension, no standalone static analysis tool provides deep understanding of Hono applications. Competing code intelligence tools (Serena 22.5K stars, codedb, jcodemunch, codegraph) offer zero framework-specific features for Hono -- or for any web framework. The only tooling that exists is runtime-only (Hono's own `showRoutes`, `inspectRoutes`) which requires a running server and therefore cannot be used in CI, static audits, or agentic workflows.

CodeSift has partial Hono support today: framework detection, middleware chain extraction, auth boundary detection, and route mount parsing, all implemented via regex in `src/tools/project-tools.ts` (lines 630-835) with 31 passing tests. However, critical gaps block end-to-end use:

- `trace_route` does not support Hono at all (only NestJS, Next.js, Express). Users cannot trace Hono endpoints to handlers, services, or DB calls.
- The regex-based `parseHonoCalls` cannot handle recursive `app.route()` composition, `app.basePath()` chains, `factory.createApp()` with non-`app` variable names, `app.on()` multi-method routes, `OpenAPIHono.openapi(createRoute(...))` patterns, or `hono/combine` middleware composition (`some()`, `every()`).
- Hono handlers registered via string-based route registration (`app.get("/path", handlerFn)`) are invisible to the static call graph, causing `find_dead_code` false positives and `impact_analysis` under-reporting for middleware changes.
- There are no Hono-specific anti-pattern checks in `search_patterns`.
- There is no context flow analysis (`c.set` / `c.get` / `c.var` / `c.env`).
- There is no OpenAPI contract extraction (`createRoute` definitions).
- There is no RPC type flow analysis (`hc<AppType>()` client vs server types).

The Hono community has explicitly asked for most of what we would build: GitHub Discussion #4255 asks how to "quickly locate nested route definitions," Issue #3069 asks to "generate OpenAPI schema from any existing Hono app," Issue #3869 documents 8-minute CI compile times caused by RPC type inference explosion, and Issue #4121 asks for architectural guidance for large Hono applications. Developers are manually grepping through files.

**What happens if we do nothing:** Hono users pick other tools (none of which help) or write their own grep scripts. CodeSift misses a ~10M weekly download ecosystem with zero competition. The fastest-growing backend framework in JavaScript remains an analysis blind spot.

## Design Decisions

### D1: Scope -- full A+B+C (Core + Intelligence + Advanced)

**Decision:** Implement all three layers in a single spec.

- **Layer A (Core foundation):** `findHonoHandlers` in `trace_route`; Hono in `framework-detect.ts`; extended parser for `basePath`, `on`, `mount`, `openapi`, factory patterns, non-`app` variable names; Hono anti-patterns in `search_patterns`.
- **Layer B (Intelligence tools):** `trace_middleware_chain`, `analyze_hono_app`, `trace_context_flow`.
- **Layer C (Advanced tools):** `extract_api_contract`, `trace_rpc_types`, `audit_hono_security`, `visualize_hono_routes`. (`validate_hono_contracts` was considered but deferred to v2 — see Out of Scope.)

**Why:** Layer A is the foundation without which Layer B/C cannot function -- all three share the same AST extractor and data model, so splitting them into separate specs would duplicate the parser work. User explicitly chose full scope.

### D2: Parsing strategy -- tree-sitter AST

**Decision:** Write a new `src/parser/extractors/hono.ts` using the existing tree-sitter infrastructure. No regex fallback.

**Language coverage:** The tree-sitter TypeScript grammar handles `.ts`, `.tsx`, `.js`, and `.jsx` files. The extractor auto-detects the appropriate parser variant (TSX vs TS) based on file extension, consistent with `src/parser/extractors/typescript.ts` and `javascript.ts` patterns. All Hono source patterns work identically in JS and TS (Hono types are stripped by `tsc`, runtime is plain JS).

**Why:** The edge cases are intractable with regex:
- `some(authMw, publicMw)` requires expanding nested call expressions
- `app.route("/api", userRouter.basePath("/v1"))` requires chained call resolution
- `const api = factory.createApp()` requires tracking variable names bound to Hono instances
- `app.openapi(createRoute({ method: "get", path: "/items" }), handler)` requires parsing object literals as arguments

CodeSift already has tree-sitter extractors for TS, JS, Python, Go, Rust, Prisma, MD, Astro. A Hono extractor fits the existing pattern.

### D3: Migration path -- full rewrite of `extractHonoConventions`

**Decision:** The existing regex `extractHonoConventions` is replaced entirely. The 31 existing tests are rewritten against the new AST-based implementation. The public API surface (the `Conventions` object shape consumed by `analyze_project` and `audit_scan`) is preserved -- only the implementation changes.

**Why:** New middleware acceptance criteria (AC-M1 through AC-M5: `some()`/`every()` expansion, inline middleware naming, factory tracking, spread arguments, third-party classification) already require rewriting the middleware extraction logic. One unified AST-based model avoids maintaining two parallel parsing systems.

### D4: State management -- lazy cache with file-watcher invalidation

**Decision:** Implement `src/cache/hono-cache.ts` as an in-memory LRU cache of `HonoAppModel`. First tool call builds the model on demand, subsequent calls in the same session read from cache. Cache invalidation is wired into `src/tools/index-tools.ts::handleFileChange()` and `handleFileDelete()` (NOT `src/storage/watcher.ts` which is just a dumb callback library). These handlers receive a `relativeFile` path — the cache invalidator must resolve it to an absolute path via `join(repoRoot, relativeFile)` before comparing against `HonoAppModel.files_used` (which stores absolute paths). A mismatched path format will silently produce stale-cache results, so the invalidation logic MUST normalize before comparison.

**Why:**
- **Not in CodeIndex:** Adding `hono_apps` to `CodeIndex` requires data migration, schema versioning, and disk persistence work. Hono apps are a minority of indexed projects.
- **Not stateless on-demand:** `analyze_hono_app` on a 50-file Hono project would re-parse every file on every call. Unacceptable for interactive use.
- **Lazy cache:** Best of both -- zero index bloat, fast after first call, correct invalidation via existing watcher hooks.

Cache is session-scoped in-memory only (no disk persistence). Cold start cost = parse once per session per repo. Subsequent queries are O(1) lookup.

### D5: Tool tiering -- 2 core + 6 hidden

**Decision:** The following 2 tools are added to `CORE_TOOL_NAMES` in `src/register-tools.ts`:

- `trace_middleware_chain` -- top Hono pain point (Discussion #4255)
- `analyze_hono_app` -- meta-tool, first call for any Hono project exploration

The following 5 tools are registered as hidden (discoverable via `discover_tools`/`describe_tools`):

- `trace_context_flow` -- niche, only for middleware/context debugging
- `extract_api_contract` -- niche, only for OpenAPI use cases
- `trace_rpc_types` -- niche, only for RPC monorepos
- `audit_hono_security` -- niche, only for security audits
- `visualize_hono_routes` -- niche, only for documentation generation

**Deferred to v2** (moved out of scope here, see Out of Scope section):
- `validate_hono_contracts` -- requires handler return-type inference which is unreliable without LSP integration (also deferred)

**Why:** Core tools should be general-purpose (used in >20% of sessions). `trace_middleware_chain` and `analyze_hono_app` are used every time a Hono project is debugged or explored. The other 6 would pollute the ListTools budget for agents working on non-Hono projects.

**Tool count impact:** Actual baseline (verified via `grep -c "^[[:space:]]*name:" src/register-tools.ts` and counting `CORE_TOOL_NAMES`): **88 tools currently registered (37 core + 51 discoverable)**. Docs are stale (CLAUDE.md, README.md, instructions.ts say 72; package.json says 66). This spec fixes the doc drift as part of the work. Post-implementation: **95 tools (39 core + 56 discoverable)** — adding 7 new tools (after deferring `validate_hono_contracts` to v2), promoting `trace_middleware_chain` and `analyze_hono_app` to core (+2).

Files requiring tool count updates: `CLAUDE.md` (line 55 grep hint + line 60 architecture line), `README.md` (line 318), `src/instructions.ts` (line 5), `package.json` (description field), `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`, and website components.

### D6: Test fixtures -- multiple minimal Hono projects

**Decision:** Create 5 fixture directories under `tests/fixtures/hono/`:

- `basic-app/` -- single-file Hono app with inline routes, global middleware, inline handlers. **Covers:** AC-R1, AC-R3, AC-M1, AC-M2, AC-M5, AC-P1, AC-P2, AC-A1, AC-C1, AC-C2.
- `subapp-app/` -- multi-file `app.route()` composition, 3 sub-routers, auth middleware, context vars. **Covers:** AC-R2, AC-R4, AC-M3, AC-M4, AC-C3, AC-C5, AC-A2, AC-D1, AC-D3, AC-I1, AC-I2. Used in all benchmarks.
- `openapi-app/` -- `OpenAPIHono` with `createRoute()` and Zod schemas. **Covers:** AC-R9, extract_api_contract tool tests.
- `factory-app/` -- `factory.createApp()` pattern with non-`app` variable name, Cloudflare Workers runtime. **Covers:** AC-R8, AC-C4, AC-A3.
- `basepath-app/` -- `app.basePath("/v1")` chain, regex constraint routes, `app.all()` catch-all, `app.mount()` of non-Hono. **Covers:** AC-R5, AC-R6, AC-R7, AC-D2.

Each fixture is a real directory with real `.ts` files. The existing `HONO_APP_SOURCE` string fixture in `tests/tools/project-tools.test.ts` is replaced by reads from `basic-app/src/index.ts`.

**Why:** Multi-file `app.route()` composition and recursive sub-app resolution cannot be tested with inline string fixtures. Each minimal fixture focuses on one pattern, making test intent clear and debugging straightforward.

### D7: Data model -- unified `HonoAppModel`

**Decision:** A single `HonoAppModel` type (in `src/parser/extractors/hono-model.ts`) is the output of the extractor and the input to all 7 new tools plus the 4 extended existing tools. Fields include `app_variables` (variable name to Hono instance map), `routes` (flattened with fully-resolved paths), `mounts`, `middleware_chains`, `context_vars`, `openapi_routes`, `rpc_exports`, `runtime`, and `files_used`.

See the Data Model section below for the full schema.

**Why:** A single source of truth for Hono project structure. Every tool consumes the same model. Cache stores the model. Tests verify the model. One extractor, one type, many tools.

## Solution Overview

```
                 ┌─────────────────────────────────────────┐
                 │            HONO TOOL CALLS              │
                 │  trace_route, trace_middleware_chain,   │
                 │  analyze_hono_app, trace_context_flow,  │
                 │  extract_api_contract, trace_rpc_types, │
                 │  audit_hono_security, visualize_routes  │
                 │         (7 new + 4 extended)            │
                 └─────────────────────┬───────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │     HonoCache (LRU)    │
                          │  key: repo:entry_file  │◄──── invalidate
                          │  value: HonoAppModel   │      (file watcher)
                          └──────────┬─────────────┘
                                     │ miss
                                     ▼
                      ┌─────────────────────────────┐
                      │    HonoExtractor (AST)      │
                      │  tree-sitter TypeScript     │
                      │  - finds new Hono() vars    │
                      │  - parses app.get/post/...  │
                      │  - follows app.route mounts │
                      │  - resolves imports         │
                      │  - detects OpenAPIHono      │
                      │  - tracks c.set/c.get       │
                      └─────────────────────────────┘
```

Flow:
1. Tool is called (e.g., `trace_middleware_chain(path="/api/users/:id")`).
2. Tool calls `honoCache.get(repo, entryFile)`.
3. On miss: `HonoExtractor.parse(entryFile)` walks the AST, resolves imports, recursively parses mounted sub-apps, and builds a complete `HonoAppModel`. Cache stores it.
4. On hit: model returned immediately.
5. Tool queries the model (e.g., find the route matching `/api/users/:id`, walk the middleware chain for that scope, return the ordered list).
6. File watcher on any `files_used` path triggers `honoCache.invalidate(repo, entryFile)`.

## Detailed Design

### Data Model

Full type definitions live in `src/parser/extractors/hono-model.ts`.

```typescript
export interface HonoAppModel {
  entry_file: string;                    // absolute path
  app_variables: Record<string, HonoApp>; // variable name -> Hono instance (plain object for JSON serialization)
  routes: HonoRoute[];                   // flattened, fully resolved paths
  mounts: HonoMount[];                   // app.route() composition graph
  middleware_chains: MiddlewareChain[];
  context_vars: ContextVariable[];
  openapi_routes: OpenAPIRoute[];
  rpc_exports: RPCExport[];
  runtime: "cloudflare" | "node" | "bun" | "deno" | "lambda" | "unknown";
  env_bindings: string[];                // e.g., ["DB", "KV", "SECRET"]
  files_used: string[];                  // absolute paths, for cache invalidation
  extraction_status: "complete" | "partial";
  skip_reasons: Record<string, number>;
}

export interface HonoApp {
  variable_name: string;                 // "app" | "api" | etc.
  file: string;
  line: number;
  created_via: "new Hono" | "OpenAPIHono" | "factory.createApp" | "basePath";
  base_path: string;                     // "" if none
  parent?: string;                       // variable of parent if derived via basePath()
  generic_env?: string;                  // the E in Hono<E>, e.g. "{ Bindings: Env }"
}

export interface HonoRoute {
  method: "GET"|"POST"|"PUT"|"DELETE"|"PATCH"|"OPTIONS"|"ALL"|"ON";
  methods?: string[];                    // for app.on(["GET","POST"], ...)
  path: string;                          // fully resolved: basePath + mount + raw
  raw_path: string;                      // original from source
  file: string;
  line: number;
  owner_var: string;                     // which Hono variable registered this
  handler: {
    name: string;                        // "<inline>" for arrow
    symbol_id?: string;                  // for find_references link
    inline: boolean;
    file: string;
    line: number;
  };
  inline_middleware: string[];           // middleware in the same registration call
  openapi_route_id?: string;             // link to OpenAPIRoute
  validators: HonoValidator[];           // zValidator('json', schema), etc.
  regex_constraint?: Record<string, string>;  // { id: "[0-9]+" }
}

export interface HonoMount {
  parent_var: string;
  mount_path: string;
  child_var: string;
  child_file: string;
  mount_type: "hono_route" | "hono_mount";  // app.route() vs app.mount() (non-Hono)
  base_path?: string;
  external_framework?: string;           // for app.mount() — "express" | "itty" | "unknown"
}

export interface MiddlewareChain {
  scope: string;                         // "global" | "/api/*" | etc.
  scope_pattern: string;                 // string pattern, compiled to RegExp lazily at match time
  owner_var: string;
  entries: MiddlewareEntry[];
}

export interface MiddlewareEntry {
  name: string;                          // "authMw" | "<inline>" | "cors"
  order: number;
  line: number;
  file: string;
  inline: boolean;
  is_third_party: boolean;
  imported_from?: string;                // "hono/cors"
  expanded_from?: string;                // "some" | "every" if from hono/combine
  conditional: boolean;                  // inside some() rather than every()
}

export interface ContextVariable {
  name: string;                          // "userId"
  set_points: ContextAccessPoint[];
  get_points: ContextAccessPoint[];
  is_env_binding: boolean;               // c.env.* (always available)
}

export interface ContextAccessPoint {
  file: string;
  line: number;
  containing_symbol?: string;            // function that contains the access
  scope: "middleware" | "handler" | "service";
  via_context_storage: boolean;          // getContext() pattern
  condition: "always" | "conditional";   // inside if/branch?
}

export interface HonoValidator {
  target: "json" | "form" | "query" | "param" | "header" | "cookie";
  schema_symbol_id?: string;             // link to Zod schema in the index
  schema_file: string;
  line: number;
  kind: "zValidator" | "valibot" | "typebox" | "arktype" | "custom";
}

export interface OpenAPIRoute {
  id: string;                            // synthetic
  method: string;
  path: string;                          // OpenAPI {param} syntax
  hono_path: string;                     // converted to :param syntax
  request_schemas: Record<string, string>;  // "query"|"body"|... -> symbol id
  response_schemas: Record<string, { schema_symbol_id?: string; description?: string }>;
  middleware: string[];
  hidden: boolean;                       // hide: true
  file: string;
  line: number;
}

export interface RPCExport {
  export_name: string;                   // "AppType"
  file: string;
  line: number;
  shape: "full_app" | "route_group";    // slow pattern detection (Issue #3869)
  source_var: string;
}
```

### API Surface

#### Extended existing tools

**`trace_route`** (`src/tools/route-tools.ts`)
- `RouteHandler.framework` union extended with `"hono"`
- New `findHonoHandlers(repo: string, searchPath: string): Promise<RouteHandler[]>` calls `honoCache.get(repo, entryFile)` and matches the resolved route paths against `searchPath`
- `matchPath` helper extended to handle Hono regex constraints `:id{[0-9]+}`

**`search_patterns`** (`src/tools/pattern-tools.ts`)
- 7 new entries in `BUILTIN_PATTERNS` (all regex-based, no model access):
  - `hono-missing-error-handler` -- `new Hono()` in a file with no `.onError()` call
  - `hono-throw-raw-error` -- `throw new Error(...)` inside `(c: Context)` handler (suggest `HTTPException`)
  - `hono-missing-validator` -- `await c.req.json()` / `c.req.parseBody()` without preceding `zValidator` middleware on same route
  - `hono-unguarded-json-parse` -- `await c.req.json()` without try/catch
  - `hono-env-type-any` -- `new Hono()` without `<` generic parameter on the next line
  - `hono-missing-status-code` -- `c.json(` without explicit second argument (status)
  - `hono-full-app-rpc-export` -- `export type .* = typeof app\b` (slow pattern from Issue #3869)

**Note:** `hono-context-leak` (`c.set()` value never `c.get()` on reachable route) is NOT in `BUILTIN_PATTERNS` because it requires cross-file model analysis. It is surfaced exclusively via `trace_context_flow` and `audit_hono_security`, which read `HonoAppModel`.

**Framework scoping:** `BUILTIN_PATTERNS` has no framework filter. All `hono-*` patterns rely on `file_pattern` parameter for scoping (users pass `file_pattern="**/*.ts"` to limit to TS files; matches on non-Hono repos are advisory false positives). This limitation is documented in each pattern's description.

**`impact_analysis`** (`src/tools/impact-tools.ts`)
- Hono-aware augmentation: when a changed file contains middleware registered via `app.use()`, the blast radius includes all routes whose scope matches the middleware's scope pattern. Reads from `HonoAppModel.middleware_chains`.

**`find_dead_code`** (`src/tools/symbol-tools.ts` + `src/utils/framework-detect.ts`)
- `detectFrameworks` adds `"hono"` detection via scanning first 200 symbols for `from 'hono'` / `from "hono"` imports
- `isFrameworkEntryPoint(symbol, frameworks)` signature extended with optional third parameter `honoModel?: HonoAppModel`. When frameworks contains `"hono"` and `honoModel` is provided, symbols in `honoModel.files_used` that are referenced as handlers in `honoModel.routes`, middleware in `honoModel.middleware_chains`, or child_var in `honoModel.mounts` return true. `findDeadCode` in `symbol-tools.ts` calls `honoCache.peek(repoName)` — a new synchronous peek method that returns the currently cached model without triggering a build (returns null on cache miss). If null, Hono augmentation is skipped (acceptable degradation — dead code analysis still runs with other framework branches). `peek()` never triggers parsing, so it is safe to call synchronously in the dead-code scan hot path.

#### New core tools

**`trace_middleware_chain(repo, path, method?)`**
- Returns the ordered middleware chain for a given route
- Output type: `MiddlewareEntry[]` (full type from the Data Model section, includes `conditional`, `owner_var`, `expanded_from`)
- Uses `HonoAppModel.routes` to resolve the route, then walks `middleware_chains` whose `scope_pattern` compiles to a regex matching the route path, concatenating entries in registration order

**`analyze_hono_app(repo, entry_file?, force_refresh?)`**
- Meta-tool returning complete Hono overview: routes grouped by method and scope, middleware map, auth boundaries, context variables summary, OpenAPI status, RPC exports status (flags slow pattern from Issue #3869), runtime detection, env bindings list
- `force_refresh: true` calls `honoCache.clear(repo)` before rebuild — escape hatch for stale cache scenarios
- Output is a single JSON with all top-level `HonoAppModel` sections summarized

#### New hidden/discoverable tools

**`trace_context_flow(repo, variable?)`**
- For a variable name, returns all `set_points` and `get_points` with files, lines, and conditions
- Without `variable`: returns summary of all context variables
- Detects unguarded access: `get_points` in routes whose middleware scope does not include the setting middleware

**`extract_api_contract(repo, entry_file?, format?)`**
- Infers OpenAPI 3.1 schema from `HonoAppModel.openapi_routes` (explicit) and `HonoAppModel.routes` with `validators` (inferred)
- Format: `"openapi"` (JSON spec) or `"summary"` (human-readable table)
- Handles both `OpenAPIHono` routes and plain routes with `zValidator` middleware

**`trace_rpc_types(repo, server_file, client_file?)`**
- Maps server route types to client usage
- Identifies the RPC export pattern (`full_app` vs `route_group`) and flags slow pattern from Issue #3869
- If `client_file` provided: walks `hc<AppType>()` usage and verifies each client call has a matching server route
- Detects unused server routes and client calls with no matching server route

**`audit_hono_security(repo)`**
- Security-focused checks across the `HonoAppModel`:
  - Routes mutating state without CSRF protection
  - Mutation routes without rate limiting
  - Missing `secure-headers` middleware globally
  - Auth middleware registered after business logic in chain order
  - WebSocket endpoints without auth
  - Missing CORS configuration on public APIs
  - Hardcoded secrets in `c.env.*` access vs binding declarations
- Output: prioritized finding list (CRITICAL / HIGH / MEDIUM / LOW)

**`visualize_hono_routes(repo, format)`**
- Mermaid or ASCII tree diagram of route topology
- Shows mount hierarchy, middleware layers per scope, handler locations
- `format: "mermaid"` returns mermaid code, `format: "tree"` returns ASCII tree

### Integration Points

- **`src/parser/extractors/hono.ts`** (NEW) -- tree-sitter AST extractor. Depends on `@tree-sitter-typescript` (already a dependency). Uses the existing `parseTS` helper pattern from other extractors.
- **`src/parser/extractors/hono-model.ts`** (NEW) -- type definitions (`HonoAppModel` and all nested types).
- **`src/cache/hono-cache.ts`** (NEW) -- LRU cache with absolute-path-based invalidation. Max 10 entries, ~10MB each = 100MB cap. Session-scoped (no persistence). Exposes:
  - `get(repo, entryFile): Promise<HonoAppModel>` — async, builds on miss
  - `peek(repo): HonoAppModel | null` — sync, never builds (used by `findDeadCode`)
  - `invalidate(absolutePath): void` — invalidates any entry whose `files_used` contains that path
  - `clear(repo?): void` — force refresh
  - **Concurrent build protection**: `get()` stores an in-flight `Promise<HonoAppModel>` in an internal `buildingMap`. Concurrent callers during cold start await the same promise, preventing duplicate parsing.
- **`src/tools/index-tools.ts`** -- extend `handleFileChange(repoRoot, repoName, indexPath, relativeFile)` and `handleFileDelete` to call `honoCache.invalidate(join(repoRoot, relativeFile))`. NOT `src/storage/watcher.ts` (which is a callback library without repo context).
- **`src/tools/route-tools.ts`** -- add `findHonoHandlers` function, extend `RouteHandler.framework` type, add `"hono"` spread to `traceRoute` handler array.
- **`src/tools/project-tools.ts`** -- rewrite `extractHonoConventions` to use `HonoExtractor` and adapt the output to the existing `Conventions` shape. Remove `parseHonoCalls`, `extractMiddlewareName`, `extractRateLimit`, `inferScope` (replaced by extractor + model).
- **`src/tools/pattern-tools.ts`** -- add 7 entries to `BUILTIN_PATTERNS` (list matches Detailed Design section: `hono-missing-error-handler`, `hono-throw-raw-error`, `hono-missing-validator`, `hono-unguarded-json-parse`, `hono-env-type-any`, `hono-missing-status-code`, `hono-full-app-rpc-export`). `hono-context-leak` is NOT a regex pattern — it is surfaced via `trace_context_flow` and `audit_hono_security`.
- **`src/utils/framework-detect.ts`** -- add `"hono"` to `Framework` union, detect in `detectFrameworks`, handle in `isFrameworkEntryPoint`.
- **`src/tools/impact-tools.ts`** -- add Hono middleware blast radius augmentation (read `HonoAppModel.middleware_chains`).
- **`src/tools/symbol-tools.ts`** -- `findDeadCode` uses updated `isFrameworkEntryPoint`.
- **`src/tools/hono-middleware-chain.ts`** (NEW) -- `trace_middleware_chain` tool
- **`src/tools/hono-analyze-app.ts`** (NEW) -- `analyze_hono_app` tool
- **`src/tools/hono-context-flow.ts`** (NEW) -- `trace_context_flow` tool
- **`src/tools/hono-api-contract.ts`** (NEW) -- `extract_api_contract` tool
- **`src/tools/hono-rpc-types.ts`** (NEW) -- `trace_rpc_types` tool
- **`src/tools/hono-security.ts`** (NEW) -- `audit_hono_security` tool
- **`src/tools/hono-visualize.ts`** (NEW) -- `visualize_hono_routes` tool
- **`src/register-tools.ts`** -- add 7 `ToolDefinition` entries; add `trace_middleware_chain` and `analyze_hono_app` to `CORE_TOOL_NAMES`; bump `EXTRACTOR_VERSIONS.hono` to `"2.0.0"`.
- **`package.json`** -- update `description` field (currently says "66 tools", stale; update to "95 tools"). Add `"bench:hono": "tsx tests/benchmarks/hono-token-comparison.ts"` to scripts.
- **`src/instructions.ts`** -- add Hono-aware hints to `CODESIFT_INSTRUCTIONS` (e.g., "For Hono endpoint tracing, use `trace_middleware_chain` before `trace_route` for context").
- **`tests/fixtures/hono/`** (NEW) -- 5 fixture directories.
- **`tests/parser/hono-extractor.test.ts`** (NEW) -- extractor unit tests (~40 tests covering routes, middleware, context, openapi, rpc, mounts).
- **`tests/tools/hono-*.test.ts`** (NEW) -- per-tool integration tests (~45 tests across 7 new tools).
- **`tests/tools/project-tools.test.ts`** -- existing 31 Hono tests rewritten against new extractor output.
- **`tests/cache/hono-cache.test.ts`** (NEW) -- cache hit/miss/invalidation tests.
- **`CLAUDE.md`**, **`README.md`**, **`rules/codesift.md`**, **`rules/codesift.mdc`**, **`rules/codex.md`**, **`rules/gemini.md`** -- update tool counts (88 to 95), add Hono tool mappings.
- **`../codesift-website/`** -- update tool count everywhere (llms.txt, llms-full.txt, Hero, FeatureGrid, Footer, Problem, Nav, Pricing, BaseLayout, index, tools/index, how-it-works, benchmarks, articles/index). Build and deploy.
- **`tests/benchmarks/hono-token-comparison.ts`** (NEW) — benchmark script for Success Criterion 1.
- **`tests/parser/hono-extractor-benchmark.test.ts`** (NEW) — parse time benchmark for Ship Criterion 18.
- **`tests/cache/hono-cache-benchmark.test.ts`** (NEW) — cache hit rate benchmark for Ship Criterion 17.
- **`tests/integration/hono-invalidation.test.ts`** (NEW) — end-to-end cache invalidation test for Success Criterion 3.

### Acceptance Criteria (detailed)

These are the full definitions referenced in Ship Criteria. Each is a single testable assertion.

**Routing (`findHonoHandlers` in `trace_route`):**
- **AC-R1**: Given `app.get("/api/health", (c) => c.json({status:"ok"}))` in a single-file Hono app, `trace_route(repo, "/api/health")` returns a `RouteHandler` with `framework: "hono"`, `method: "GET"`, and correct `file`.
- **AC-R2**: Given `app.route("/api/users", usersRouter)` where `usersRouter.get("/:id", handler)` is in a separate file, `trace_route(repo, "/api/users/:id")` returns the handler in the sub-router file.
- **AC-R3**: Given `app.all("/api/*", handler)`, `trace_route(repo, "/api/anything")` returns `method: "ALL"`.
- **AC-R4**: Given `app.on(["GET","POST"], "/api/items", handler)`, `trace_route(repo, "/api/items")` returns two `RouteHandler` entries (one GET, one POST).
- **AC-R5**: Given `app.get("/posts/:id{[0-9]+}", handler)`, `trace_route(repo, "/posts/42")` matches and `trace_route(repo, "/posts/abc")` returns empty.
- **AC-R6**: Given `const v1 = app.basePath("/v1"); v1.get("/users", handler)`, `trace_route(repo, "/v1/users")` returns the handler.
- **AC-R7**: Given `app.mount("/legacy", expressHandler)`, `trace_route(repo, "/legacy/foo")` returns a result indicating mounted-external (not empty).
- **AC-R8**: Given `const api = factory.createApp(); api.get("/ping", h)` (variable not named `app`), `trace_route(repo, "/ping")` resolves the handler.
- **AC-R9**: Given `app.openapi(createRoute({ method: "get", path: "/items" }), handler)`, `trace_route(repo, "/items")` returns the handler.

**Middleware (`extractHonoConventions` + `trace_middleware_chain`):**
- **AC-M1**: Given `app.use("*", some(authMw, publicMw))`, the extracted chain contains both `authMw` and `publicMw` with `expanded_from: "some"`, `conditional: true`.
- **AC-M2**: Given `app.use("*", (c, next) => { return next(); })`, chain entry has `name: "<inline>"`, `inline: true`.
- **AC-M3**: Given `const reqLogger = factory.createMiddleware(...); app.use("*", reqLogger)`, chain entry has `name: "reqLogger"`.
- **AC-M4**: Given `const adminChain = [authMw, tenantMw]; app.use("/admin/*", ...adminChain)`, both `authMw` and `tenantMw` appear in the `/admin/*` scope.
- **AC-M5**: Given `import { cors } from "hono/cors"; app.use("*", cors())`, chain entry has `is_third_party: true`, `imported_from: "hono/cors"`.

**Context flow (`trace_context_flow`):**
- **AC-C1**: Given middleware `app.use("*", (c, next) => { c.set("userId", "x"); return next(); })` and route `app.get("/me", (c) => c.json({ id: c.var.userId }))`, `trace_context_flow(repo, "userId")` returns the middleware as the single `set_point` and the `/me` handler as a `get_point`.
- **AC-C2**: Given `if (isAdmin) { c.set("role", "admin") }` inside middleware, the set_point has `condition: "conditional"`.
- **AC-C3**: Given `app.use("*", contextStorage())` and a service function calling `getContext().var.userId`, the tool links that access to the same `userId` variable with `via_context_storage: true`.
- **AC-C4**: Given `c.env.DATABASE_URL` and `c.var.tenantId` accessed in the same handler, `DATABASE_URL` has `is_env_binding: true` and `tenantId` has `is_env_binding: false`, reported separately.
- **AC-C5**: Given `/api/public/items` accesses `c.var.userId` but `authMw` setting it is scoped to `/api/admin/*`, `trace_context_flow` reports a `MISSING_CONTEXT_VARIABLE` finding for that route.

**Dead code (`find_dead_code`):**
- **AC-D1**: Given `app.route("/api/legacy", legacyRouter)` where `legacyRouter` is exported but never directly imported elsewhere, `find_dead_code` does NOT flag `legacyRouter` as dead.
- **AC-D2**: Given `app.use("/api/internal/*", blockAllMw)` where `blockAllMw` never calls `next()`, followed by `app.get("/api/internal/data", handler)`, a dead-route finding flags `/api/internal/data` as unreachable.
- **AC-D3**: Given `export const userRoutes = new Hono()` mounted via `app.route("/users", userRoutes)`, `isFrameworkEntryPoint(userRoutes, frameworks, honoModel)` returns true and `find_dead_code` does not flag it.

**Anti-patterns (`search_patterns`):**
- **AC-P1**: Given a route `app.post("/items", (c) => { const body = await c.req.json(); ... })` without any `zValidator`, `search_patterns(repo, "hono-missing-validator")` returns a match for that file and line.
- **AC-P2**: Given `const data = await c.req.json()` without surrounding try/catch, `search_patterns(repo, "hono-unguarded-json-parse")` returns a match.
- **AC-P3**: Given a Next.js project scanned with `search_patterns(repo, "hono-missing-validator")` restricted to files that `import` from `"hono"` (via `file_pattern` gating or caller-side filter), zero matches are returned. The pattern may have advisory false positives on non-Hono files without this gating; the caller is responsible for scoping.

**Meta tool (`analyze_hono_app`):**
- **AC-A1**: Given the `basic-app` fixture (single file, 5 routes, 2 middleware), `analyze_hono_app(repo)` returns a non-empty `HonoAppModel` with `extraction_status: "complete"`, all 5 routes in `routes`, both middleware in `middleware_chains`.
- **AC-A2**: Given the `subapp-app` fixture (3 files, `app.route()` composition with `/api` and `/admin` sub-routers), `analyze_hono_app(repo)` returns routes from all 3 files with fully-resolved paths (e.g., `/api/users/:id`, `/admin/settings`).
- **AC-A3**: Given a Cloudflare Workers fixture (`export default app` with `c.env` bindings), `analyze_hono_app(repo)` returns `runtime: "cloudflare"` and `env_bindings` populated.

**Impact analysis (`impact_analysis`):**
- **AC-I1**: Given a middleware registered via `app.use("*", globalAuth)` that is changed (`git diff` detects file), `impact_analysis(repo, since="HEAD~1")` includes all routes in the affected list (not just direct call-graph callers).
- **AC-I2**: Given a non-Hono repo (no `HonoAppModel` in cache, `honoCache.get()` returns null), `impact_analysis` runs without error and returns results without Hono augmentation.

---

### Edge Cases

Drawn from Business Analyst findings (Phase 1). Each mapped to specific acceptance criteria above.

**Routing:**
- Recursive `app.route()` mounting -- resolver must follow imports and handle multi-level composition (AC-R2)
- `app.basePath()` -- prefix must be applied to all routes registered on the cloned instance (AC-R6)
- `app.mount()` of non-Hono app -- recorded as `mount_type: "hono_mount"` with `framework: "unknown"` in trace_route output (AC-R7)
- `app.on(method, path, handler)` and `app.on([methods], [paths], handler)` -- fan out to multiple routes (AC-R4)
- `app.all("/path", handler)` -- `method: "ALL"` matches any HTTP method in `trace_route` path matching (AC-R3)
- Regex parameter constraints `:id{[0-9]+}` -- stored in `regex_constraint` field, `matchPath` extracts parameter name correctly (AC-R5)
- `factory.createApp()` with non-`app` variable -- `app_variables` map tracks all variables bound to Hono instances (AC-R8)
- `OpenAPIHono.openapi(createRoute(...), handler)` -- extractor parses object literal argument, maps to `OpenAPIRoute` (AC-R9)

**Middleware:**
- `some(mw1, mw2)` / `every(mw1, mw2)` from `hono/combine` -- inner middleware expanded into chain entries with `expanded_from: "some"` and `conditional: true` for `some()` (AC-M1)
- Inline arrow middleware -- `name: "<inline>"` with `inline: true` (AC-M2)
- `factory.createMiddleware()` bound to a variable -- middleware chain entry uses variable name (AC-M3)
- Spread middleware array `...adminChain` -- spread expansion follows the variable to its declaration and inlines the entries (AC-M4)
- Third-party middleware from `hono/cors` etc. -- `is_third_party: true`, `imported_from: "hono/cors"` (AC-M5)

**Context flow:**
- `c.set` inside if/branch -- `condition: "conditional"` (AC-C2)
- `c.var.x` in route whose middleware scope does not include the setting middleware -- detected by matching scope regex; reports `MISSING_CONTEXT_VARIABLE` finding in `trace_context_flow` and `audit_hono_security` (AC-C5)
- `contextStorage()` + `getContext()` pattern -- `getContext()` calls outside handler scope detected as `via_context_storage: true` and linked to the same variable (AC-C3)
- `c.env.X` vs `c.var.X` -- `is_env_binding: true` for `c.env`, kept separate in model (AC-C4)

**Dead code:**
- Sub-app exported and mounted via `app.route()` (string-based registration, no symbol-level call edge) -- `isFrameworkEntryPoint` returns true for symbols in `HonoAppModel.files_used` that are exported Hono instances (AC-D3)
- Route handler referenced only via `app.get("/path", handlerName)` -- same mechanism (AC-D1)
- Route behind middleware that never calls `next()` -- flagged by `audit_hono_security` and optionally by `find_dead_code` (AC-D2)

**Anti-patterns:**
- `search_patterns` has no framework scoping mechanism today -- new patterns are prefixed `hono-*` and rely on `file_pattern` for scoping (AC-P3)

### Failure Modes

#### HonoExtractor (tree-sitter parsing)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Tree-sitter parser throws on malformed TS/JS file | try/catch around `parser.parse()` | Extraction for that file only | Partial model, file in `skip_reasons` | Skip file, continue with others | Model marked `extraction_status: "partial"` | Immediate |
| Sub-app import cannot be resolved (file moved/deleted) | File read fails with ENOENT | That sub-app subtree | Empty mount entry with `child_file: null` | Log warning, mark mount as unresolved | Mount present with unresolved marker | Immediate |
| Circular sub-app reference (A mounts B, B mounts A) | Cycle detection in resolver (visited set) | That cycle | Cycle breaks at second visit, logs warning | Treat second visit as terminal leaf | Routes from first visit recorded, second visit skipped | Immediate |
| Entry file is not a Hono app (no `new Hono()` found) | Extractor returns `app_variables.size === 0` | Entire call | Empty model with `extraction_status: "complete"` | Tool handles empty model gracefully (returns "no Hono app detected") | Valid empty model | Immediate |
| Tree-sitter dependency not loaded | Import check at extractor init | All Hono tools | "Hono support not available" error | Fall back to legacy regex extractor (if kept) or error out | No model built | Immediate |
| Very large file (>MAX_PARSE_BYTES) | Size check before parsing (consistent with `MAX_SOURCE_LENGTH` in `src/parser/extractors/_shared.ts`) | That file only | File skipped, `skip_reasons["file_too_large"]++` | Skip file, continue | Partial model | Immediate |

**Cost-benefit:** Frequency: low (most Hono files are well-formed, parser is stable) x Severity: low-medium (partial model still useful) -> Mitigation cost: moderate (try/catch + skip_reasons) -> **Decision: Mitigate**

#### HonoCache

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Stale cache (file changed but invalidation missed) | Manual via `extraction_status` mismatch on re-check | That repo's Hono queries | Wrong results returned | Manual cache clear via `honoCache.clear()`, or restart session | Stale data served until detected | Until user notices (potentially long) |
| Memory pressure (LRU exceeds max size) | LRU eviction on insert | Least recently used entries | Cold cache miss on next call, slight delay | Automatic LRU eviction | Evicted entries re-built on demand | Immediate |
| Concurrent cold-start builds (two tools call `get()` before first `parse()` resolves) | Internal `buildingMap: Map<key, Promise<HonoAppModel>>` | None (if handled) | None | Both callers await the same promise | None — single build shared | Immediate | N/A |
| Watcher hook not called (file edited outside watched dirs) | No signal | That file's contribution to model | Stale model | Falls back to session lifetime | Stale data | Until session end |
| Invalidation cascades (many files changed at once) | Multiple invalidate calls | Cache entries for affected repos | Next call is cold | Automatic rebuild on next access | Eventually consistent | Next tool call |

**Cost-benefit:** Frequency: medium (file edits during session common) x Severity: high (wrong results undermine trust) -> Mitigation cost: low (hooks already exist, just wire them up) -> **Decision: Mitigate aggressively. Add extensive invalidation tests.**

#### findHonoHandlers (in trace_route)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| No entry file detected (no orchestrator classified) | `file_classifications.critical` has no ORCHESTRATOR | Entire trace_route call for Hono | Empty handlers array | Return empty list, document in trace output | None | Immediate |
| Hono model extraction fails | Exception caught in findHonoHandlers | Hono portion only | Hono handlers empty, other frameworks still work | Return empty, log error | Other framework handlers still returned | Immediate |
| Path matches multiple Hono routes (e.g., wildcard overlap) | Multiple matches after `matchPath` | That trace_route call | Multiple handlers returned in priority order | Order by specificity (literal > param > wildcard) | All matches returned | Immediate |
| Route defined in OpenAPIHono with `hide: true` | `openapi_routes[i].hidden === true` | That specific route | Route is still returned (hidden only affects OpenAPI doc) | No recovery needed | Correct behavior | Immediate |

**Cost-benefit:** Frequency: common (every trace_route call on Hono repo) x Severity: medium (wrong routes -> wrong debug path) -> Mitigation cost: low (basic error handling) -> **Decision: Mitigate**

#### Extended `extractHonoConventions` (backward compat adapter)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| New extractor returns shape different from legacy | Unit tests | `analyze_project`, `audit_scan` calls | Conventions object missing fields | Re-run against legacy snapshot | Broken downstream | Immediate (caught by tests) |
| Middleware names differ from legacy (e.g., "(inline handler)" vs "<inline>") | Unit tests | Convention output consumers | Display change in `buildConventionsSummary` | Update snapshots, document migration | Cosmetic only | Immediate |
| Performance regression (AST parse vs regex scan) | Benchmark in CI | Index time for Hono projects | Slower `analyze_project` call | Optimize hot paths, add cache | No data loss | Benchmark-time |

**Cost-benefit:** Frequency: one-time migration event x Severity: high (breaks existing downstream) -> Mitigation cost: moderate (snapshot tests) -> **Decision: Mitigate with snapshot tests before swap**

#### search_patterns (Hono anti-patterns)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Hono pattern fires on non-Hono code (e.g., Express) | Integration tests | False positives in `search_patterns("hono-*")` results | User sees spurious matches | Document `file_pattern` workaround; patterns are regex so no framework scoping possible | None | Immediate |
| Regex has catastrophic backtracking on large file | AbortSignal.timeout on search | That file | Search takes minutes | Timeout kills search, logs warning | Incomplete results | 10s+ |
| Pattern regex bug matches unrelated code | Manual review | All `search_patterns("hono-*")` results | Wrong findings | Fix regex, add test | None | Until reviewed |

**Cost-benefit:** Frequency: low (patterns are namespaced `hono-*`) x Severity: low (findings are advisory) -> Mitigation cost: low (document scoping) -> **Decision: Accept, document `file_pattern` usage in tool description**

#### impact_analysis (Hono middleware augmentation)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Middleware scope regex does not match any routes | Scope regex compiles but zero matches | That middleware's blast radius | No additional affected routes reported | Fall back to static call graph analysis | Possibly under-reported | Immediate |
| `HonoAppModel` not built for the repo (not a Hono project) | `honoCache.get()` returns null | None -- non-Hono behavior | Regular impact analysis runs | Skip Hono augmentation | Correct for non-Hono | Immediate |
| Middleware change in a shared utility affects multiple Hono apps | N/A -- one repo one app typically | That repo | Report includes all mount scopes | Already handled | Correct | Immediate |

**Cost-benefit:** Frequency: middleware edits are common x Severity: medium (under-report = missed test runs) -> Mitigation cost: low (augmentation is additive) -> **Decision: Mitigate**

#### 7 new tools (overall)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Tool called on non-Hono repo | `honoCache.get()` returns empty model | That tool call | "No Hono app detected in this repo" error | Clear error message, suggest `analyze_project` to verify framework | None | Immediate |
| Tool called with invalid path (e.g., path does not exist in app) | Path match returns empty | That tool call | "No route matching /foo/bar" message | Suggest `analyze_hono_app` to list available routes | None | Immediate |
| Tool called before index built | Index missing | That tool call | "Repo not indexed, run index_folder first" | Error message with command hint | None | Immediate |
| Multiple Hono entry files in repo (e.g., apps/api and apps/worker) | Multiple `new Hono()` roots detected | Ambiguous | Tool requires `entry_file` parameter | Document; default to first found, warn | None | Immediate |

**Cost-benefit:** Frequency: happens whenever users misuse tool x Severity: low (error message suffices) -> Mitigation cost: trivial -> **Decision: Mitigate with clear error messages**

## Acceptance Criteria

**Ship criteria** (must pass for release -- deterministic, fact-checkable):

1. All 944+ existing CodeSift tests pass (no regression)
2. Existing 31 `extractHonoConventions` tests pass against rewritten AST-based implementation (after adjusting snapshots for known shape changes documented in migration notes)
3. New `HonoExtractor` unit test suite passes (~40 tests covering all `HonoAppModel` sections)
4. All acceptance criteria AC-R1 through AC-R9 (routing) pass against the new `findHonoHandlers`
5. All acceptance criteria AC-M1 through AC-M5 (middleware) pass against the new extractor
6. All acceptance criteria AC-C1 through AC-C5 (context flow) pass against `trace_context_flow`
7. All acceptance criteria AC-D1 through AC-D3 (dead code) pass
8. All acceptance criteria AC-P1 through AC-P3 (anti-patterns) pass
9. All acceptance criteria AC-A1 through AC-A3 (`analyze_hono_app`) pass
10. All acceptance criteria AC-I1 through AC-I2 (`impact_analysis`) pass
11. `tests/fixtures/hono/basic-app/`, `subapp-app/`, `openapi-app/`, `factory-app/`, `basepath-app/` all created with runnable TypeScript source
12. `trace_middleware_chain` and `analyze_hono_app` are registered as core tools in `CORE_TOOL_NAMES`
13. `trace_context_flow`, `extract_api_contract`, `trace_rpc_types`, `audit_hono_security`, `visualize_hono_routes` are registered as discoverable (hidden) tools
14. `CLAUDE.md` (lines 55, 60), `README.md` (line 318), `src/instructions.ts` (line 5), `package.json` (description field), `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md` all updated to "95 tools (39 core + 56 discoverable)"
15. `src/register-tools.ts::EXTRACTOR_VERSIONS.hono` bumped to `"2.0.0"`
16. `src/instructions.ts` updated with Hono tool hints
17. `HonoCache` cache hit rate >90% on repeated tool calls for the same repo within a session (measured in benchmark test)
18. Benchmark: `HonoExtractor.parse()` on 10-file Hono project completes in under 200ms cold, under 5ms warm (from cache)
19. `adversarial-review.sh --mode spec` (at `~/.claude/plugins/cache/zuvo-marketplace/zuvo/*/scripts/adversarial-review.sh`) passes without CRITICAL findings
20. Zero TypeScript compiler errors on build
21. Snapshot test `tests/tools/hono-conventions-snapshot.test.ts` asserts that new `extractHonoConventions` output for the `basic-app` fixture matches a recorded golden file; any diff between old and new output is enumerated in release notes
22. Caller audit for `"(inline handler)"` and `"<inline>"` string literals is documented in the PR description; all consumers verified

**Success criteria** (must pass for value validation -- measurable quality/efficiency):

1. **Benchmark comparison**: The script `tests/benchmarks/hono-token-comparison.ts` runs two code paths on the `subapp-app` fixture and emits a JSON record `{baseline_tokens, tool_tokens, reduction_pct}`. Baseline procedure: 6 `search_text` calls for route path `/api/admin/users/:id`, handler name, middleware names, plus 3 `Read` calls for full files (index.ts, routes/admin.ts, middleware/auth.ts). Tool procedure: 1 `trace_middleware_chain` call + 1 `trace_route` call. Pass condition: `reduction_pct >= 70`. Target query: "Trace the request flow for GET /api/admin/users/:id and list all middleware."
2. **Cold-start parse time**: `HonoExtractor.parse()` on a real-world Hono project with 20+ route files completes in under 500ms on a MacBook M1 (measured via `time` on benchmark script).
3. **Cache invalidation correctness**: Integration test that edits a file in `subapp-app`, calls `trace_middleware_chain`, edits the same file again, calls again -- verifies the second call returns updated results, proving invalidation works end-to-end.
4. **Discoverability**: Running `discover_tools(query="hono")` returns all 7 new Hono tools plus existing Hono-related tools (e.g., `analyze_project` with Hono conventions).
5. **Real-world validation**: Run `analyze_hono_app` on at least one external Hono project (e.g., a test run against `honojs/hono` itself or a sample Cloudflare Workers app) and verify it produces a complete, non-empty model.

## Validation Methodology

Each criterion is measured via a specific command or test:

- **Ship criteria 1-16 (tests and code changes):**
  ```bash
  npm test
  npm run build
  grep -rn "95 tools\|95 MCP" CLAUDE.md README.md rules/ src/instructions.ts
  ```

- **Ship criterion 17 (cache hit rate):** New test file `tests/cache/hono-cache-benchmark.test.ts` measures hit/miss counts over 100 simulated tool calls.

- **Ship criterion 18 (parse time benchmark):** New test file `tests/parser/hono-extractor-benchmark.test.ts` uses `performance.now()` to measure cold and warm parse times on the `subapp-app` fixture, asserts thresholds.

- **Ship criterion 19 (adversarial review):**
  ```bash
  adversarial-review --mode spec --files "docs/specs/2026-04-10-hono-framework-intelligence-spec.md"
  ```

- **Ship criterion 20 (TS compile):**
  ```bash
  npm run build
  # Assert: exit code 0
  ```

- **Success criterion 1 (token comparison):** New benchmark script `tests/benchmarks/hono-token-comparison.ts` that simulates both approaches on the `subapp-app` fixture and compares token counts. Run via `npm run bench:hono`.

- **Success criterion 2 (parse time on real-world):** Manual test on a real Hono project checked out locally. Document the result in `docs/benchmarks/hono-v1.md`.

- **Success criterion 3 (invalidation end-to-end):** New test file `tests/integration/hono-invalidation.test.ts` that performs the edit-query-edit-query sequence.

- **Success criterion 4 (discoverability):** Integration test in `tests/tools/register-tools.test.ts` that calls `discover_tools(query="hono")` and asserts all 8 tool names appear.

- **Success criterion 5 (real-world validation):** Manual test documented in `docs/benchmarks/hono-v1.md` with the `HonoAppModel` JSON output attached.

## Rollback Strategy

**Kill switch:** The legacy regex implementation is preserved in a new file `src/tools/legacy-hono-conventions.ts` (created by copying the current `parseHonoCalls`, `extractMiddlewareName`, `extractRateLimit`, `extractHonoConventions`, `inferScope` functions verbatim from `project-tools.ts`). The new `extractHonoConventions` in `project-tools.ts` reads `process.env.CODESIFT_LEGACY_HONO` at call time:

```typescript
export async function extractHonoConventions(source: string, filePath: string): Promise<Conventions> {
  if (process.env.CODESIFT_LEGACY_HONO === "1") {
    const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
    return legacyExtractHonoConventions(source, filePath);
  }
  return honoExtractorAdapter(source, filePath);
}
```

**Fallback behavior:**
- If `CODESIFT_LEGACY_HONO=1`: `analyze_project` and `audit_scan` use the legacy extractor verbatim. New Hono tools (`trace_middleware_chain`, `analyze_hono_app`, etc.) always use the new AST extractor regardless of this flag — they have no legacy equivalent.
- If `HonoExtractor.parse()` throws for any reason: `extractHonoConventions` catches the exception and falls back to `legacyExtractHonoConventions` with a logged warning. New Hono tools return the error in their response rather than falling back (they have no legacy equivalent).

**Data preservation during rollback:**
- `HonoCache` is in-memory only, so there is no persisted data to migrate back.
- `EXTRACTOR_VERSIONS.hono` is bumped from `"1.0.0"` to `"2.0.0"`. Any downstream consumers that check the version can branch on it.
- Fixtures under `tests/fixtures/hono/` are kept regardless of rollback (additive only).

**Removal of kill switch:** After two weeks of stable operation without rollback, `legacy-hono-conventions.ts` and the `CODESIFT_LEGACY_HONO` branch are deleted in a follow-up commit.

## Backward Compatibility

**Affected existing state:**

- **`Conventions` object shape** (consumed by `analyze_project`, `audit_scan`, `buildConventionsSummary`): the public shape is preserved. Internal middleware name format changes from `"(inline handler)"` to `"<inline>"`. **Caller audit required before merge**: grep for `"(inline handler)"` and `"<inline>"` in `src/tools/*.ts` and `tests/**/*.test.ts` to enumerate every consumer. Initial audit finds: `project-tools.ts:678` (the only emit site), `buildConventionsSummary` uses the name field in LLM-facing string output. LLM consumers see a formatted string, not the raw value — the change is display-only but the exact output string format MUST be preserved across the migration (tests verify string equality). Add a snapshot test in `tests/tools/hono-summary.test.ts` that asserts `buildConventionsSummary` output matches a golden file for both old and new extractor outputs.
- **`EXTRACTOR_VERSIONS.hono`** bumped from `"1.0.0"` to `"2.0.0"`. Consumers that pin to a version will need to bump.
- **Indexed repos** -- no CodeIndex schema changes. Existing indexes continue to work. Hono tools build `HonoAppModel` on-demand from source.
- **`RouteHandler.framework` union** extended with `"hono"`. Consumers pattern-matching on this union must add a Hono branch (internal only, no external API).
- **`CORE_TOOL_NAMES`** set grows by 2. Agents doing discovery by listing core tools will see the new additions -- strictly additive, no removals.

**Precedence during migration:**
- Default behavior: new AST extractor is used
- Override: `CODESIFT_LEGACY_HONO=1` falls back to old regex
- After 2-week migration window: legacy is removed, override no longer works

**Deprecation timeline:**
- Week 0: Release new extractor + legacy kept as kill switch
- Week 1: Monitor production for issues, fix any reported regressions
- Week 2: Delete `legacy-hono-conventions.ts`, remove env var branch, publish follow-up commit

**Migration path:**
- No user action required in typical usage
- If user code consumes `Conventions` with the old `"(inline handler)"` name format, they should update to `"<inline>"`. Documented in release notes.

## Out of Scope

### Deferred to v2

- **`validate_hono_contracts` tool**: Originally scoped for hidden tier in this spec. Deferred because accurate handler return-type validation requires LSP integration (also deferred) to avoid high false-positive rates. A reduced-scope version (schema completeness check only: every `openapi_route` has `response_schemas` entry) may land in the v2 spec.
- **Live runtime mode** (like Next.js DevTools MCP): connecting to a running Hono dev server to read live errors, logs, page metadata. Valuable but different architecture (HTTP endpoint rather than static analysis). Deferred because static mode is the higher-leverage starting point.
- **HonoX (meta-framework) file-system routing**: HonoX uses file-based routing on top of Hono. Requires file-system walk + convention mapping, similar to Next.js app router. Deferred because HonoX adoption is small compared to plain Hono.
- **Express-to-Hono migration analysis tool**: Detect Express patterns in user code and suggest Hono equivalents. Valuable for the 26.6% MoM migration trend but a separate feature requiring bidirectional framework knowledge.
- **Type resolver integration with LSP**: Use the LSP bridge (`src/lsp/`) to resolve Hono generic types accurately rather than inferring from source. Would enable precise RPC type flow analysis. Deferred because it requires LSP stability improvements.
- **Semgrep rule pack for Hono**: Export Hono anti-patterns as Semgrep rules for users who prefer that tool. Deferred because it is a distribution concern, not a CodeSift feature.
- **Runtime introspection via `inspectRoutes(app)` harness**: Optional mode that imports and executes the user's Hono app in a sandbox to capture runtime route state. Orthogonal to static analysis. Deferred.

### Permanently out of scope

- **Hono bindings for runtimes other than TypeScript/JavaScript**: Hono is JS-only. No Hono-in-Python, no Hono-in-Go.
- **Automatic code fixes**: Anti-pattern detection reports issues; automatic rewriting is out of scope (not CodeSift's role).
- **Hono version-specific migration** (e.g., v3 to v4 upgrade codemods): Out of scope for a code intelligence tool.

## Open Questions

None remaining from Phase 2 clarifying questions. All user decisions captured in Design Decisions section (D1-D7).

Any additional questions raised by the spec reviewer or adversarial review will be added here before implementation begins.
