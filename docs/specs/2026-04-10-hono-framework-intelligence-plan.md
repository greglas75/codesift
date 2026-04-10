# Implementation Plan: Hono Framework Intelligence

**Spec:** docs/specs/2026-04-10-hono-framework-intelligence-spec.md
**spec_id:** 2026-04-10-hono-framework-intelligence-2013
**planning_mode:** spec-driven
**plan_revision:** 2
**status:** Approved
**Created:** 2026-04-10
**Approved:** 2026-04-10T20:50:00Z
**Tasks:** 25
**Estimated complexity:** 6 standard, 19 complex

## Architecture Summary

Single tree-sitter AST extractor (`src/parser/extractors/hono.ts`) produces a unified `HonoAppModel` consumed by 4 extended tools and 7 new tools. Model is cached in-memory via `src/cache/hono-cache.ts` (LRU, async `get()`, sync `peek()`, concurrent-build protection). Cache invalidation wired into `src/tools/index-tools.ts::handleFileChange()` with relative→absolute path normalization. Existing `extractHonoConventions()` in `project-tools.ts` is rewritten as a thin adapter over `HonoExtractor.parse()`. Legacy regex impl preserved in `src/tools/legacy-hono-conventions.ts` behind `CODESIFT_LEGACY_HONO=1` kill switch.

## Technical Decisions

- **Parser:** tree-sitter TypeScript grammar (handles `.ts`, `.tsx`, `.js`, `.jsx`)
- **Model location:** `src/parser/extractors/hono-model.ts` (types), `hono.ts` (extractor)
- **Tool files:** `src/tools/hono-*.ts` — one file per new tool
- **Fixture location:** `tests/fixtures/hono/{basic,subapp,openapi,factory,basepath}-app/` — real `.ts` files
- **Test runner:** `npx vitest run` (existing)
- **Tool registration:** extend `TOOL_DEFINITIONS` array in `src/register-tools.ts`; add `trace_middleware_chain`, `analyze_hono_app` to `CORE_TOOL_NAMES`
- **Extractor version:** bump `EXTRACTOR_VERSIONS.hono` from `"1.0.0"` to `"2.0.0"`

## Quality Strategy

- **TDD rigor:** Every task follows RED → GREEN → Verify → Commit
- **Critical CQ gates to watch:** CQ3 (boundary validation), CQ5 (no PII), CQ8 (error handling, cache error swallowing), CQ14 (no dup logic across 7 tool files), CQ23 (cache TTL/invalidation), CQ25 (match existing extractor pattern)
- **Critical Q gates to watch:** Q7 (error paths), Q11 (all branches), Q15 (assertion content), Q19 (test isolation — cache state must not leak between tests)
- **High-risk areas:**
  1. Cache invalidation correctness (relative vs absolute path, concurrent builds)
  2. Sub-app recursive resolver (cycle detection, import graph)
  3. Legacy → AST migration (31 existing tests must pass with adjusted snapshots)
  4. Variable-name-agnostic tracking (`app_variables` map for `factory.createApp()`)

## Task Breakdown

### Task 1: HonoAppModel types + scaffold
**Files:**
- `src/parser/extractors/hono-model.ts` (NEW)
- `tests/parser/hono-model.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Test in `hono-model.test.ts` imports `HonoAppModel`, `HonoRoute`, `MiddlewareEntry`, `ContextVariable`, `OpenAPIRoute`, `RPCExport`, `HonoApp`, `HonoMount`, `MiddlewareChain`, `ContextAccessPoint`, `HonoValidator` from `hono-model.ts` and constructs a minimal valid `HonoAppModel` literal with `extraction_status: "complete"`. Assert the literal shape compiles and round-trips through `JSON.parse(JSON.stringify(model))` preserving all fields.
- [ ] GREEN: Create `hono-model.ts` exporting all type interfaces from spec Data Model section. Use `Record<string, HonoApp>` (not `Map`) per spec D4 fix. Include doc comments on each field referencing the AC it supports.
- [ ] Verify: `npx vitest run tests/parser/hono-model.test.ts`
  Expected: 1 test passing.
- [ ] Acceptance: Foundation for all AC-R*, AC-M*, AC-C*, AC-A* (type contract)
- [ ] Commit: `add HonoAppModel types for hono extractor`

---

### Task 2: HonoExtractor scaffold + basic `new Hono()` detection
**Files:**
- `src/parser/extractors/hono.ts` (NEW)
- `tests/fixtures/hono/basic-app/package.json` (NEW)
- `tests/fixtures/hono/basic-app/src/index.ts` (NEW)
- `tests/parser/hono-extractor.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep implementation tier

- [ ] RED: Create `basic-app` fixture with single-file Hono app: imports `{ Hono }` from `"hono"`, `const app = new Hono()`, 5 inline routes (GET /, GET /health, POST /users, GET /users/:id, PATCH /users/:id), 2 middleware (global logger + /users/* auth), `export default app`. Test asserts `HonoExtractor.parse(fixturePath)` returns a model where `app_variables["app"]` exists with `created_via: "new Hono"` and `routes.length === 5`.
- [ ] GREEN: In `hono.ts`, create `HonoExtractor` class following the pattern of `src/parser/extractors/typescript.ts`. Implement `parse(entryFile: string): Promise<HonoAppModel>`. Walk tree-sitter AST for `new_expression` nodes where callee is `Hono` or `OpenAPIHono`. Track variable declarations that bind to these. Walk `call_expression` nodes on tracked variables where method is one of `get|post|put|delete|patch|options|all|on` — emit `HonoRoute` entries. For now, path resolution is literal only (no basePath). Return the model.
  Scaffold (≤20 lines):
  ```typescript
  import { parseTS } from "./_shared.js";
  export class HonoExtractor {
    async parse(entryFile: string): Promise<HonoAppModel> {
      const source = await readFile(entryFile, "utf-8");
      const tree = parseTS(source, entryFile);
      const model = this.initModel(entryFile);
      this.walkAppVariables(tree.rootNode, source, model);
      this.walkRoutes(tree.rootNode, source, model);
      return model;
    }
  }
  ```
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: 1 test passing, 5 routes extracted from basic-app.
- [ ] Acceptance: AC-R1, AC-A1 (partial)
- [ ] Commit: `add HonoExtractor with tree-sitter scaffold and route detection`

---

### Task 3: Sub-app mount composition + recursive resolver
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/subapp-app/package.json` (NEW)
- `tests/fixtures/hono/subapp-app/src/index.ts` (NEW)
- `tests/fixtures/hono/subapp-app/src/routes/users.ts` (NEW)
- `tests/fixtures/hono/subapp-app/src/routes/admin.ts` (NEW)
- `tests/fixtures/hono/subapp-app/src/middleware/auth.ts` (NEW)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 2
**Execution routing:** deep implementation tier

- [ ] RED: Create `subapp-app` fixture — index.ts mounts `users` and `admin` sub-apps via `app.route("/api/users", usersRouter)` and `app.route("/api/admin", adminRouter)`. Each sub-app has 3-4 routes. Test asserts the extractor parses index.ts, follows imports for `usersRouter` and `adminRouter`, recursively parses those files, and returns flattened `routes` with fully-resolved paths (e.g., `/api/users/:id`, `/api/admin/settings`). Assert `files_used` contains all 3 route files as absolute paths. Assert cycle detection: if index.ts were to self-import (manually simulate), extractor does not loop.
- [ ] GREEN: Extend `HonoExtractor` with:
  - Import resolver (`resolveImport(fromFile, importSpec) → absolutePath`) — handles relative imports `./routes/users`, `.js` extension mapping, barrel files. Uses `fs.realpathSync.native` to canonicalize (per adversarial review finding — critical for cache invalidation).
  - Recursive `parseFile(file, context)` with in-flight stack `Set<string>` pushed/popped around each recursive call (NOT a persistent visited set — that breaks legitimate re-mounting of the same router under multiple prefixes like `/v1/users` and `/v2/users`). Separate memoization map `parsedChildren: Map<canonicalPath, ChildModel>` caches parse results so re-mount reuses the parse but applies fresh prefix.
  - `app.route()` handler: extracts mount path and child variable, resolves child variable's import source, recursively parses that file, merges child `routes` into parent with prefix applied. Multiple `app.route("/v1", X)` + `app.route("/v2", X)` MUST produce routes under both prefixes.
  - `HonoMount` entries emitted per `app.route()` call with `mount_type: "hono_route"`
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: Tests pass, `model.routes.length >= 7` for subapp-app, all paths start with `/api/`.
- [ ] Acceptance: AC-R2, AC-A2, AC-D1, AC-D3 (foundation)
- [ ] Commit: `add recursive sub-app resolver and app.route() composition`

---

### Task 4: basePath, on, all, mount, regex constraints
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/basepath-app/package.json` (NEW)
- `tests/fixtures/hono/basepath-app/src/index.ts` (NEW)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 3
**Execution routing:** deep implementation tier

- [ ] RED: Create `basepath-app` fixture covering: `const v1 = app.basePath("/v1")` with `v1.get("/users", h)`, `app.all("/api/*", catchAll)`, `app.on(["GET","POST"], "/form", handler)`, `app.get("/posts/:id{[0-9]+}", h)`, `app.mount("/legacy", expressLikeHandler)`. Tests assert: `/v1/users` is in model.routes with `method: "GET"`; `/api/*` exists with `method: "ALL"`; `/form` produces TWO route entries (GET and POST); `/posts/:id{[0-9]+}` has `regex_constraint.id === "[0-9]+"`; `app.mount` produces a `HonoMount` with `mount_type: "hono_mount"`.
- [ ] GREEN: Extend extractor to:
  - Detect `<var>.basePath("/prefix")` — record a derived `HonoApp` with `parent` set and `base_path` set; routes on the derived variable get the prefix applied during path resolution
  - Detect `app.all()` — emit route with `method: "ALL"`
  - Detect `app.on(methods, paths, handler)` — fan out into multiple `HonoRoute` entries (one per method × path combination)
  - Detect `app.mount(path, externalHandler)` — emit `HonoMount` with `mount_type: "hono_mount"`, do NOT try to parse the external handler
  - Parse regex constraints in path params: `\/:(\w+)\{([^}]+)\}` → populate `regex_constraint: { paramName: regex }` on the route
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: All basepath-app tests pass, 6+ routes extracted including multi-method fan-out.
- [ ] Acceptance: AC-R3, AC-R4, AC-R5, AC-R6, AC-R7
- [ ] Commit: `add basePath, app.all, app.on, app.mount, regex constraint support`

---

### Task 5: Factory pattern and non-`app` variable names
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/factory-app/package.json` (NEW)
- `tests/fixtures/hono/factory-app/src/index.ts` (NEW)
- `tests/fixtures/hono/factory-app/wrangler.toml` (NEW — marks as CF Workers)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 4
**Execution routing:** deep implementation tier

- [ ] RED: Create `factory-app` fixture: `import { createFactory } from "hono/factory"; const factory = createFactory<{ Bindings: Env }>(); const api = factory.createApp();` then `api.get("/ping", ...)`, `api.get("/env", (c) => c.json(c.env.DATABASE_URL))`. Fixture has `wrangler.toml` and `export default api` pattern for Cloudflare Workers. Tests assert `app_variables["api"]` exists with `created_via: "factory.createApp"`, route `/ping` resolved despite variable name being `api` (not `app`), `runtime: "cloudflare"`, `env_bindings` contains `"DATABASE_URL"` (detected from `c.env.DATABASE_URL` access).
- [ ] GREEN: Extend extractor:
  - Detect `createFactory<...>()` calls → track the factory variable
  - Detect `<factory>.createApp()` calls → register the result variable in `app_variables` with `created_via: "factory.createApp"`
  - Walk call expressions on ANY variable tracked in `app_variables` (not just `app`)
  - Detect runtime: check for `wrangler.toml` in fixture root → `"cloudflare"`; `Deno.serve` in source → `"deno"`; `Bun.serve` → `"bun"`; `serve({ fetch })` from `@hono/node-server` → `"node"`; `handle(app)` from `hono/aws-lambda` → `"lambda"`; default `"unknown"`
  - Populate `env_bindings` from multiple sources (per adversarial review finding — single-access walk is too narrow): (a) parse the `Bindings` type literal from `Hono<{ Bindings: Env }>()` / `createFactory<{ Bindings: Env }>()` generic — treat those as authoritative binding keys; (b) walk `c.env.<IDENTIFIER>` member accesses; (c) walk `ObjectPattern` destructuring where initializer is `c.env` (`const { DATABASE_URL } = c.env`); (d) walk aliased variable patterns (`const env = c.env; env.FOO`). Union all sources, dedupe.
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: factory-app tests pass, `runtime === "cloudflare"`, `env_bindings` non-empty.
- [ ] Acceptance: AC-R8, AC-A3, AC-C4 (partial — env bindings)
- [ ] Commit: `add factory.createApp and runtime detection`

---

### Task 6: Middleware chain with some()/every(), inline, spread, third-party
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/basic-app/src/index.ts` (modify — add middleware cases)
- `tests/fixtures/hono/subapp-app/src/middleware/auth.ts` (modify)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 5
**Execution routing:** deep implementation tier

- [ ] RED: Extend basic-app fixture with: `import { cors } from "hono/cors"; import { some } from "hono/combine"; const adminChain = [authMw, tenantMw]; app.use("*", cors()); app.use("/admin/*", ...adminChain); app.use("/api/*", some(authMw, publicMw));` plus an inline arrow `app.use("*", (c, next) => next())`. Add `factory.createMiddleware()` usage in subapp-app. Tests assert: (1) cors entry has `is_third_party: true, imported_from: "hono/cors"`; (2) inline entry has `name: "<inline>", inline: true`; (3) `some()` expansion produces two entries with `expanded_from: "some", conditional: true`; (4) spread `...adminChain` produces entries for `authMw` and `tenantMw`; (5) `factory.createMiddleware` variable used in `app.use` resolves correctly.
- [ ] GREEN: Extend extractor:
  - Parse `app.use(path, ...args)` where args can include call expressions, identifiers, arrow functions, spread elements
  - For `some()`/`every()` from `hono/combine`: walk inner arguments, emit one `MiddlewareEntry` per argument with `expanded_from` set
  - For spread `...chainVar`: resolve `chainVar` to array literal declaration, emit one entry per array element
  - For inline arrow/function expression: emit with `name: "<inline>", inline: true`
  - Track imports: build a file-local map `{variableName → {imported_from, is_third_party}}` where `is_third_party` is true if `imported_from` starts with `hono/` or is an external package
  - For `factory.createMiddleware` results: track like factory.createApp
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: All 5 middleware assertions pass.
- [ ] Acceptance: AC-M1, AC-M2, AC-M3, AC-M4, AC-M5
- [ ] Commit: `add middleware chain expansion with some/every, spread, inline, third-party classification`

---

### Task 7: Context flow tracking (c.set, c.get, c.var, c.env, contextStorage)
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/subapp-app/src/routes/admin.ts` (modify — add c.set/c.get)
- `tests/fixtures/hono/subapp-app/src/services/user-service.ts` (NEW — for getContext pattern)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 6
**Execution routing:** deep implementation tier

- [ ] RED: Extend subapp-app fixture: auth middleware calls `c.set("userId", "u1")`, admin route reads `c.var.userId`, service function uses `import { getContext } from "hono/context-storage"` and calls `getContext().var.userId`, another middleware has `if (isAdmin) { c.set("role", "admin") }` inside an if-statement. Tests assert: (1) `model.context_vars` contains `userId` with at least one `set_point` (from middleware) and one `get_point` (from admin route); (2) `role` variable has a `set_point` with `condition: "conditional"`; (3) `getContext().var.userId` is detected as a `get_point` with `via_context_storage: true` and `scope: "service"`; (4) a `c.env.DATABASE_URL` access is stored as a ContextVariable with `is_env_binding: true` separately from `c.var.*` variables.
- [ ] GREEN: Extend extractor:
  - Walk all function bodies (middleware + handlers + service functions imported by the app) for `c.set(key, value)` calls → emit `ContextAccessPoint` with `scope` inferred from containing context (middleware if inside `app.use`, handler if inside `app.get/.../get`, service otherwise)
  - Walk for `c.get(key)` and `c.var.<identifier>` member accesses → emit as `get_point`
  - Walk for `c.env.<identifier>` → emit as ContextVariable with `is_env_binding: true`
  - Walk for `getContext()` calls (when `hono/context-storage` is imported) → follow `.var.<identifier>` accesses, emit with `via_context_storage: true`
  - Inside if/try/switch branches: mark `condition: "conditional"` on the access point
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: 4 context flow assertions pass.
- [ ] Acceptance: AC-C1, AC-C2, AC-C3, AC-C4, AC-C5 (foundation — tool assertion in Task 16)
- [ ] Commit: `add context flow tracking for c.set, c.var, c.env, contextStorage`

---

### Task 8: OpenAPIHono + createRoute() parsing
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/openapi-app/package.json` (NEW)
- `tests/fixtures/hono/openapi-app/src/index.ts` (NEW)
- `tests/fixtures/hono/openapi-app/src/schemas.ts` (NEW)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 7
**Execution routing:** deep implementation tier

- [ ] RED: Create `openapi-app` fixture: `import { OpenAPIHono, createRoute } from "@hono/zod-openapi"; import { z } from "zod"; const app = new OpenAPIHono();` with one createRoute: `const getUsersRoute = createRoute({ method: "get", path: "/users/{id}", request: { params: z.object({id: z.string()}) }, responses: { 200: { content: { "application/json": { schema: UserSchema } }, description: "ok" } } });` then `app.openapi(getUsersRoute, (c) => c.json({...}))`. Tests assert: (1) `model.openapi_routes.length === 1`, (2) openapi route has `method: "get"`, `path: "/users/{id}"`, `hono_path: "/users/:id"`, `request_schemas.params` set; (3) normal `model.routes` also contains `/users/:id` with `openapi_route_id` linking to the OpenAPIRoute.
- [ ] GREEN: Extend extractor:
  - Detect `OpenAPIHono` constructor calls → register in `app_variables` with `created_via: "OpenAPIHono"`
  - Detect `createRoute({...})` calls — parse the object literal to extract `method`, `path`, `request.params/query/body/headers/cookies`, `responses`, `middleware`, `hide`
  - Convert OpenAPI `{param}` syntax to Hono `:param` and store both (`path` = OpenAPI, `hono_path` = Hono)
  - Detect `<app>.openapi(routeDef, handler)` calls — create a `HonoRoute` from the createRoute data and link via `openapi_route_id`
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: openapi-app assertions pass, both `routes` and `openapi_routes` populated.
- [ ] Acceptance: AC-R9 (foundation for Task 17 API contract tool)
- [ ] Commit: `add OpenAPIHono and createRoute parsing`

---

### Task 9: RPC type exports (shape detection for Issue #3869)
**Files:**
- `src/parser/extractors/hono.ts` (modify)
- `tests/fixtures/hono/subapp-app/src/index.ts` (modify — add AppType export)
- `tests/parser/hono-extractor.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Task 8
**Execution routing:** default implementation tier

- [ ] RED: Add `export type AppType = typeof app;` to subapp-app index.ts. Also add `const userRoutes = new Hono().get(...); export type UserRoutes = typeof userRoutes;`. Tests assert: `model.rpc_exports` has 2 entries; first has `shape: "full_app", source_var: "app"`; second has `shape: "route_group", source_var: "userRoutes"`.
- [ ] GREEN: In extractor, walk `export type` declarations. For each `typeof <var>` type reference, check whether `<var>` is the root app (shape `full_app`) or a sub-router (shape `route_group`). An export is `full_app` if `source_var` matches an `app_variable` that has mounted sub-apps (i.e., is a root); `route_group` otherwise.
- [ ] Verify: `npx vitest run tests/parser/hono-extractor.test.ts`
  Expected: 2 RPC export entries with correct shapes.
- [ ] Acceptance: Foundation for Task 18 (trace_rpc_types) and search pattern `hono-full-app-rpc-export`
- [ ] Commit: `detect RPC type exports and classify slow vs fast pattern`

---

### Task 10: HonoCache with LRU, peek, concurrent build protection
**Files:**
- `src/cache/hono-cache.ts` (NEW)
- `tests/cache/hono-cache.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 9
**Execution routing:** deep implementation tier

- [ ] RED: Tests in `hono-cache.test.ts`: (1) `get(repo, entryFile)` on empty cache calls the extractor and returns model (use a mock extractor); (2) second `get()` with same key returns cached model without calling extractor again; (3) `peek(repo)` returns null on miss, returns cached model on hit without calling extractor; (4) `invalidate(absolutePath)` removes any entry whose `files_used` contains that path; (5) two concurrent `get()` calls during cold start share a single in-flight promise (extractor called once); (6) **True LRU eviction** (NOT FIFO) — insert 10 entries, repeatedly hit entry A, then insert entry K; assert A survives and the oldest-accessed entry (not oldest-inserted) is evicted; (7) `clear(repo)` removes only that repo's entries; (8) **Immutability** — returned model is deeply frozen or structurally cloned; mutating `model.routes.push(...)` from tool A does NOT affect tool B's subsequent `get()` on the same key.
- [ ] GREEN: Implement `HonoCache` class:
  ```typescript
  class HonoCache {
    private entries = new Map<string, CacheEntry>();  // Map preserves insertion order
    private building = new Map<string, Promise<HonoAppModel>>();
    async get(repo: string, entryFile: string, extractor: HonoExtractor): Promise<HonoAppModel> {
      const key = `${repo}:${entryFile}`;
      const cached = this.entries.get(key);
      if (cached) {
        // TRUE LRU: delete+set on hit to move entry to end of insertion order
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.model;
      }
      const inflight = this.building.get(key); if (inflight) return inflight;
      const promise = extractor.parse(entryFile).finally(() => this.building.delete(key));
      this.building.set(key, promise);
      const model = await promise;
      // Deep freeze on insert (adversarial review: prevent tool-cross-mutation)
      const frozen = deepFreeze(model);
      this.entries.set(key, { model: frozen, repo });
      this.enforceLRU();
      return frozen;
    }
    peek(repo: string): HonoAppModel | null { /* scan entries for matching repo — no reorder */ }
    invalidate(absolutePath: string): void {
      // Canonicalize via realpath before comparison (adversarial review fix)
      const canonical = fs.existsSync(absolutePath) ? fs.realpathSync.native(absolutePath) : absolutePath;
      // iterate entries, delete any whose files_used includes canonical or absolutePath
    }
    clear(repo?: string): void { /* bulk delete */ }
  }
  export const honoCache = new HonoCache();
  ```
  `deepFreeze` is a helper that recursively `Object.freeze`s objects and arrays.
- [ ] Verify: `npx vitest run tests/cache/hono-cache.test.ts`
  Expected: All 7 tests pass.
- [ ] Acceptance: Foundation for all tool integrations; ship criterion 17 (hit rate)
- [ ] Commit: `add HonoCache with LRU, peek, and concurrent build protection`

---

### Task 11: Legacy extraction adapter + snapshot test for Conventions shape
**Files:**
- `src/tools/legacy-hono-conventions.ts` (NEW — copy of current parseHonoCalls/extractHonoConventions)
- `src/tools/project-tools.ts` (modify — replace body of extractHonoConventions)
- `src/parser/extractors/hono-conventions-adapter.ts` (NEW)
- `tests/tools/hono-conventions-snapshot.test.ts` (NEW)
- `tests/fixtures/hono/conventions-golden.json` (NEW — recorded from legacy output)
- `tests/tools/project-tools.test.ts` (modify — update existing 31 tests)

**Complexity:** complex
**Dependencies:** Task 10
**Execution routing:** deep implementation tier

- [ ] RED: Snapshot test runs both legacy `legacyExtractHonoConventions(source, file)` and new adapter `extractHonoConventions(source, file)` on `basic-app/src/index.ts`, asserts the resulting `Conventions` object has the same top-level shape (keys: `middleware_chains`, `rate_limits`, `route_mounts`, `auth_patterns`). Record the legacy output to `conventions-golden.json` on first run. Known differences documented: middleware name `"(inline handler)"` → `"<inline>"`; assert all other fields match byte-for-byte. Re-run existing 31 Hono tests in `project-tools.test.ts` against the new adapter — all 31 must pass (with `<inline>` name update where applicable). **Caller audit:** Before signature change, grep ALL callers of `extractHonoConventions` (not just tests) — `grep -rn "extractHonoConventions" src/ tests/`. Every non-test caller MUST be converted to `await` the Promise; add `return type: Promise<Conventions>` explicitly so TypeScript fails the build on any missed caller (compile-time guarantee, not manual audit).
- [ ] GREEN:
  1. Copy current `parseHonoCalls`, `extractMiddlewareName`, `extractRateLimit`, `extractHonoConventions`, `inferScope` from `project-tools.ts` verbatim into `legacy-hono-conventions.ts`, exported as `legacyExtractHonoConventions`
  2. Create `hono-conventions-adapter.ts` with function that calls `HonoExtractor.parse()` and maps the `HonoAppModel` to a legacy `Conventions` shape (middleware_chains from `HonoAppModel.middleware_chains`, route_mounts from `HonoAppModel.mounts`, auth_patterns inferred from middleware names matching `/auth|clerk|jwt|session|passport/i`, rate_limits still regex-parsed from source for backward compat)
  3. Rewrite `extractHonoConventions` in `project-tools.ts`:
  ```typescript
  let fallbackCounter = 0;
  export function getHonoFallbackCount(): number { return fallbackCounter; }
  export async function extractHonoConventions(source: string, filePath: string): Promise<Conventions> {
    if (process.env.CODESIFT_LEGACY_HONO === "1") {
      const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
      return legacyExtractHonoConventions(source, filePath);
    }
    try {
      return await honoConventionsAdapter(source, filePath);
    } catch (err) {
      fallbackCounter++;
      logger.warn("Hono AST extractor failed, falling back to legacy", { err, count: fallbackCounter });
      // Loud failure in non-production so CI catches regressions instead of silent degradation
      if (process.env.NODE_ENV !== "production" && process.env.CODESIFT_SILENT_FALLBACK !== "1") {
        throw err;
      }
      const { legacyExtractHonoConventions } = await import("./legacy-hono-conventions.js");
      return legacyExtractHonoConventions(source, filePath);
    }
  }
  ```
  `fallbackCounter` is exposed for integration tests and optional `usage_stats` surfacing. Tests can opt-in to silent fallback via `CODESIFT_SILENT_FALLBACK=1`.
  4. Update the 31 existing tests: any assertion on `"(inline handler)"` updated to `"<inline>"`
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts tests/tools/hono-conventions-snapshot.test.ts`
  Expected: 31 original tests + snapshot test + legacy comparison all pass.
- [ ] Acceptance: Ship criterion 2 (existing tests pass), 21 (snapshot), 22 (caller audit)
- [ ] Commit: `rewrite extractHonoConventions as AST adapter with legacy kill switch`

---

### Task 12: Framework detect — add Hono
**Files:**
- `src/utils/framework-detect.ts` (modify)
- `tests/utils/framework-detect.test.ts` (modify if exists, else NEW)

**Complexity:** standard
**Dependencies:** Task 11
**Execution routing:** default implementation tier

- [ ] RED: Test asserts `detectFrameworks(mockIndex)` returns `Set<Framework>` containing `"hono"` when any of the first 200 symbols has source containing `from 'hono'` or `from "hono"`. Test asserts `isFrameworkEntryPoint(symbol, frameworks, honoModel)` — NEW signature with optional third param — returns `true` when `symbol.file` is in `honoModel.files_used` AND symbol name matches any handler/middleware/mount child_var in the model. Returns `false` for Hono framework without `honoModel` parameter. Returns `true` for existing Next.js/NestJS branches unchanged.
- [ ] GREEN: Update `Framework` union to include `"hono"`. In `detectFrameworks`, add a grep-over-symbols check for `from 'hono'` / `from "hono"` in the first 200 symbol sources. Extend `isFrameworkEntryPoint(symbol, frameworks, honoModel?)` signature — add optional third parameter `honoModel?: HonoAppModel | null`. When `frameworks.has("hono")` and `honoModel` is non-null, check if `symbol.file` is in `honoModel.files_used` and `symbol.name` appears in any `routes[].handler.name`, `middleware_chains[].entries[].name`, or `mounts[].child_var`. Existing Next.js/NestJS branches unchanged.
- [ ] Verify: `npx vitest run tests/utils/framework-detect.test.ts`
  Expected: Hono detection + isFrameworkEntryPoint branch passes; existing tests still pass.
- [ ] Acceptance: AC-D3 (isFrameworkEntryPoint branch)
- [ ] Commit: `add Hono framework detection and entry-point recognition`

---

### Task 13: Cache invalidation wire-up in index-tools.ts
**Files:**
- `src/tools/index-tools.ts` (modify)
- `tests/integration/hono-invalidation.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 10, Task 12
**Execution routing:** deep implementation tier

- [ ] RED: Integration test in `hono-invalidation.test.ts`: (1) Index subapp-app fixture; (2) call `honoCache.get(repo, entryFile)` to warm cache; (3) modify `subapp-app/src/routes/users.ts` (write different content to a temp copy); (4) call the index-tools file change handler with the relative path; (5) call `honoCache.peek(repo)` — assert returns null (invalidated); (6) call `honoCache.get()` again — assert re-parse happened with new content.
- [ ] GREEN: In `src/tools/index-tools.ts`, modify `handleFileChange(repoRoot, repoName, indexPath, relativeFile)` and `handleFileDelete` to dynamically import `honoCache` and call `honoCache.invalidate(join(repoRoot, relativeFile))` after the existing `scanOnChanged` call. Import is dynamic to avoid circular deps. **Path canonicalization:** `invalidate()` internally runs `fs.realpathSync.native(path)` (or falls back to the input if file doesn't exist) and compares against canonicalized entries in `files_used`. Add a symlink test fixture proving invalidation works when the edited file is reached through a symlink.
- [ ] Verify: `npx vitest run tests/integration/hono-invalidation.test.ts`
  Expected: All 6 assertions pass, proving end-to-end invalidation.
- [ ] Acceptance: Success criterion 3 (invalidation correctness)
- [ ] Commit: `wire HonoCache invalidation into file change handler`

---

### Task 14: Extend trace_route with findHonoHandlers
**Files:**
- `src/tools/route-tools.ts` (modify)
- `tests/tools/route-tools.test.ts` (modify)

**Complexity:** complex
**Dependencies:** Task 13
**Execution routing:** deep implementation tier

- [ ] RED: Tests in `route-tools.test.ts` for Hono: (1) basic-app — `trace_route(repo, "/health")` returns handler with `framework: "hono"`, `method: "GET"`; (2) subapp-app — `trace_route(repo, "/api/users/:id")` returns handler from `routes/users.ts`; (3) basepath-app — `trace_route(repo, "/v1/users")` resolves via basePath chain; (4) factory-app — `trace_route(repo, "/ping")` works despite non-`app` variable name; (5) openapi-app — `trace_route(repo, "/users/:id")` finds the `app.openapi(...)` registered handler; (6) basepath-app — `trace_route(repo, "/posts/42")` matches regex-constrained path, `/posts/abc` returns empty handlers.
- [ ] GREEN: In `route-tools.ts`:
  1. Extend `RouteHandler.framework` union with `"hono"`
  2. Add `findHonoHandlers(repo, searchPath)`:
  ```typescript
  async function findHonoHandlers(repo: string, searchPath: string): Promise<RouteHandler[]> {
    const index = await getCodeIndex(repo);
    const entryFile = resolveHonoEntryFile(index); // try orchestrator from classifyFiles, else first file with `new Hono()`
    if (!entryFile) return [];
    const model = await honoCache.get(repo, entryFile, new HonoExtractor());
    return model.routes
      .filter(r => matchHonoPath(r.path, searchPath, r.regex_constraint))
      .map(r => ({ symbol: r.handler, file: r.file, method: r.method, framework: "hono" }));
  }
  ```
  3. Extend `matchPath` helper to honor `regex_constraint` (e.g., `:id{[0-9]+}`) — only match if the path segment satisfies the regex
  4. Spread `...await findHonoHandlers(repo, path)` into the `handlers` array in `traceRoute`
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts`
  Expected: All 6 Hono routing assertions pass, existing NestJS/Next.js/Express tests unchanged.
- [ ] Acceptance: AC-R1, AC-R2, AC-R3, AC-R4, AC-R5, AC-R6, AC-R7, AC-R8, AC-R9
- [ ] Commit: `add findHonoHandlers for trace_route with full Hono routing support`

---

### Task 15: search_patterns — 7 Hono anti-patterns
**Files:**
- `src/tools/pattern-tools.ts` (modify)
- `tests/tools/pattern-tools.test.ts` (modify)

**Complexity:** standard
**Dependencies:** Task 14
**Execution routing:** default implementation tier

- [ ] RED: Tests in `pattern-tools.test.ts`: (1) `hono-missing-validator` matches a route that calls `await c.req.json()` without a preceding `zValidator` middleware — run against a test fixture with the anti-pattern; (2) `hono-unguarded-json-parse` matches `await c.req.json()` outside try/catch; (3) `hono-throw-raw-error` matches `throw new Error(...)` inside a handler with `(c: Context)` signature; (4) `hono-full-app-rpc-export` matches `export type ... = typeof app`; (5) test that on a non-Hono fixture (no `from 'hono'`), `hono-missing-validator` with `file_pattern` restricted to files importing hono returns zero matches; (6) `listPatterns()` includes all 7 new pattern names.
- [ ] GREEN: Add 7 entries to `BUILTIN_PATTERNS` with regexes and descriptions:
  - `hono-missing-error-handler`: `new Hono\s*(?:<[^>]*>)?\s*\(\s*\)` in files where `.onError\s*\(` does not appear
  - `hono-throw-raw-error`: `\bthrow\s+new\s+Error\s*\(` appearing in files containing `(c: Context)` or `(c,\s*next:\s*Next)`
  - `hono-missing-validator`: `await\s+c\.req\.(json|parseBody)\s*\(\s*\)` without `zValidator\s*\(` in the same function body (approximate via nearest-enclosing-brace)
  - `hono-unguarded-json-parse`: `await\s+c\.req\.json\s*\(\s*\)` not preceded by `try\s*\{` in the same block
  - `hono-env-type-any`: `new\s+Hono\s*\(\s*\)` without a `<` generic marker on the same or previous line
  - `hono-missing-status-code`: `c\.json\s*\(\s*\w[^,)]*\)` (single-arg c.json)
  - `hono-full-app-rpc-export`: `export\s+type\s+\w+\s*=\s*typeof\s+app\b`
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts`
  Expected: All 6 pattern assertions pass; `listPatterns()` includes all 7.
- [ ] Acceptance: AC-P1, AC-P2, AC-P3
- [ ] Commit: `add 7 Hono anti-pattern checks to search_patterns`

---

### Task 16: trace_middleware_chain tool (CORE)
**Files:**
- `src/tools/hono-middleware-chain.ts` (NEW)
- `tests/tools/hono-middleware-chain.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 14
**Execution routing:** deep implementation tier

- [ ] RED: Tests: (1) subapp-app — `traceMiddlewareChain(repo, "/api/admin/settings", "GET")` returns ordered list including global middleware (cors, logger) + scoped auth + tenant middleware; (2) order matches registration order; (3) output is `MiddlewareEntry[]` with all fields (`conditional`, `expanded_from`, `owner_var`); (4) calling on non-Hono repo returns empty array with clear message; (5) calling on a path that doesn't match any route returns empty + error message.
- [ ] GREEN: Implement `traceMiddlewareChain(repo, path, method?)`:
  ```typescript
  export async function traceMiddlewareChain(repo, path, method) {
    const model = await getHonoModel(repo); // resolves entry file + calls honoCache.get()
    if (!model) return { error: "No Hono app detected", chain: [] };
    const route = model.routes.find(r => matchHonoPath(r.path, path) && (!method || r.method === method));
    if (!route) return { error: `No route matching ${path}`, chain: [] };
    const chain = model.middleware_chains
      .filter(mc => new RegExp(compileScopePattern(mc.scope_pattern)).test(route.path))
      .flatMap(mc => mc.entries)
      .sort((a, b) => a.order - b.order);
    return { route: route.path, method: route.method, chain };
  }
  ```
  Add `getHonoModel(repo)` helper that resolves the entry file (orchestrator or first Hono file) and calls `honoCache.get()`. Add `compileScopePattern` that converts glob-like `/api/*` to regex.
- [ ] Verify: `npx vitest run tests/tools/hono-middleware-chain.test.ts`
  Expected: All 5 assertions pass.
- [ ] Acceptance: Foundation for Success Criterion 1 (token comparison benchmark)
- [ ] Commit: `add trace_middleware_chain tool`

---

### Task 17: analyze_hono_app tool (CORE, meta)
**Files:**
- `src/tools/hono-analyze-app.ts` (NEW)
- `tests/tools/hono-analyze-app.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 14
**Execution routing:** deep implementation tier

- [ ] RED: Tests: (1) basic-app — `analyzeHonoApp(repo)` returns non-empty model with `extraction_status: "complete"`, 5 routes, 2 middleware; (2) subapp-app — routes from all 3 files included with fully-resolved paths; (3) factory-app — `runtime: "cloudflare"`, `env_bindings` non-empty; (4) non-Hono repo — returns `{ error: "No Hono app detected" }`; (5) `force_refresh: true` calls `honoCache.clear()` before rebuild.
- [ ] GREEN: Implement `analyzeHonoApp(repo, entryFile?, forceRefresh?)`:
  ```typescript
  export async function analyzeHonoApp(repo, entryFile, forceRefresh) {
    if (forceRefresh) honoCache.clear(repo);
    const resolvedEntry = entryFile ?? (await resolveHonoEntryFile(await getCodeIndex(repo)));
    if (!resolvedEntry) return { error: "No Hono app detected" };
    const model = await honoCache.get(repo, resolvedEntry, new HonoExtractor());
    return {
      framework: "hono",
      runtime: model.runtime,
      entry_file: model.entry_file,
      routes: { total: model.routes.length, by_method: groupBy(model.routes, r => r.method) },
      middleware: { chains: model.middleware_chains.length, by_scope: groupBy(model.middleware_chains, mc => mc.scope) },
      context_vars: model.context_vars.map(cv => ({ name: cv.name, set_count: cv.set_points.length, get_count: cv.get_points.length })),
      openapi: { enabled: model.openapi_routes.length > 0, route_count: model.openapi_routes.length },
      rpc_exports: model.rpc_exports.map(r => ({ name: r.export_name, shape: r.shape, is_slow_pattern: r.shape === "full_app" })),
      env_bindings: model.env_bindings,
      extraction_status: model.extraction_status,
    };
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/hono-analyze-app.test.ts`
  Expected: All 5 assertions pass.
- [ ] Acceptance: AC-A1, AC-A2, AC-A3
- [ ] Commit: `add analyze_hono_app meta tool`

---

### Task 18: trace_context_flow tool (hidden)
**Files:**
- `src/tools/hono-context-flow.ts` (NEW)
- `tests/tools/hono-context-flow.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 17
**Execution routing:** deep implementation tier

- [ ] RED: Tests: (1) AC-C1 — basic set/get flow on `userId` returns 1 set_point + 1 get_point; (2) AC-C2 — conditional set reports `condition: "conditional"`; (3) AC-C3 — `getContext()` access reports `via_context_storage: true`; (4) AC-C4 — `c.env.DATABASE_URL` and `c.var.tenantId` reported separately; (5) AC-C5 — variable accessed in route whose middleware scope doesn't include the setter reports `MISSING_CONTEXT_VARIABLE` finding.
- [ ] GREEN: Implement `traceContextFlow(repo, variable?)`:
  ```typescript
  export async function traceContextFlow(repo, variable) {
    const model = await getHonoModel(repo);
    if (!model) return { error: "No Hono app detected" };
    const vars = variable ? model.context_vars.filter(cv => cv.name === variable) : model.context_vars;
    const findings = [];
    for (const cv of vars) {
      for (const get of cv.get_points) {
        const route = model.routes.find(r => r.file === get.file && r.line >= get.line - 20 && r.line <= get.line + 100);
        if (route) {
          const activeChains = model.middleware_chains.filter(mc => new RegExp(compileScopePattern(mc.scope_pattern)).test(route.path));
          const setInActiveMw = cv.set_points.some(sp => activeChains.some(c => c.entries.some(e => e.file === sp.file)));
          if (!setInActiveMw && !cv.is_env_binding) findings.push({ type: "MISSING_CONTEXT_VARIABLE", variable: cv.name, route: route.path, get_point: get });
        }
      }
    }
    return { context_vars: vars, findings };
  }
  ```
- [ ] Verify: `npx vitest run tests/tools/hono-context-flow.test.ts`
  Expected: All 5 AC-C assertions pass.
- [ ] Acceptance: AC-C1, AC-C2, AC-C3, AC-C4, AC-C5
- [ ] Commit: `add trace_context_flow tool with MISSING_CONTEXT_VARIABLE detection`

---

### Task 19: extract_api_contract tool (hidden)
**Files:**
- `src/tools/hono-api-contract.ts` (NEW)
- `tests/tools/hono-api-contract.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 17
**Execution routing:** deep implementation tier

- [ ] RED: Tests: (1) openapi-app — `extractApiContract(repo, format="openapi")` returns OpenAPI 3.1 JSON with `paths["/users/{id}"].get` populated from `createRoute` data; (2) basic-app with only `zValidator` middleware — returns inferred OpenAPI from validators (schemas marked as inferred); (3) format="summary" returns human-readable table `{path, method, request, response}`.
- [ ] GREEN: Implement `extractApiContract(repo, entryFile?, format="openapi")`:
  - For each `openapi_routes` entry, emit a full OpenAPI path item using the explicit schemas
  - For each regular `routes` entry with `validators` (but no matching openapi_route): emit an inferred path item with `x-inferred: true` marker
  - Format `"summary"` produces a flat table
- [ ] Verify: `npx vitest run tests/tools/hono-api-contract.test.ts`
  Expected: All 3 assertions pass.
- [ ] Acceptance: Addresses Issue #3069 (extract OpenAPI from existing Hono app)
- [ ] Commit: `add extract_api_contract tool for OpenAPI inference`

---

### Task 20: trace_rpc_types tool (hidden)
**Files:**
- `src/tools/hono-rpc-types.ts` (NEW)
- `tests/tools/hono-rpc-types.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** Task 17
**Execution routing:** default implementation tier

- [ ] RED: Tests: (1) subapp-app — `traceRpcTypes(repo, serverFile)` returns `export_pattern: "full_app"` with `is_slow: true` and cites Issue #3869; (2) if `export type UserRoutes = typeof userRoutes` exists, returns `export_pattern: "route_group"` with `is_slow: false`; (3) with `clientFile` argument — walks `hc<AppType>()` usage and returns list of client calls with matching server route, flags unused server routes.
- [ ] GREEN: Implement `traceRpcTypes(repo, serverFile, clientFile?)`:
  - Read `model.rpc_exports` to determine pattern and slowness
  - If clientFile provided, grep `clientFile` for `hc<` instantiations and `.$get()`/`.$post()`/`.$put()`/`.$delete()` chain usage; build used-paths set; diff against `model.routes` paths; return `{ used, unused }`
- [ ] Verify: `npx vitest run tests/tools/hono-rpc-types.test.ts`
  Expected: All 3 assertions pass.
- [ ] Acceptance: Addresses Issue #3869 (slow pattern detection)
- [ ] Commit: `add trace_rpc_types tool with slow-pattern detection`

---

### Task 21: audit_hono_security tool (hidden)
**Files:**
- `src/tools/hono-security.ts` (NEW)
- `tests/tools/hono-security.test.ts` (NEW)

**Complexity:** complex
**Dependencies:** Task 17
**Execution routing:** deep implementation tier

- [ ] RED: Tests: (1) subapp-app — returns HIGH finding when mutation route (`POST /api/admin/settings`) has no rate limiting middleware; (2) basic-app — returns MEDIUM finding when no `secure-headers` middleware globally; (3) MEDIUM finding when auth middleware is registered AFTER business logic in chain order; (4) returns empty findings list on a clean fixture (modify basic-app to be secure — add secureHeaders, rate limiter, auth-first).
- [ ] GREEN: Implement `auditHonoSecurity(repo)`:
  - For each mutation route (POST/PUT/DELETE/PATCH): check active middleware chain for `rateLimit`/`rateLimiter` keywords → emit if missing
  - Check global chain for `secureHeaders`/`secure-headers` → emit if missing
  - Walk chain order: if a middleware named matching `/auth|jwt|bearer/i` appears after a non-auth middleware, flag as "auth ordering"
  - Check for `c.env.<VAR>` access where the var name ends in `_SECRET` or `_KEY` without corresponding binding declaration — flag as potential hardcoded secret
  - Return `findings: Array<{ severity: "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", message, file, line }>`
- [ ] Verify: `npx vitest run tests/tools/hono-security.test.ts`
  Expected: All 4 findings scenarios pass.
- [ ] Acceptance: Security audit capability
- [ ] Commit: `add audit_hono_security tool with ordered middleware checks`

---

### Task 22: visualize_hono_routes tool (hidden)
**Files:**
- `src/tools/hono-visualize.ts` (NEW)
- `tests/tools/hono-visualize.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** Task 17
**Execution routing:** default implementation tier

- [ ] RED: Tests: (1) `visualizeHonoRoutes(repo, "mermaid")` returns a mermaid code block showing routes grouped by scope with middleware layers; (2) `"tree"` format returns ASCII tree with indentation per mount level; (3) non-Hono repo returns error.
- [ ] GREEN: Implement `visualizeHonoRoutes(repo, format)`:
  - Build a tree from `model.mounts` (parent_var → children) rooted at the entry app
  - For each node, list routes with their middleware scope names
  - Mermaid output: `graph LR` with nodes per mount, edges per route
  - Tree output: indented text with `├──` and `└──`
- [ ] Verify: `npx vitest run tests/tools/hono-visualize.test.ts`
  Expected: All 3 assertions pass.
- [ ] Acceptance: Documentation generation capability
- [ ] Commit: `add visualize_hono_routes tool`

---

### Task 23: Register all tools + CORE_TOOL_NAMES + EXTRACTOR_VERSIONS + impact_analysis + find_dead_code
**Files:**
- `src/register-tools.ts` (modify)
- `src/tools/impact-tools.ts` (modify)
- `src/tools/symbol-tools.ts` (modify)
- `src/instructions.ts` (modify)
- `tests/tools/impact-tools.test.ts` (modify)
- `tests/tools/register-tools.test.ts` (modify if exists, else NEW)

**Complexity:** complex
**Dependencies:** Tasks 15, 16, 17, 18, 19, 20, 21, 22
**Execution routing:** deep implementation tier

- [ ] RED: Tests: (1) `TOOL_DEFINITIONS` includes all 7 new Hono tool names; (2) `CORE_TOOL_NAMES` contains `trace_middleware_chain` and `analyze_hono_app`; (3) `discover_tools(query="hono")` returns all 7 new names plus extended existing tools; (4) AC-I1 — middleware edit triggers blast radius augmentation; (5) AC-I2 — non-Hono repo no augmentation, no error; (6) AC-D1 — dead code on mounted sub-app → not flagged; (7) instructions.ts includes Hono tool hints.
- [ ] GREEN:
  1. Add 7 `ToolDefinition` entries in `register-tools.ts` for the Hono tools (model after `trace_route` definition): `trace_middleware_chain`, `analyze_hono_app`, `trace_context_flow`, `extract_api_contract`, `trace_rpc_types`, `audit_hono_security`, `visualize_hono_routes`
  2. Add `trace_middleware_chain` and `analyze_hono_app` to `CORE_TOOL_NAMES` Set
  3. Bump `EXTRACTOR_VERSIONS.hono` from `"1.0.0"` to `"2.0.0"`
  4. In `src/tools/impact-tools.ts`, after computing the base affected-symbols set: call `honoCache.peek(repo)`; if non-null, iterate changed files, find matching middleware entries, add routes with matching `scope_pattern` to affected set
  5. In `src/tools/symbol-tools.ts::findDeadCode`, fetch `honoCache.peek(repo)` once per call and pass to `isFrameworkEntryPoint(symbol, frameworks, honoModel)`
  6. In `src/instructions.ts`, add a line to `CODESIFT_INSTRUCTIONS`: "For Hono projects, call `analyze_hono_app` first for overview, `trace_middleware_chain` for route middleware debugging."
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts tests/tools/impact-tools.test.ts`
  Expected: All new assertions + existing impact/symbol tests pass.
- [ ] Acceptance: AC-D1, AC-D3, AC-I1, AC-I2; ship criteria 12, 13, 15, 16
- [ ] Commit: `register 7 Hono tools, promote 2 to core, bump extractor version, wire impact/dead-code augmentation`

---

### Task 24: Documentation updates — tool count 88 → 95
**Files:**
- `CLAUDE.md` (modify)
- `README.md` (modify)
- `src/instructions.ts` (modify)
- `package.json` (modify — description + bench script)
- `rules/codesift.md` (modify)
- `rules/codesift.mdc` (modify)
- `rules/codex.md` (modify)
- `rules/gemini.md` (modify)

**Complexity:** standard
**Dependencies:** Task 23
**Execution routing:** default implementation tier

- [ ] RED: Test not applicable (documentation-only). Instead, verification is a grep-based assertion: `grep -rn "72 tools\|72 MCP\|66 tools" CLAUDE.md README.md rules/ src/instructions.ts package.json` returns zero matches; `grep -rn "95 tools" CLAUDE.md README.md rules/ src/instructions.ts package.json` returns at least 5 matches.
- [ ] GREEN:
  1. `CLAUDE.md`: line 55 grep hint `72 tools|72 MCP` → `95 tools|95 MCP`; line 60 `72 MCP tools (36 core + 36 discoverable)` → `95 MCP tools (39 core + 56 discoverable)`
  2. `README.md`: line 318 `72 tools to AI agents (36 core + 36 discoverable)` → `95 tools to AI agents (39 core + 56 discoverable)`
  3. `src/instructions.ts` line 5: `72 MCP tools (36 core, 36 hidden via disable())` → `95 MCP tools (39 core, 56 hidden via disable())`
  4. `package.json` description: `66 tools` → `95 tools`. Add to scripts: `"bench:hono": "tsx tests/benchmarks/hono-token-comparison.ts"`
  5. `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`: update any tool count mentions; add Hono tool mapping entries to the tool mapping tables: `hono routing` → `trace_middleware_chain`; `hono overview` → `analyze_hono_app`; `hono context flow` → `trace_context_flow`; etc.
- [ ] Verify: `grep -rn "72 tools\|72 MCP\|66 tools" CLAUDE.md README.md rules/ src/instructions.ts package.json` returns zero matches; `grep -rn "95 tools" CLAUDE.md README.md rules/ src/instructions.ts package.json` returns at least 5 hits.
- [ ] Acceptance: Ship criterion 14
- [ ] Commit: `update tool count to 95 across docs, instructions, and package.json`

---

### Task 25: Benchmarks + final full test run
**Files:**
- `tests/benchmarks/hono-token-comparison.ts` (NEW)
- `tests/parser/hono-extractor-benchmark.test.ts` (NEW)
- `tests/cache/hono-cache-benchmark.test.ts` (NEW)

**Complexity:** standard
**Dependencies:** Task 24
**Execution routing:** default implementation tier

- [ ] RED: Tests: (1) extractor benchmark — parse subapp-app cold in under 200ms, warm under 5ms; (2) cache benchmark — 100 sequential `get()` calls on same repo result in >90% hit rate (only first is a miss); (3) token comparison script emits JSON with `baseline_tokens`, `tool_tokens`, `reduction_pct >= 70`.
- [ ] GREEN: Create three benchmark files. Token comparison uses fixed baseline: 6 simulated `search_text` calls (mocked) + 3 file reads of subapp-app files (counts actual bytes/4 ≈ tokens) vs 1 `trace_middleware_chain` + 1 `trace_route` (counts response bytes). Extract benchmark uses `performance.now()` around `new HonoExtractor().parse(fixturePath)`. Cache benchmark uses `honoCache.get()` in a loop with counter for hits vs misses.
- [ ] Verify:
  - `npx vitest run tests/parser/hono-extractor-benchmark.test.ts tests/cache/hono-cache-benchmark.test.ts`
  - `npx tsx tests/benchmarks/hono-token-comparison.ts` → prints JSON with `reduction_pct >= 70`
  - `npx vitest run` — all 944+ tests plus new ~100 tests pass
  - `npm run build` — zero TypeScript errors
- [ ] Acceptance: Ship criteria 1, 17, 18, 20; Success criteria 1, 2
- [ ] Commit: `add hono benchmarks and final validation`

---

## Run Log

Run: 2026-04-10T20:50:00Z	plan	codesift-mcp	-	-	PASS	25	3-phase	hono framework intelligence plan	main	92720f4
