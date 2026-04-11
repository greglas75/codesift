# Implementation Plan: Hono Intelligence Phase 2 — 8 New Tools

**Spec:** inline — no spec (direct plan from user/session analysis)
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 1
**status:** Completed
**Created:** 2026-04-11
**Approved:** 2026-04-11T08:53:00Z
**Completed:** 2026-04-11T19:20:00Z
**Tasks:** 14 — all shipped + 3 post-release polish commits on feat/hono-polish
**Estimated complexity:** 5 standard, 9 complex

## Background

Phase 1 (25 tasks, committed 2026-04-10/11) delivered `HonoExtractor`, `HonoCache`, and 7 Hono tools (2 core + 5 hidden) with auto-enable for `package.json` with hono deps. Phase 1 is production-quality and validated on `honojs/examples/blog`.

Phase 2 closes gaps surfaced by that real-project validation and by competitive research on unresolved Hono GitHub issues:

**Real demo gaps (honojs/examples/blog):**
1. All 7 handlers are `(c) => c.json(...)` inline arrows — zero handler body introspection
2. `audit_hono_security` reported false positive for auth wrapped conditionally inside inline middleware
3. Runtime detected as "unknown" despite clear Cloudflare Workers signals (Bindings type with c.env.USERNAME/PASSWORD)
4. Local sub-apps declared in same file (`const middleware = new Hono()`) show `child_file: "?"`
5. OpenAPI `request_schemas`/`response_schemas` fields never populated

**Competitive gaps (GitHub issues):**
- Issue #3587: middleware chain type regression with 3+ entries (intermediate middleware lose custom Env type)
- Issue #4270: error response types not inferrable in RPC client
- Issue #2489: pure RPC types — backend env bindings leak to frontend types
- Issue #4121: architecture guidance for enterprise Hono apps (no module boundaries)

## Architecture Summary

Three layers:

**Layer A: HonoExtractor extensions (shared infrastructure, tasks 1-5)**
- `walkInlineHandlerBodies` — scans `arrow_function` / `function_expression` bodies inside `app.get/post/etc.()` calls, extracts DB calls, fetch calls, `c.json/text/html(value, status?)` responses, `throw new HTTPException(N)` errors, `c.set/c.get/c.var.*` access, validator references
- `walkConditionalMiddleware` — walks inline middleware bodies for `if (cond) return mw(c, next)` patterns
- `detectRuntimeAdvanced` — expanded signal set for runtime detection
- `walkRouteMounts` fallback — local sub-app support when childVar is in `localAppVars` and not in `importMap`
- `extractOpenAPISchemas` — parses `request.params/body/query` and `responses[statusCode]` from createRoute() object literals

**Layer B: New tool files (tasks 6-11)**
- `src/tools/hono-inline-analyze.ts` — `analyze_inline_handler`
- `src/tools/hono-conditional-middleware.ts` — `trace_conditional_middleware`
- `src/tools/hono-response-types.ts` — `extract_response_types`
- `src/tools/hono-env-regression.ts` — `detect_middleware_env_regression`
- `src/tools/hono-modules.ts` — `detect_hono_modules`
- `src/tools/hono-dead-routes.ts` — `find_dead_hono_routes`

**Layer C: Wiring (tasks 12-14)**
- Register 6 new tools in `TOOL_DEFINITIONS`, extend `HONO_TOOLS` auto-load list
- Update `audit_hono_security` to consume new `applied_when` data and new runtime detection
- Real-project validation + benchmark update

## Technical Decisions

- **No new extractor file.** All Layer A work extends `src/parser/extractors/hono.ts` since it already has the AST walking infrastructure. A 1000-line file grows to ~1500 — still manageable, and splitting would break cache/model integration.
- **Shared `InlineHandlerAnalyzer` class.** Inline handler body extraction is used by at least 3 tools (analyze_inline_handler, extract_response_types, audit_hono_security improvements). Implement once as a class with methods like `extractResponses()`, `extractDbCalls()`, `extractSideEffects()`, called from `walkInlineHandlerBodies`.
- **`HonoRoute.inline_analysis` optional field.** Populated only when the handler is inline. Avoids model bloat for named-handler routes.
- **Model boundary detection uses existing data.** `detect_hono_modules` doesn't need new AST walking — it clusters based on shared middleware chains, scope patterns, and env binding access already in the model.
- **RPC client scanning uses `search_text`.** For `find_dead_hono_routes`, no new AST walker — grep for `hc<>()` + `.$get/.$post` patterns via existing `search_text` tool, join against model.routes.
- **Middleware env regression is static type analysis.** Detects `createMiddleware(` (implicit BlankEnv) vs `createMiddleware<EnvType>(` in chains of 3+ entries. Requires looking at middleware declaration file AST.
- **Runtime detection additive, not replacing.** `detectRuntimeAdvanced` is a new private method called after `detectRuntime`. If existing returns `"unknown"`, try the new signals. Preserves Phase 1 test coverage.

### File structure after Phase 2:

```
src/parser/extractors/
  hono.ts                            [EXTENDED +400 lines]
  hono-model.ts                      [EXTENDED — new interfaces]
  hono-inline-analyzer.ts            [NEW — shared inline body analysis]

src/tools/
  hono-middleware-chain.ts           [unchanged]
  hono-analyze-app.ts                [unchanged]
  hono-context-flow.ts               [unchanged]
  hono-api-contract.ts               [EXTENDED — uses new response schemas]
  hono-rpc-types.ts                  [unchanged]
  hono-security.ts                   [EXTENDED — uses applied_when + new runtime]
  hono-visualize.ts                  [unchanged]
  hono-inline-analyze.ts             [NEW — P0 tool]
  hono-conditional-middleware.ts     [NEW — P0 tool]
  hono-response-types.ts             [NEW — P1 tool]
  hono-env-regression.ts             [NEW — P1 tool]
  hono-modules.ts                    [NEW — P2 tool]
  hono-dead-routes.ts                [NEW — P2 tool]
  legacy-hono-conventions.ts         [unchanged]

tests/parser/
  hono-extractor.test.ts             [EXTENDED — new assertions per extension]
  hono-inline-analyzer.test.ts       [NEW — unit tests for analyzer class]

tests/tools/
  hono-inline-analyze.test.ts        [NEW]
  hono-conditional-middleware.test.ts[NEW]
  hono-response-types.test.ts        [NEW]
  hono-env-regression.test.ts        [NEW]
  hono-modules.test.ts               [NEW]
  hono-dead-routes.test.ts           [NEW]

tests/fixtures/hono/
  blog-realistic-app/                [NEW — replica of honojs/examples/blog]
    package.json
    src/index.ts
    src/api.ts
    src/bindings.ts
  enterprise-app/                    [NEW — for modules + env regression]
    src/index.ts
    src/modules/users/
    src/modules/admin/
    src/middleware/chain.ts
```

## Quality Strategy

**Critical CQ gates to watch:**
- CQ8 — Error handling in inline body analysis (gracefully handle malformed handler bodies)
- CQ11 — Function size — `InlineHandlerAnalyzer` class must split extraction concerns (not one megamethod)
- CQ14 — Shared analyzer prevents duplicated body-walking logic across 3 tools
- CQ25 — Extensions follow existing `walk*` / `private` naming from Phase 1

**Critical Q gates:**
- Q7 — Error paths tested (malformed AST, missing nodes)
- Q11 — Branch coverage for response type extraction (c.json vs c.text vs throw)
- Q15 — Assertion content (not just shape — verify actual extracted status codes, DB patterns)
- Q17 — Expected values from real Hono patterns, not implementation-derived

**High-risk areas:**
1. Inline handler body analysis — AST traversal inside nested arrow functions, tree-sitter depth limits
2. Conditional middleware detection — false positives for if-statements that aren't gating middleware
3. Type-level analysis for `detect_middleware_env_regression` — regex + heuristics, not real typechecker
4. Module clustering algorithm — correctness depends on heuristic weights

**Validation:**
- After Phase 2 completion, re-run the demo script on `honojs/examples/blog` and verify:
  - Runtime detects as "cloudflare" (currently "unknown")
  - `middleware` local sub-app has child_file populated
  - `audit_hono_security` no longer false-positives on conditional basicAuth
  - `analyze_inline_handler` returns response statuses for all 7 routes

## Task Breakdown

### Task 1: Extend HonoAppModel types for inline analysis + conditional middleware + modules

**Files:**
- `src/parser/extractors/hono-model.ts` (modify)
- `tests/parser/hono-model.test.ts` (modify)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `hono-model.test.ts`, add a test that constructs a `HonoRoute` with new optional fields: `inline_analysis: { responses, db_calls, side_effects, validators }`, and asserts JSON round-trip preserves them. Add a test that `MiddlewareEntry` accepts optional `applied_when: { condition_type, condition_text }`. Add a test that `HonoAppModel` accepts optional `modules: HonoModule[]`.
- [ ] GREEN: Extend `HonoRoute` interface with `inline_analysis?: InlineHandlerAnalysis`. Define `InlineHandlerAnalysis` interface:
  ```typescript
  export interface InlineHandlerAnalysis {
    responses: ResponseEmission[]; // c.json/text/html calls
    errors: ErrorEmission[];       // throw new HTTPException(N, ...)
    db_calls: ExternalCall[];      // prisma.*, db.*, $transaction
    fetch_calls: ExternalCall[];   // fetch(), axios.*
    context_access: ContextAccess[]; // c.set/c.get/c.var/c.env
    validators_inline: string[];   // zValidator refs inside body
    has_try_catch: boolean;
  }
  export interface ResponseEmission {
    method: "json" | "text" | "html" | "body" | "redirect" | "newResponse";
    status: number; // defaults to 200 when not specified
    shape_hint?: string; // best-effort shape extraction (string literal of arg)
    line: number;
  }
  export interface ErrorEmission {
    status: number;
    exception_class: string; // "HTTPException" | "Error" | etc.
    message_hint?: string;
    line: number;
  }
  export interface ExternalCall {
    callee: string; // "prisma.user.findMany" | "fetch"
    line: number;
    kind: "db" | "fetch" | "queue" | "email" | "other";
  }
  export interface ContextAccess {
    type: "set" | "get" | "var" | "env";
    key: string;
    line: number;
  }
  ```
  Extend `MiddlewareEntry` with `applied_when?: ConditionalApplication`. Define:
  ```typescript
  export interface ConditionalApplication {
    condition_type: "method" | "header" | "path" | "custom";
    condition_text: string; // e.g., "method !== 'GET'"
    always_applies: boolean;
  }
  ```
  Extend `HonoAppModel` with `modules?: HonoModule[]`. Define:
  ```typescript
  export interface HonoModule {
    name: string; // "admin", "public-api", "webhooks"
    route_count: number;
    path_prefix: string;
    middleware: string[]; // shared middleware names
    env_bindings: string[]; // shared bindings accessed
    files: string[];
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/hono-model.test.ts`
  Expected: All model tests pass, JSON round-trip asserts new fields.
- [ ] Acceptance: Foundation for tasks 2-11
- [ ] Commit: `extend HonoAppModel with inline_analysis, applied_when, modules interfaces`

---

### Task 2: InlineHandlerAnalyzer — shared body analysis class

**Files:**
- `src/parser/extractors/hono-inline-analyzer.ts` (NEW)
- `tests/parser/hono-inline-analyzer.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep implementation tier

- [ ] RED: Unit tests for `InlineHandlerAnalyzer`:
  - Given an arrow function node with body `return c.json({ id: 1 }, 201)`, `analyze()` returns `responses: [{ method: "json", status: 201, shape_hint: "{ id: 1 }", line: N }]`
  - Given `throw new HTTPException(404, { message: 'not found' })`, returns `errors: [{ status: 404, exception_class: "HTTPException", message_hint: "not found" }]`
  - Given `const users = await prisma.user.findMany({ where })`, returns `db_calls: [{ callee: "prisma.user.findMany", kind: "db" }]`
  - Given `await fetch('https://api.example.com/x')`, returns `fetch_calls: [{ callee: "fetch", kind: "fetch" }]`
  - Given `c.set("userId", id)`, returns `context_access: [{ type: "set", key: "userId" }]`
  - Given `try { ... } catch (e) { ... }` wrapping the body, returns `has_try_catch: true`
  - Given multiple c.json calls in different branches, returns multiple `responses` entries
- [ ] GREEN: Create `HonoInlineAnalyzer` class with methods:
  ```typescript
  export class HonoInlineAnalyzer {
    analyze(bodyNode: Parser.SyntaxNode, file: string): InlineHandlerAnalysis {
      const responses: ResponseEmission[] = [];
      const errors: ErrorEmission[] = [];
      const db_calls: ExternalCall[] = [];
      const fetch_calls: ExternalCall[] = [];
      const context_access: ContextAccess[] = [];
      const validators_inline: string[] = [];
      let has_try_catch = false;

      const cursor = bodyNode.walk();
      walk(cursor, (node) => {
        // Detect c.json/text/html/redirect/newResponse calls
        this.extractResponse(node, responses);
        // Detect throw new HTTPException(N, ...)
        this.extractError(node, errors);
        // Detect DB call patterns
        this.extractExternalCall(node, db_calls, fetch_calls);
        // Detect c.set/c.get/c.var/c.env access
        this.extractContextAccess(node, context_access);
        if (node.type === "try_statement") has_try_catch = true;
      });
      return { responses, errors, db_calls, fetch_calls, context_access, validators_inline, has_try_catch };
    }
    // ... private extractResponse, extractError, extractExternalCall, extractContextAccess
  }
  ```
  Pattern match `c.json(<arg>, <status>?)` — detect member_expression where object=identifier("c"), property one of "json"/"text"/"html"/"body"/"redirect"/"newResponse". Second argument is status if present; default 200.
  DB pattern library: `prisma.*.findMany|findFirst|create|update|delete|upsert|$transaction`, `db.query`, `.execute(`, `knex.`.
  Fetch pattern library: `fetch(`, `axios.get|post|put|delete`, `got(`, `hc<>()`.
- [ ] Verify: `npx vitest run tests/parser/hono-inline-analyzer.test.ts`
  Expected: 7+ assertions pass; analyzer extracts all demo patterns correctly.
- [ ] Acceptance: Foundation for Tasks 6, 8, audit_hono_security improvements
- [ ] Commit: `add HonoInlineAnalyzer for extracting response/error/db/context from inline handler bodies`

---

### Task 3: Wire InlineHandlerAnalyzer into HonoExtractor.walkHttpRoutes

**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 2
**Execution routing:** deep implementation tier

- [ ] RED: Add assertions to existing `HonoExtractor — basic-app` suite:
  - Given basic-app's `app.post("/users", async (c) => { const body = await c.req.json(); return c.json({ id: "u1", ...body }, 201); })`, the extracted route has `inline_analysis.responses[0].status === 201`
  - The same route has `inline_analysis.has_try_catch === false`
  - basepath-app's routes also get `inline_analysis` populated
- [ ] GREEN: In `walkHttpRoutes`, after detecting a route with inline handler (via `handler.inline === true`), instantiate `HonoInlineAnalyzer` once per extractor, run `analyze(handlerArg, file)`, attach result as `route.inline_analysis`. Do NOT run for named handlers (keep it optional).
  ```typescript
  // In walkHttpRoutes, after building the route object:
  if (handlerArg && handler.inline) {
    const bodyNode = handlerArg.childForFieldName("body") ?? handlerArg;
    route.inline_analysis = this.inlineAnalyzer.analyze(bodyNode, file);
  }
  ```
  Initialize `private inlineAnalyzer = new HonoInlineAnalyzer()` on class.
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts -t "basic-app"`
  Expected: New assertions pass, existing tests unchanged.
- [ ] Acceptance: Tasks 6, 8 can read inline_analysis from model
- [ ] Commit: `populate HonoRoute.inline_analysis via InlineHandlerAnalyzer during extraction`

---

### Task 4: Extractor — conditional middleware detection

**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/parser/hono-extractor.test.ts` (modify)
- `tests/fixtures/hono/basic-app/src/index.ts` (modify — add conditional middleware)

**Complexity:** complex
**Dependencies:** Task 3
**Execution routing:** deep implementation tier

- [ ] RED: Extend basic-app fixture with a conditional middleware mirror of honojs/examples/blog pattern:
  ```ts
  app.use("/conditional/*", async (c, next) => {
    if (c.req.method !== 'GET') {
      const auth = basicAuth({ username: "x", password: "y" });
      return auth(c, next);
    }
    await next();
  });
  ```
  Assert: the middleware chain entry for `/conditional/*` has `applied_when: { condition_type: "method", condition_text: /method\s*!==?\s*['"]GET['"]/, always_applies: false }` and the inner middleware (`basicAuth`) is expanded as a conditional entry with `conditional: true`.
- [ ] GREEN: Extend `walkMiddleware` — for each `app.use()` call with an inline arrow middleware (i.e., `arg.type === "arrow_function"`), additionally walk the arrow body for:
  - `if_statement` whose consequence contains `return <mwCall>(c, next)` or `await <mwCall>(c, next)`
  - Extract the if condition text (via `node.text` of condition), classify as `"method"` if text matches `/c\.req\.method/`, `"header"` if `/c\.req\.header/`, `"path"` if `/c\.req\.path/`, else `"custom"`
  - Emit a derived `MiddlewareEntry` with `name = <mwCall fn name>`, `applied_when = { condition_type, condition_text, always_applies: false }`, `conditional: true`, `order = parent order + 0.5` (to sort after the parent inline entry)
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts -t "basic-app"`
  Expected: Conditional entry detected, parent inline entry + derived conditional entry both present in chain.
- [ ] Acceptance: Closes demo gap #2, foundation for Task 7
- [ ] Commit: `detect conditional middleware inside inline arrow bodies`

---

### Task 5: Extractor — advanced runtime detection

**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/parser/hono-extractor.test.ts` (modify)
- `tests/fixtures/hono/cloudflare-bindings-app/` (NEW, minimal fixture)

**Complexity:** standard
**Dependencies:** none (independent of other Phase 2 tasks)
**Execution routing:** default implementation tier

- [ ] RED: Create `cloudflare-bindings-app` fixture — minimal Hono app with NO wrangler.toml but WITH `Bindings` type referencing `KVNamespace`, `D1Database`:
  ```ts
  import { Hono } from "hono";
  type Env = {
    Bindings: {
      KV: KVNamespace;
      DB: D1Database;
      SECRET: string;
    }
  };
  const app = new Hono<Env>();
  app.get("/", (c) => c.text("ok"));
  export default app;
  ```
  Test asserts `model.runtime === "cloudflare"`. Also assert that honojs-blog-style source (no wrangler, no Bun/Deno, just `export default app` with `c.env.USERNAME`) can detect cloudflare via heuristic.
- [ ] GREEN: After existing `detectRuntime` returns, if result is `"unknown"`, invoke new `detectRuntimeAdvanced`:
  ```typescript
  private async detectRuntimeAdvanced(entryFile: string, source: string): Promise<HonoAppModel["runtime"]> {
    const dir = path.dirname(entryFile);
    const projectRoot = path.dirname(dir);
    // Vercel
    if (existsSync(path.join(projectRoot, "vercel.json"))) return "node"; // vercel runs node
    // Netlify
    if (existsSync(path.join(projectRoot, "netlify.toml"))) return "node";
    // Fly.io
    if (existsSync(path.join(projectRoot, "fly.toml"))) return "node";
    // Cloudflare Workers TYPE signals — KVNamespace/D1Database/R2Bucket/DurableObjectNamespace in Bindings
    if (/Bindings\s*:\s*\{[^}]*(?:KVNamespace|D1Database|R2Bucket|DurableObjectNamespace|Queue|Service|Fetcher|AnalyticsEngineDataset)/s.test(source)) {
      return "cloudflare";
    }
    return "unknown";
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts -t "cloudflare"`
  Expected: cloudflare-bindings-app detected as `runtime: "cloudflare"`.
- [ ] Acceptance: Closes demo gap #3
- [ ] Commit: `detect cloudflare runtime from Bindings type signals and vercel/netlify/fly config files`

---

### Task 6: Extractor — local sub-app fallback in walkRouteMounts

**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/parser/hono-extractor.test.ts` (modify)
- `tests/fixtures/hono/basic-app/src/index.ts` (modify — add a local sub-app mount)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Extend basic-app fixture with a local sub-app mirror of honojs blog:
  ```ts
  const middleware = new Hono();
  middleware.use("*", (c, next) => next());
  app.route("/local", middleware);
  ```
  Assert: the model has a mount entry `{ parent_var: "app", mount_path: "/local", child_var: "middleware", child_file: <same absolute path as index.ts>, mount_type: "hono_route" }` — `child_file` is NOT empty/unresolved.
- [ ] GREEN: In `walkRouteMounts`, when processing a mount, after `const childFile = importMap.get(childVar)` returns undefined, add fallback:
  ```typescript
  let childFile = importMap.get(childVar);
  // Fallback: local sub-app declared in the same file
  if (!childFile && appVars[childVar]) {
    childFile = canonicalize(path.resolve(file));
  }
  ```
  Note: parent app routes are already walked for this file in the top-level parse, so do NOT recurse into `parseFile(childFile, ...)` — just record the mount. The child's routes are already extracted by the main walk.
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts -t "basic-app"`
  Expected: Mount's `child_file` is the same-file absolute path, no "?" placeholder.
- [ ] Acceptance: Closes demo gap #4
- [ ] Commit: `support local sub-apps in walkRouteMounts via localAppVars fallback`

---

### Task 7: Tool — trace_conditional_middleware

**Files:**
- `src/tools/hono-conditional-middleware.ts` (NEW)
- `tests/tools/hono-conditional-middleware.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** Task 4
**Execution routing:** default implementation tier

- [ ] RED: Tests:
  - Given basic-app with conditional middleware, `traceConditionalMiddleware(repo)` returns `findings: [{ scope, middleware_name: "basicAuth", condition: "method !== 'GET'", applies_to_methods: ["POST", "PUT", "DELETE", "PATCH"] }]`
  - Given non-Hono repo → error response
- [ ] GREEN: Implement `traceConditionalMiddleware(repo)`:
  1. Fetch HonoAppModel via honoCache
  2. Walk `middleware_chains` looking for entries with `applied_when` or `conditional: true`
  3. For each, infer which HTTP methods the condition applies to (parse condition_text for `!==` patterns with method names)
  4. Return array of findings with scope, middleware name, condition, inferred methods
- [ ] Verify: `npx vitest run tests/tools/hono-conditional-middleware.test.ts`
  Expected: 3+ tests pass.
- [ ] Acceptance: Tool #2 from proposal
- [ ] Commit: `add trace_conditional_middleware tool`

---

### Task 8: Tool — analyze_inline_handler

**Files:**
- `src/tools/hono-inline-analyze.ts` (NEW)
- `tests/tools/hono-inline-analyze.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** Task 3
**Execution routing:** default implementation tier

- [ ] RED: Tests:
  - Given basic-app's `POST /users` inline handler, `analyzeInlineHandler(repo, "/users", "POST")` returns `{ responses: [{ status: 201 }], has_try_catch: false, db_calls: [], fetch_calls: [] }`
  - Given a route calling `prisma.user.findMany`, returns `db_calls: [{ callee: "prisma.user.findMany", kind: "db" }]`
  - Given a route with no inline_analysis (non-inline handler), returns `{ inline: false, reason: "handler is a named function" }`
  - Given non-Hono repo → error
- [ ] GREEN: Implement `analyzeInlineHandler(repo, path, method?)`:
  1. Fetch model via honoCache
  2. Find matching route via `matchPath`
  3. If `route.handler.inline === false`, return `{ inline: false, reason: ... }`
  4. Return `route.inline_analysis` + route metadata (path, method, file, line)
- [ ] Verify: `npx vitest run tests/tools/hono-inline-analyze.test.ts`
  Expected: 4+ tests pass.
- [ ] Acceptance: P0 tool #1 from proposal
- [ ] Commit: `add analyze_inline_handler tool`

---

### Task 9: Tool — extract_response_types

**Files:**
- `src/tools/hono-response-types.ts` (NEW)
- `tests/tools/hono-response-types.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** Task 3
**Execution routing:** default implementation tier

- [ ] RED: Tests:
  - Given basic-app, `extractResponseTypes(repo)` returns `routes: [{ method, path, responses: [{ status: 200 | 201 | 404, ... }], errors: [...] }]`
  - For `POST /users`, response_statuses includes 201 (from c.json second arg)
  - For a route with `throw new HTTPException(404)`, errors includes 404
  - Summary: `status_code_frequency: { "200": N, "201": N, "404": N }` global count across all routes
- [ ] GREEN: Implement `extractResponseTypes(repo)`:
  1. Fetch model
  2. Walk all routes; for inline routes use `inline_analysis.responses` + `inline_analysis.errors`; for named handlers return empty arrays with note
  3. Aggregate status codes across all routes for summary stats
  4. Output `{ routes, status_code_frequency, total_routes_analyzed, inline_routes, named_routes }`
- [ ] Verify: `npx vitest run tests/tools/hono-response-types.test.ts`
  Expected: 4+ tests pass; closes Issue #4270 for inline handler case.
- [ ] Acceptance: P1 tool #4 from proposal, addresses Issue #4270
- [ ] Commit: `add extract_response_types tool for static response type analysis`

---

### Task 10: Tool — detect_middleware_env_regression

**Files:**
- `src/tools/hono-env-regression.ts` (NEW)
- `tests/tools/hono-env-regression.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** none (uses existing model + file reading)
**Execution routing:** deep implementation tier

- [ ] RED: Tests:
  - Given a middleware chain `app.use("*", mw1); app.use("*", mw2); app.use("*", mw3)` where `mw2 = createMiddleware((c, next) => next())` (no generic) but `mw1 = createMiddleware<AppEnv>(...)`, detection returns finding:
    ```
    { chain_scope: "*", regression_at: "mw2", reason: "createMiddleware without <Env> generic, causing BlankEnv regression for subsequent middleware" }
    ```
  - Given a chain where all 3 entries use `createMiddleware<AppEnv>`, returns no findings
  - Given chain of size < 3, skips (too few to regress)
- [ ] GREEN: Implement `detectMiddlewareEnvRegression(repo)`:
  1. Fetch model — find chains with ≥3 entries
  2. For each entry that has `imported_from` or is a file reference, read the middleware file (via `search_text` or direct `readFile`)
  3. Look for `createMiddleware(` vs `createMiddleware<...>(` in the middleware source
  4. Flag entries with no generic as regression candidates
  5. Return findings with scope, entry index, reason, file:line evidence
  Heuristic-only — no real type inference. Document as "best-effort" in tool description.
- [ ] Verify: `npx vitest run tests/tools/hono-env-regression.test.ts`
  Expected: 3+ tests pass.
- [ ] Acceptance: Addresses Issue #3587
- [ ] Commit: `add detect_middleware_env_regression for Issue #3587 detection`

---

### Task 11: Tool — detect_hono_modules

**Files:**
- `src/tools/hono-modules.ts` (NEW)
- `tests/tools/hono-modules.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** none (clusters existing model data)
**Execution routing:** deep implementation tier

- [ ] RED: Tests:
  - Given subapp-app (from Phase 1), `detectHonoModules(repo)` returns modules like `[{ name: "admin", routes: 4, path_prefix: "/api/admin", middleware: ["authMiddleware", "tenantMiddleware"], files: ["routes/admin.ts"] }, { name: "users", routes: 3, path_prefix: "/api/users", middleware: ["authMiddleware"], files: ["routes/users.ts"] }]`
  - Module names derived from mount paths (last segment) or file basenames
  - Modules sorted by route count desc
- [ ] GREEN: Implement `detectHonoModules(repo)`:
  1. Fetch model
  2. Cluster routes by `(sub-router file, mount path prefix)` tuple
  3. For each cluster compute: route count, common path prefix, union of middleware names (from chains whose scope matches the prefix), union of env bindings accessed
  4. Generate module name from mount path's last segment or file basename
  5. Sort by route count desc, return list
- [ ] Verify: `npx vitest run tests/tools/hono-modules.test.ts`
  Expected: 3+ tests pass; subapp-app produces admin + users modules.
- [ ] Acceptance: Addresses Issue #4121 (architecture guidance)
- [ ] Commit: `add detect_hono_modules for logical module clustering`

---

### Task 12: Tool — find_dead_hono_routes

**Files:**
- `src/tools/hono-dead-routes.ts` (NEW)
- `tests/tools/hono-dead-routes.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Tests:
  - Given a repo with server routes `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id` and client file containing `client.api.users.$get()` and `client.api.users.$post()`, `findDeadHonoRoutes(repo)` returns `dead_routes: [{ method: "DELETE", path: "/api/users/:id" }]`
  - When no client files exist (grep returns zero hc<> matches), returns `{ dead_routes: [], reason: "no RPC client usage found" }`
  - For `full_app` RPC export pattern, note slow-pattern flag in output
- [ ] GREEN: Implement `findDeadHonoRoutes(repo)`:
  1. Fetch model — gather all server routes
  2. Use `search_text` internally (via dynamic import) to find all occurrences of `hc<` and `client\..*\.\$(get|post|put|delete|patch)` in the repo
  3. Parse each client call into `(method, path)` by walking the property chain: `client.api.users[":id"].$get()` → `GET /api/users/:id`
  4. Diff: server routes not matched by any client call → dead
  5. Output: `{ dead_routes, used_routes_count, client_calls_found, slow_pattern_detected }`
- [ ] Verify: `npx vitest run tests/tools/hono-dead-routes.test.ts`
  Expected: 3+ tests pass.
- [ ] Acceptance: Addresses cross-project dead code detection
- [ ] Commit: `add find_dead_hono_routes via RPC client grep + model diff`

---

### Task 13: Register 6 new tools + extend HONO_TOOLS auto-load

**Files:**
- `src/register-tools.ts` (modify)
- `tests/tools/register-tools.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Tasks 7, 8, 9, 10, 11, 12
**Execution routing:** default implementation tier

- [ ] RED: Test assertions:
  - `TOOL_DEFINITIONS` contains 6 new Hono tool names: `analyze_inline_handler`, `trace_conditional_middleware`, `extract_response_types`, `detect_middleware_env_regression`, `detect_hono_modules`, `find_dead_hono_routes`
  - `HONO_TOOLS` auto-load list now has 11 entries (5 Phase 1 + 6 Phase 2)
  - Hono auto-detection test: project with `hono` dep in package.json enables all 11 hidden tools
- [ ] GREEN:
  1. Add 6 tool definitions in the Hono section of `TOOL_DEFINITIONS`:
  ```typescript
  {
    name: "analyze_inline_handler",
    category: "analysis",
    searchHint: "hono inline handler body response status db fetch",
    description: "Analyze an inline Hono handler body: response status codes, DB calls, fetch calls, context access, try/catch presence.",
    schema: { repo: z.string().optional(), path: z.string(), method: z.string().optional() },
    handler: async (args) => {
      const { analyzeInlineHandler } = await import("./tools/hono-inline-analyze.js");
      return await analyzeInlineHandler(args.repo as string, args.path as string, args.method as string | undefined);
    },
  },
  // ... 5 more
  ```
  2. Extend `HONO_TOOLS` array with the 6 new tool names
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts`
  Expected: All registration + auto-load tests pass.
- [ ] Acceptance: Phase 2 tools are now discoverable and auto-enabled
- [ ] Commit: `register 6 Phase 2 Hono tools and extend auto-load list`

---

### Task 14: Real-project validation + benchmark on honojs/examples/blog

**Files:**
- `tests/benchmarks/hono-phase-2-demo.ts` (NEW)

**Complexity:** standard
**Dependencies:** Tasks 1-13
**Execution routing:** default implementation tier

- [ ] RED: Write a validation script that runs all Phase 2 tools against `honojs/examples/blog` and asserts the specific gaps from the original demo are closed:
  - `runtime: "cloudflare"` (was "unknown")
  - `middleware` mount has `child_file` populated (was "?")
  - `audit_hono_security` does NOT report missing auth for `/posts/*` routes (conditional basicAuth now recognized)
  - `analyze_inline_handler("/api/posts", "POST")` returns at least one response with status 201 (or whatever the real blog returns)
  - `extract_response_types` produces per-route response maps for all 7 routes
- [ ] GREEN: Script iterates through the tool list, calls each, asserts against expected outputs. Uses `/tmp/hono-demo/examples/blog` if present, else skips with warning.
- [ ] Verify: `npx tsx tests/benchmarks/hono-phase-2-demo.ts`
  Expected: All 5 demo-gap assertions pass; script prints "Phase 2 closes all 5 demo gaps".
- [ ] Acceptance: Phase 2 success criteria validated on real project
- [ ] Commit: `add Phase 2 validation benchmark for honojs/examples/blog`

---

## Ship Criteria

1. All existing Hono tests (~128 passing from Phase 1) continue to pass
2. New test files created per task all pass
3. Real-project validation script passes all 5 demo-gap assertions
4. Zero new TypeScript compiler errors in Hono-specific files
5. Tool count advances 108 → 114 (6 new tools registered)
6. HONO_TOOLS auto-load list grows from 5 → 11 entries
7. CLAUDE.md + README.md tool count updated
8. `package.json` description optionally mentions Phase 2 capabilities

## Out of Scope (Deferred to Phase 3)

- **Advanced type inference for response shapes** — current `shape_hint` is the argument expression text, not a real type. Would need TypeScript compiler API integration.
- **`validate_hono_contracts` tool** — still deferred (requires LSP)
- **Cross-file conditional middleware** — if `authMw = createMiddleware(...)` and usage is `const auth = basicAuth(...); return auth(c, next)`, Phase 2 only catches the immediate call, not the factory pattern
- **Module clustering ML** — current clustering is heuristic-based, no graph algorithms
- **Hono v5 compatibility** — no public v5 roadmap exists as of April 2026

## Rollback Strategy

Each task commits independently. If any tool proves unstable:
- Remove from `HONO_TOOLS` auto-load list (single-line fix)
- Remove from `TOOL_DEFINITIONS` registration (single-line fix)
- Existing Phase 1 tools continue to work
- Model additions (`inline_analysis`, `applied_when`, `modules`) are optional fields, older model consumers ignore them

No data migration required — `HonoCache` is in-memory, rebuilds on next session.
