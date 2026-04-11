# Implementation Plan: NestJS Support Wave 2 (G1-G14 gap coverage)

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 3
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 18
**Estimated complexity:** 10 standard + 8 complex

## Architecture Summary

**Scope:** 14 gaps (G1-G14) discovered via real-world testing of Wave 1 tools against `lujakob/nestjs-realworld-example-app`. Wave 2 fixes real false negatives (G1 middleware auth, G3 generic types) and extends coverage to GraphQL, WebSocket, schedule/events, TypeORM entities, and microservices.

**Components:**
- **Modified:** `src/tools/nest-tools.ts` (+180 lines → ~1075), `src/tools/project-tools.ts` (+25 — G1/G2 NestConventions fields), `src/utils/framework-detect.ts` (+5 — G7/G8 regex), `src/register-tools.ts` (+60 — **5 new tool registrations**), `src/tools/pattern-tools.ts` (+12 — new anti-patterns)
- **NEW:** `src/tools/nest-ext-tools.ts` (~420 lines) housing **5 standalone tools**: G5 `nestGraphQLMap`, G6 `nestWebSocketMap`, G7+G8 `nestScheduleMap` (combined), G12 `nestTypeOrmMap`, G14 `nestMicroserviceMap`. **G13 (health checks) is NOT a standalone tool** — it is implemented as an `is_health_check: boolean` flag on `NestRouteEntry` inside the existing `nestRouteInventory` function (see Task 9).
- **NEW test:** `tests/tools/nest-ext-tools.test.ts` (~480 lines)
- **Modified tests:** `tests/tools/nest-tools.test.ts` (+120 — G1/G3/G4 extensions), `tests/tools/framework-auto-enable.test.ts` (update hardcoded 5-tool list → 11)

**Data flow:** G3 fixes `extractInjectedTypes` helper used by `nestDIGraph`. G2 extends `extractNestConventions` (project-tools.ts) which feeds `nestModuleGraph`. G1 adds middleware parsing to `nestGuardChain` as new `"middleware"` layer. G4 adds custom-decorator detection to `parseUseGuards` context. G5/G6/G7/G8/G12/G13/G14 are new tools in `nest-ext-tools.ts` following the established `readFile → regex → structured result` pattern from Wave 1, all wired into `nestAudit` orchestrator via `ALL_NEST_CHECKS`.

**Dependencies:**
- `nest-ext-tools.ts` → `nest-tools.ts` (imports `detectCycles` — requires export)
- `nest-ext-tools.ts` → `index-tools.ts` (`getCodeIndex`)
- `nestAudit` → all new tool functions
- `register-tools.ts` → `nest-ext-tools.ts` (new handler imports + FRAMEWORK_TOOL_BUNDLES extension)

## Technical Decisions

- **File split:** `nest-ext-tools.ts` for G5/G6/G7/G8/G12/G13/G14 (new tools, no helper coupling). Keep G1-G4 in `nest-tools.ts` (coupled to private `parseUseGuards`, `extractInjectedTypes`).
- **Export `detectCycles`** from `nest-tools.ts` for G12 reuse (not copy-paste — CQ14 compliance).
- **Combined G7+G8** into single `nestScheduleMap` tool — cron and events share file-I/O pattern and are semantically related (async triggers).
- **Separate tools** for G5/G6/G12/G14 (not merged into route_inventory) — different output shapes would corrupt the existing route entry contract.
- **G1 middleware via new `parseMiddlewareChains` helper** — additive to globalChain collection, NOT a modification of method-position lookback logic in nestGuardChain (too fragile).
- **G3 fix:** change `extractInjectedTypes` regex from `/^(\w+)/` to `/^(\w+)(?:<(\w+)>)?/` and return the generic param as a separate field. Preserves existing behavior for non-generic types.
- **No new dependencies.** All parsing regex-over-source (Wave 1 precedent).
- **CQ6 caps** on all new tools: `max_entries` (GraphQL), `max_gateways`, `max_schedules`, `max_entities` (TypeORM), `max_patterns` (microservice) — each with `truncated: true` flag.
- **`nestScheduleMap` test-file exclusion:** since it scans all `.ts`/`.js` files (not a fixed suffix), exclude files matching `/\.(spec|test)\./` to avoid picking up test fixtures with `@Cron()` calls.

## Quality Strategy

- **Test framework:** Vitest. Two fixture patterns: `mockIndex` (symbol-only, no I/O — used by lifecycle/framework-detect tests) and `tmpdir + writeFile` (real files — used by all file-reading tools).
- **CQ gates activated:** CQ6 (new unbounded graph tools need caps), CQ8 (readFile error handling → `errors` array per Wave 1 pattern), CQ14 (shared parsing helpers — `parseUse*` family reused; `detectCycles` exported for G12).
- **Regression canaries:**
  1. `framework-auto-enable.test.ts:35-44` hardcodes 5-tool array — MUST update to **10** (5 Wave 1 + 5 Wave 2, `nest_audit` stays core outside bundle) in lock-step with `FRAMEWORK_TOOL_BUNDLES` extension.
  2. `nestGuardChain` tests form the regression canary for G1 — middleware must not corrupt the empty-chain assertion for no-guard routes.
  3. `detectCycles` export must land BEFORE any G12 task imports it, or build will break.
- **Sequencing constraint (CRITICAL):** Tasks 10→11→12→13→14 all modify `nest-ext-tools.ts` and `nest-ext-tools.test.ts` and MUST execute strictly sequentially. Tasks 3 and 6 both modify `extractNestConventions` in `project-tools.ts` and MUST sequence Task 3 before Task 6 (dependency already declared).
- **Test count target:** Wave 1 = 167 NestJS tests → Wave 2 target = ~245 tests (+78 across new and extended suites).
- **File size:** `nest-tools.ts` at 895 → ~1025 lines (precedent: `context-tools.ts` 582 lines — acceptable composite file). `nest-ext-tools.ts` target ≤500 lines — split further if exceeded.

## Task Breakdown

### Task 1: G3 — Fix extractInjectedTypes generic parameter extraction
**Files:** `src/tools/nest-tools.ts` (lines 280-309), `tests/tools/nest-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add test in `tests/tools/nest-tools.test.ts` within existing `nest_di_graph` describe block. Fixture: `@Injectable() class ArticleService { constructor(@InjectRepository(Article) private readonly repo: Repository<Article>) {} }`. Assert `nestDIGraph` returns edge `ArticleService → Article` (the generic parameter), NOT `ArticleService → Repository`. Also test: `Map<string, Foo>` → `Foo`, plain type `UserService` still works (regression).
- [ ] GREEN: In `nest-tools.ts`, modify `extractInjectedTypes` (line 280-309). Change type extraction: after finding `:` separator, match `/^(\w+)(?:<([^>]+)>)?/` — if generic capture exists AND the outer type is a "container" type (`Repository|Model|Repo|Collection|Map|Array|Set|Observable|Promise`), return the inner type; otherwise return the outer type. Keep simple non-generic behavior unchanged.
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "nest_di_graph"`
  Expected: all 7 di_graph tests pass (6 existing + 1 new), edge `ArticleService → Article` present
- [ ] Acceptance: G3 — Repository<T> and similar container generics resolve to inner type
- [ ] Commit: `fix: extract generic type parameter from Repository<T> in DI graph (G3)`

### Task 2: G7+G8 — framework-detect regex for schedule + event-emitter
**Files:** `src/utils/framework-detect.ts`, `tests/utils/framework-detect.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add tests in `tests/utils/framework-detect.test.ts`. Test `detectFrameworks` on mock index with sources:
  1. `@nestjs/schedule` import + `@Cron('*/5 * * * *')` method decorator → should still detect `nestjs`
  2. `@nestjs/event-emitter` import + `@OnEvent('user.created')` → should detect `nestjs`
  3. `@nestjs/graphql` import + `@Resolver()` → should detect `nestjs`
  4. `@WebSocketGateway()` decorator → should detect `nestjs`
  (Lifecycle hook regex assertions for `handleCron`/`handleInterval`/etc are covered in Task 5, NOT here — avoid writing assertions now that Task 5 will flip.)
- [ ] GREEN: In `framework-detect.ts` extend `detectFrameworks` — the existing `@nestjs/` substring check already catches schedule/event-emitter/graphql/websockets packages (they all start with `@nestjs/`). No change needed if detection already works. If test fails, add specific substring checks.
- [ ] Verify: `npx vitest run tests/utils/framework-detect.test.ts`
  Expected: all tests pass, new tests confirm all NestJS sub-packages detected
- [ ] Acceptance: G7/G8 — NestJS sub-package imports detected by framework detector
- [ ] Commit: `test: verify NestJS sub-package detection (schedule, event-emitter, graphql, websockets)`

### Task 3: G2 — Parse dynamic module calls in extractNestConventions
**Files:** `src/tools/project-tools.ts` (lines 144-167, 900-1034), `tests/tools/project-tools.test.ts`
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Add test in `tests/tools/project-tools.test.ts` within existing `extractNestConventions` describe block. Fixture: module source with `TypeOrmModule.forFeature([Article, Comment, User])` and `ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' })`. Assert:
  - `conv.modules[0].name === "TypeOrmModule"` (existing behavior preserved)
  - `conv.modules[0].entities` is `["Article", "Comment", "User"]` (NEW field)
  - `conv.modules[1].name === "ConfigModule"`
  - `conv.modules[1].is_global === true` (existing)
  - `conv.modules[1].dynamic_config_keys` includes `"envFilePath"` (NEW field, optional)
- [ ] GREEN: In `project-tools.ts`:
  1. Extend `NestModuleEntry` interface (line 156-162) with optional fields: `entities?: string[]`, `dynamic_config_keys?: string[]`.
  2. In `extractNestConventions` (line 900-1034) at the module matching block (line 944-955), after extracting `name`, scan forward up to 15 lines from the current line for:
     - `forFeature\(\[([^\]]+)\]\)` → split by `,`, extract class names → `entities`
     - `forRoot\(\{([^}]+)\}\)` or `forRootAsync\(\{` → extract top-level key names → `dynamic_config_keys`
  3. Attach extracted data to the module entry.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts -t "extractNestConventions"`
  Expected: all 12+ existing tests pass plus new dynamic module test
- [ ] Acceptance: G2 — dynamic module factory calls expose entity and config metadata
- [ ] Commit: `feat: parse forFeature entities and forRoot config keys in NestConventions (G2)`

### Task 4: Export detectCycles from nest-tools.ts
**Files:** `src/tools/nest-tools.ts` (line 201)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add a micro-test in `tests/tools/nest-tools.test.ts` that imports `detectCycles` from `nest-tools.ts` and asserts it detects a simple cycle `[A→B, B→A]` returning `[["A","B","A"]]`.
- [ ] GREEN: In `nest-tools.ts` line 201, change `function detectCycles(...)` to `export function detectCycles(...)`. Nothing else changes.
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "detectCycles"`
  Expected: new test passes, all 25 other nest-tools tests still pass
- [ ] Acceptance: `detectCycles` available for reuse in nest-ext-tools.ts (CQ14)
- [ ] Commit: `refactor: export detectCycles helper for cross-file reuse`

### Task 5: Add lifecycle hook regex for @Cron/@Interval/@Timeout/@OnEvent
**Files:** `src/utils/framework-detect.ts`, `tests/utils/framework-detect.test.ts`
**Complexity:** standard
**Dependencies:** Task 2
**Execution routing:** default implementation tier

- [ ] RED: In `tests/utils/framework-detect.test.ts`, test `isFrameworkEntryPoint`:
  - Symbol named `handleCron` in `src/jobs/billing.service.ts` with NestJS framework active → returns `true`
  - Symbol named `handleInterval`, `handleTimeout` in service files → return `true`
  - Symbol named `handleEvent` in any file → returns `true` (event handlers are entry points)
  - Non-matching name like `handleCronJob` → returns `false` (strict word match)
- [ ] GREEN: In `framework-detect.ts` line 17, extend `NESTJS_LIFECYCLE` regex: `^(onModuleInit|onModuleDestroy|onApplicationBootstrap|onApplicationShutdown|beforeApplicationShutdown|handleCron|handleInterval|handleTimeout|handleEvent)$`. This is the 2-line change from Architect Phase A.
- [ ] Verify: `npx vitest run tests/utils/framework-detect.test.ts`
  Expected: all tests pass including new @Cron/@OnEvent entry point cases
- [ ] Acceptance: G7/G8 — scheduled task and event handler methods whitelisted from dead-code detection
- [ ] Commit: `feat: whitelist @Cron/@Interval/@Timeout/@OnEvent methods as framework entry points (G7,G8)`

### Task 6: G1 — Parse NestJS middleware configuration
**Files:** `src/tools/project-tools.ts` (NestConventions interface + extractNestConventions), `tests/tools/project-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 3
**Execution routing:** deep implementation tier

- [ ] RED: Add test in `project-tools.test.ts`. Fixture: AppModule with:
  ```ts
  export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(AuthMiddleware).forRoutes({ path: 'users/*', method: RequestMethod.ALL });
      consumer.apply(LogMiddleware).forRoutes('*');
    }
  }
  ```
  Assert:
  - `conv.middleware_chains` is an array of 2 entries (NEW field)
  - First entry: `{ middleware: "AuthMiddleware", routes: [{ path: "users/*", method: "ALL" }], file: ..., line: ... }`
  - Second entry: `{ middleware: "LogMiddleware", routes: [{ path: "*" }] }`
- [ ] GREEN: In `project-tools.ts`:
  1. Extend `NestConventions` interface (line 146-153) with optional `middleware_chains?: MiddlewareChainEntry[]`.
  2. Define `MiddlewareChainEntry` type near `NestProviderEntry`: `{ middleware: string; routes: Array<{ path: string; method?: string }>; file: string; line: number }`.
  3. Add `parseMiddlewareChains(source, filePath)` function: scan source for `configure\s*\(\s*consumer[^)]*\)\s*\{` → inside the block capture `consumer\.apply\s*\((\w+)\)\.forRoutes\s*\(([^)]+)\)` pairs. Parse the forRoutes arguments: strings become `{ path }`, objects become `{ path, method }`.
  4. Call `parseMiddlewareChains` in `extractNestConventions` and populate `middleware_chains` field.
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts -t "parseMiddlewareChains"`
  Expected: new middleware tests pass (use the exact describe or test-name string written in RED, not a loose substring)
- [ ] Acceptance: G1 (parser half) — middleware application chain extracted from module source
- [ ] Commit: `feat: parse NestJS middleware.configure(consumer) chains (G1 parser)`

### Task 7: G1 — Wire middleware chain into nestGuardChain
**Files:** `src/tools/nest-tools.ts` (nestGuardChain lines 474-569), `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 6
**Execution routing:** deep implementation tier

- [ ] RED: Add test in `tests/tools/nest-tools.test.ts` within `nest_guard_chain` describe. Fixture: an AppModule with `configure(consumer)` applying `AuthMiddleware` to `users/*`, plus a `UsersController` with a `@Get('users/:id')` method and NO `@UseGuards()`. Assert:
  - Returned route `/users/:id` has `chain` containing an entry with `layer: "middleware"`, `type: "guard"` (or new `type: "middleware"`), `name: "AuthMiddleware"`.
  - Route `/health` from a different controller has empty chain (regression — middleware doesn't leak to all routes).
- [ ] GREEN: In `nest-tools.ts`:
  1. Update `NestGuardChainEntry.chain` layer union to include `"middleware"` (line ~397).
  2. In `nestGuardChain` (line 474-569), after collecting `globalChain` from `extractNestConventions`, also read `conv.middleware_chains` (from Task 6). **Use defensive default: `const middlewareEntries = conv.middleware_chains ?? [];`** — Task 6 may populate an empty array but TypeScript allows `undefined` on optional fields. For each middleware chain entry, evaluate its `forRoutes` paths against each discovered route using glob-like matching (`users/*` matches `users/:id`). Append matching middleware as chain items with `layer: "middleware"`.
  3. CRITICAL: must NOT modify the existing `allMethodPositions` lookback logic at lines 529-552. Middleware injection happens at route-append time, not method-scan time.
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "nest_guard_chain"`
  Expected: all 4+ guard chain tests pass (3 existing + 1 new), existing no-guard-route test still asserts empty chain when no middleware matches
- [ ] Acceptance: G1 (consumer half) — middleware-based auth now visible in guard chain output
- [ ] Commit: `feat: include NestJS middleware in nest_guard_chain output (G1)`

### Task 8: G4 — Custom decorator detection in guard chain
**Files:** `src/tools/nest-tools.ts` (parseUseGuards + nestGuardChain), `tests/tools/nest-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 7
**Execution routing:** default implementation tier

- [ ] RED: Add test in `nest_guard_chain` describe. Fixture: controller with `@Roles('admin')` decorator on a method (a custom decorator, NOT `@UseGuards`). Assert route entry chain includes an entry with `layer: "method"`, `type: "metadata"`, `name: "Roles"`, `args: "admin"`.
- [ ] GREEN: In `nest-tools.ts`:
  1. **Extend `NestGuardChainEntry.chain` item type** (line ~397) with `args?: string` field and `type` union with `"metadata"`. Required BEFORE writing RED test assertion.
  2. Add new helper `parseCustomDecorators(source)` that matches `@(\w+)\s*\(([^)]*)\)` for PascalCase decorator names NOT in the built-in set (`Get|Post|Put|Delete|Patch|Controller|Injectable|UseGuards|UseInterceptors|UsePipes|UseFilters|Param|Body|Query|Headers|Req|Res|Next|Version|ApiOperation|ApiBearerAuth|ApiTags|HealthCheck`).
  3. In `nestGuardChain` method scanning (line ~548), call `parseCustomDecorators` on the same `methodCtx` window and append results as chain items with `type: "metadata"`, populating `args` with the raw decorator argument text (stripped of quotes).
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "nest_guard_chain"`
  Expected: custom decorator `@Roles('admin')` appears in chain
- [ ] Acceptance: G4 — custom decorators (like `@Roles`, `@Public`) visible as metadata in guard chain
- [ ] Commit: `feat: detect custom decorators in NestJS guard chain (G4)`

### Task 9: G9/G10/G11/G13 — Extend nestRouteInventory with versioning, Swagger, inline pipes, health tagging
**Files:** `src/tools/nest-tools.ts` (NestRouteEntry interface + nestRouteInventory), `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** none (extends existing function)
**Execution routing:** deep implementation tier

- [ ] RED: Add test cases in `nest_route_inventory` describe. Fixture: controller source with:
  ```ts
  @Controller({ path: 'users', version: '2' })
  @ApiTags('users')
  export class UsersController {
    @Get(':id')
    @Version('3')
    @ApiOperation({ summary: 'Get user by id' })
    @ApiBearerAuth()
    findOne() {}
    @Get('health')
    @HealthCheck()
    health() {}
    @Post()
    @UsePipes(new ValidationPipe({ whitelist: true }))
    create() {}
  }
  ```
  Assert:
  - `route.version === "3"` (method-level overrides controller-level)
  - `route.swagger === { summary: "Get user by id", bearer: true, tags: ["users"] }`
  - health route has `is_health_check === true`
  - create route has `inline_pipes === ["ValidationPipe"]`
- [ ] GREEN: In `nest-tools.ts`:
  1. Extend `NestRouteEntry` interface with optional fields: `version?: string`, `swagger?: { summary?: string; tags?: string[]; bearer?: boolean }`, `is_health_check?: boolean`, `inline_pipes?: string[]`.
  2. In `nestRouteInventory` (line ~596), in the method-level parse section, add regex matches for:
     - `@Version\s*\(\s*['"\`]([^'"\`]+)['"\`]\)` → `version`
     - `@ApiOperation\s*\(\s*\{[^}]*summary:\s*['"\`]([^'"\`]+)['"\`]` → `swagger.summary`
     - `@ApiBearerAuth\s*\(\s*\)` → `swagger.bearer = true`
     - `@HealthCheck\s*\(\s*\)` → `is_health_check = true`
     - `@UsePipes\s*\(\s*new\s+(\w+Pipe)\s*\(` → append to `inline_pipes`
  3. Controller-level: extract `@ApiTags(...)` and `version` from `@Controller({...})` object destructure.
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "nest_route_inventory"`
  Expected: all 3+ route inventory tests pass (2 existing + 1 new)
- [ ] Acceptance: G9/G10/G11/G13 — route inventory exposes versioning, Swagger metadata, inline pipes, health tags
- [ ] Commit: `feat: extend nest_route_inventory with version/swagger/health/inline-pipes (G9-G13)`

### Task 10: G5 — nestGraphQLMap tool
**Files:** `src/tools/nest-ext-tools.ts` (NEW), `tests/tools/nest-ext-tools.test.ts` (NEW)
**Complexity:** complex
**Dependencies:** Task 4 (detectCycles export)
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/nest-ext-tools.test.ts` with `describe("nest_graphql_map")` block. Fixture: write `src/article/article.resolver.ts` with:
  ```ts
  @Resolver(() => Article)
  export class ArticleResolver {
    @Query(() => [Article])
    async articles() { return []; }
    @Mutation(() => Article)
    async createArticle(@Args('input') input: CreateArticleInput) {}
    @Subscription(() => Article)
    articleCreated() {}
  }
  ```
  Assert:
  - `result.entries.length === 3`
  - Entry for `articles` has `operation: "Query"`, `resolver_class: "ArticleResolver"`, `handler: "articles"`
  - Entry for `createArticle` has `operation: "Mutation"`
  - Entry for `articleCreated` has `operation: "Subscription"`
  - Empty repo returns empty entries
  - Truncation: pass `max_entries: 1`, expect `result.entries.length === 1`, `result.truncated === true`
  - CQ8: unreadable file → added to `errors` array, not crash
- [ ] GREEN: Create `src/tools/nest-ext-tools.ts` with:
  1. Import `readFile` from `node:fs/promises`, `join` from `node:path`, `getCodeIndex` from `./index-tools.js`, `detectCycles` and `NestToolError` type from `./nest-tools.js`.
  2. Define `NestGraphQLEntry`, `NestGraphQLMapResult` types (per Architect interfaces section).
  3. Implement `nestGraphQLMap(repo, options)`:
     - Filter `index.files` to `.resolver.ts` / `.resolver.js`
     - For each, try-catch readFile → on fail append to errors
     - Find `class\s+(\w+)\s+.*?@Resolver` for resolver class name
     - Find `@(Query|Mutation|Subscription)\s*\([\s\S]*?\)\s*(?:async\s+)?(\w+)` for operations
     - Apply `max_entries` cap with `truncated: true` flag
- [ ] Verify: `npx vitest run tests/tools/nest-ext-tools.test.ts -t "nest_graphql_map"`
  Expected: all 4+ GraphQL map tests pass
- [ ] Acceptance: G5 — GraphQL resolvers indexed with operation type
- [ ] Commit: `feat: add nest_graphql_map tool for NestJS GraphQL resolver discovery (G5)`

### Task 11: G6 — nestWebSocketMap tool
**Files:** `src/tools/nest-ext-tools.ts`, `tests/tools/nest-ext-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 10 (STRICT — same file)
**Execution routing:** default implementation tier

- [ ] RED: Add `describe("nest_websocket_map")` block. Fixture: write `src/chat/chat.gateway.ts`:
  ```ts
  @WebSocketGateway(3001, { namespace: '/chat', cors: true })
  export class ChatGateway {
    @SubscribeMessage('message')
    handleMessage(@MessageBody() data: string) {}
    @SubscribeMessage('join')
    handleJoin() {}
  }
  ```
  Assert:
  - `result.gateways.length === 1`
  - `gateway.port === 3001`, `gateway.namespace === "/chat"`
  - `gateway.events.length === 2`, entries `{ event: "message", handler: "handleMessage" }` and `{ event: "join", handler: "handleJoin" }`
  - Empty repo returns empty gateways
  - CQ8: unreadable file → errors array
- [ ] GREEN: In `nest-ext-tools.ts` add:
  1. `NestGatewayEntry`, `NestGatewayMapResult` types.
  2. Implement `nestWebSocketMap(repo, options)`:
     - Filter `index.files` to `.gateway.ts` / `.gateway.js`
     - Parse `@WebSocketGateway\s*\(\s*(\d+)?\s*(?:,\s*\{([^}]*)\})?\s*\)` for port + options
     - Extract `namespace:\s*['"\`]([^'"\`]+)['"\`]` from options
     - Parse `@SubscribeMessage\s*\(\s*['"\`]([^'"\`]+)['"\`]\s*\)\s*\n\s*(?:async\s+)?(\w+)` for events
- [ ] Verify: `npx vitest run tests/tools/nest-ext-tools.test.ts -t "nest_websocket_map"`
  Expected: all WebSocket tests pass
- [ ] Acceptance: G6 — WebSocket gateways + subscribed events indexed
- [ ] Commit: `feat: add nest_websocket_map tool for NestJS gateway discovery (G6)`

### Task 12: G7+G8 — nestScheduleMap tool
**Files:** `src/tools/nest-ext-tools.ts`, `tests/tools/nest-ext-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 11 (STRICT — same file)
**Execution routing:** deep implementation tier

- [ ] RED: Add `describe("nest_schedule_map")` block. Fixture: write `src/jobs/billing.service.ts`:
  ```ts
  @Injectable()
  export class BillingService {
    @Cron('0 0 * * *')
    handleDailyBilling() {}
    @Interval(60000)
    handleHealthCheck() {}
    @Timeout(5000)
    handleStartup() {}
    @OnEvent('user.created')
    async onUserCreated(payload: UserCreatedEvent) {}
  }
  ```
  Assert:
  - `result.entries.length === 4`
  - Cron entry: `{ decorator: "@Cron", expression: "0 0 * * *", handler: "handleDailyBilling", class_name: "BillingService" }`
  - Interval entry: `{ decorator: "@Interval", interval_ms: 60000 }`
  - Timeout entry: `{ decorator: "@Timeout", interval_ms: 5000 }`
  - OnEvent entry: `{ decorator: "@OnEvent", expression: "user.created" }`
  - **CQ6: truncation** — pass `max_schedules: 2`, expect `result.entries.length === 2`, `result.truncated === true`
  - **CQ8: unreadable file** — index references a missing file, expect `result.errors` array contains entry, no crash
  - **Test file exclusion** — fixture writes `src/jobs/billing.spec.ts` with `@Cron()` — must NOT appear in results
- [ ] GREEN: In `nest-ext-tools.ts` add:
  1. `NestScheduledEntry`, `NestScheduleMapResult` types.
  2. Implement `nestScheduleMap(repo, options)`:
     - Scan all `.ts` / `.js` files, **exclude files matching `/\.(spec|test)\./`**. **CQ6 work bound:** pre-filter to `.service.ts` AND any file with substring match for `@Cron`/`@Interval`/`@Timeout`/`@OnEvent` via a quick `index.files` filter (avoid reading the whole repo — `max_schedules` bounds output, not work). Add `max_files_scanned: number` option (default 2000) as hard I/O cap.
     - Parse 4 decorator patterns:
       - `@Cron\s*\(\s*['"\`]([^'"\`]+)['"\`]\s*\)` → expression
       - `@Interval\s*\(\s*(\d+)\s*\)` → interval_ms
       - `@Timeout\s*\(\s*(\d+)\s*\)` → interval_ms
       - `@OnEvent\s*\(\s*['"\`]([^'"\`]+)['"\`]\s*\)` → expression (event name)
     - Capture enclosing class name via backward scan
     - **CQ6:** Apply `max_schedules` cap (default 300), set `truncated: true` if exceeded
     - **CQ8:** Wrap `readFile` in try/catch, append `{ file, reason }` to `errors` array, do not abort
- [ ] Verify: `npx vitest run tests/tools/nest-ext-tools.test.ts -t "nest_schedule_map"`
  Expected: all 4+ scheduler tests pass
- [ ] Acceptance: G7/G8 — cron jobs, intervals, timeouts, and event listeners indexed
- [ ] Commit: `feat: add nest_schedule_map tool for cron/interval/timeout/onEvent discovery (G7+G8)`

### Task 13: G12 — nestTypeOrmMap tool
**Files:** `src/tools/nest-ext-tools.ts`, `tests/tools/nest-ext-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 4 (detectCycles export), Task 12 (STRICT — same file)
**Execution routing:** deep implementation tier

- [ ] RED: Add `describe("nest_typeorm_map")` block. Fixture: write entities:
  ```ts
  // src/article/article.entity.ts
  @Entity('articles')
  export class Article {
    @PrimaryGeneratedColumn() id: number;
    @Column() title: string;
    @OneToMany(() => Comment, c => c.article) comments: Comment[];
    @ManyToOne(() => User, u => u.articles) author: User;
  }
  ```
  (plus Comment, User). Assert:
  - `result.entities.length === 3`
  - `article.table === "articles"`
  - Edges include `{ from: "Article", to: "Comment", relation: "OneToMany" }`, `{ from: "Article", to: "User", relation: "ManyToOne" }`
  - Circular relations detected via reused `detectCycles`
  - **CQ6: truncation** — `max_entities: 1`, expect `result.entities.length === 1`, `result.truncated === true`
  - **CQ8: unreadable entity file** — indexed file not on disk → `result.errors.length === 1`, no crash
- [ ] GREEN: In `nest-ext-tools.ts` add:
  1. `NestEntityNode`, `NestEntityEdge`, `NestTypeOrmMapResult` types.
  2. Implement `nestTypeOrmMap(repo, options)`:
     - Filter `index.files` to `.entity.ts` / `.entity.js`
     - For each: parse `@Entity\s*\(?\s*(?:['"\`]([^'"\`]+)['"\`])?\)?\s*\n?.*?class\s+(\w+)` → entity name + optional table name
     - Parse relation decorators: `@(OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*(\w+)` → target entity
     - Build edges, call imported `detectCycles` from nest-tools.ts
     - Apply `max_entities` cap (default 200), set `truncated: true` if exceeded
     - **CQ8:** Wrap `readFile` in try/catch, append errors, no abort
- [ ] Verify: `npx vitest run tests/tools/nest-ext-tools.test.ts -t "nest_typeorm_map"`
  Expected: all TypeORM tests pass
- [ ] Acceptance: G12 — TypeORM entities + relation graph with cycle detection
- [ ] Commit: `feat: add nest_typeorm_map tool for entity relation graph (G12)`

### Task 14: G14 — nestMicroserviceMap tool
**Files:** `src/tools/nest-ext-tools.ts`, `tests/tools/nest-ext-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 13 (STRICT — same file)
**Execution routing:** default implementation tier

- [ ] RED: Add `describe("nest_microservice_map")` block. Fixture: write `src/orders/orders.controller.ts`:
  ```ts
  @Controller()
  export class OrdersController {
    @MessagePattern('create_order')
    handleCreateOrder(@Payload() data: CreateOrderDto) {}
    @EventPattern('order.shipped')
    handleOrderShipped(@Payload() data: OrderShippedEvent) {}
  }
  ```
  Assert:
  - `result.patterns.length === 2`
  - `{ type: "MessagePattern", pattern: "create_order", handler: "handleCreateOrder", controller: "OrdersController" }`
  - `{ type: "EventPattern", pattern: "order.shipped", handler: "handleOrderShipped" }`
  - **CQ6: truncation** — `max_patterns: 1`, expect `result.patterns.length === 1`, `result.truncated === true`
  - **CQ8: unreadable file** — missing file → `errors` array populated, no crash
- [ ] GREEN: In `nest-ext-tools.ts` add:
  1. `NestMicroserviceEntry`, `NestMicroserviceMapResult` types.
  2. Implement `nestMicroserviceMap(repo, options)`:
     - Scan `.controller.ts` files (hybrid apps expose microservice patterns in controllers)
     - Parse `@(MessagePattern|EventPattern)\s*\(\s*['"\`]([^'"\`]+)['"\`]\s*\)\s*\n\s*(?:async\s+)?(\w+)` → pattern entries
     - Apply `max_patterns` cap (default 300), set `truncated: true` if exceeded
     - **CQ8:** try/catch per file, errors appended, no abort
- [ ] Verify: `npx vitest run tests/tools/nest-ext-tools.test.ts -t "nest_microservice_map"`
  Expected: all microservice tests pass
- [ ] Acceptance: G14 — `@MessagePattern` and `@EventPattern` handlers indexed
- [ ] Commit: `feat: add nest_microservice_map tool for message/event pattern discovery (G14)`

### Task 15: Wire 5 new Wave 2 tools into nestAudit orchestrator
**Files:** `src/tools/nest-tools.ts` (nestAudit + NestAuditResult), `tests/tools/nest-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 10, 11, 12, 13, 14
**Execution routing:** deep implementation tier

- [ ] RED: Update existing `nest_audit` tests:
  1. Add `graphql_map`, `websocket_map`, `schedule_map`, `typeorm_map`, `microservice_map` to the full-run assertion.
  2. Add test: `nestAudit("test-repo", { checks: ["graphql"] })` returns only `graphql_map`, other sub-results undefined.
  3. Test partial failure: if one sub-tool throws, `summary.failed_checks >= 1` and other tools still produce results.
- [ ] GREEN: In `nest-tools.ts`:
  1. Extend `NestAuditResult` interface (line ~721) with optional fields: `graphql_map?: NestGraphQLMapResult`, `websocket_map?: NestGatewayMapResult`, `schedule_map?: NestScheduleMapResult`, `typeorm_map?: NestTypeOrmMapResult`, `microservice_map?: NestMicroserviceMapResult`.
  2. Extend `ALL_NEST_CHECKS` tuple (line 741): add `"graphql"`, `"websocket"`, `"schedule"`, `"typeorm"`, `"microservice"`.
  3. Add import for new tool functions from `./nest-ext-tools.js`.
  4. Add 5 new `tasks.push` blocks (modeled on existing `tasks.push(nestDIGraph(repo)...)`) in the parallel dispatch section.
  5. Add 5 new cases in the aggregation switch, populating the new fields and updating `summary.failed_checks` / `truncated_checks`.
- [ ] Verify: `npx vitest run tests/tools/nest-tools.test.ts -t "nest_audit"`
  Expected: all existing audit tests pass + new extended coverage tests
- [ ] Acceptance: nestAudit runs all 10 Wave 1+2 sub-tools (5 Wave 1: lifecycle, module, di, guard, route + 5 Wave 2: graphql, websocket, schedule, typeorm, microservice) in one call
- [ ] Commit: `feat: wire GraphQL, WebSocket, schedule, TypeORM, microservice tools into nest_audit`

### Task 16: Register 5 new Wave 2 tools in register-tools.ts
**Files:** `src/register-tools.ts`, `tests/tools/describe-tools.test.ts`, `tests/tools/framework-auto-enable.test.ts`
**Complexity:** standard
**Dependencies:** Task 15
**Execution routing:** default implementation tier

- [ ] RED:
  1. Update `tests/tools/framework-auto-enable.test.ts` line 35-44: expand expected array to **10 tools = 5 Wave 1 + 5 Wave 2** (exact names: `nest_lifecycle_map, nest_module_graph, nest_di_graph, nest_guard_chain, nest_route_inventory, nest_graphql_map, nest_websocket_map, nest_schedule_map, nest_typeorm_map, nest_microservice_map`). `nest_audit` is core so stays out of the bundle array.
  2. Update `tests/tools/describe-tools.test.ts`: dynamic baseline assertion — all 5 new nest_* tools discoverable via `discoverTools({ query: "nestjs" })`.
- [ ] GREEN: In `src/register-tools.ts`:
  1. Add import: `import { nestGraphQLMap, nestWebSocketMap, nestScheduleMap, nestTypeOrmMap, nestMicroserviceMap } from "./tools/nest-ext-tools.js";`
  2. Add **5** `ToolDefinition` entries following the pattern at line 1987-2053 — each with `category: "nestjs"`, searchHint with domain keywords, Zod schema, handler wrapping the corresponding function.
  3. Extend `FRAMEWORK_TOOL_BUNDLES["nestjs"]` array (line ~150) with the **5 new discoverable tool names** (total array length after = 10).
- [ ] Verify: `npx vitest run tests/tools/describe-tools.test.ts tests/tools/framework-auto-enable.test.ts`
  Expected: all tests pass, `FRAMEWORK_TOOL_BUNDLES["nestjs"]` has 10 entries
- [ ] Acceptance: 5 new Wave 2 tools discoverable via `discover_tools(query="nestjs")` and auto-enabled for NestJS projects
- [ ] Commit: `feat: register 5 Wave 2 NestJS tools (graphql, websocket, schedule, typeorm, microservice)`

### Task 17: Add Wave 2 anti-patterns to pattern-tools
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Add tests in `tests/tools/pattern-tools.test.ts` for 2 new patterns (dropped `nest-cron-overlapping` — cross-symbol duplication check cannot be expressed as a single regex; deferred to future work):
  1. `nest-graphql-no-auth`: resolver file containing `@Query()` or `@Mutation()` but no `@UseGuards(` in the same file → positive match. Negative: file has both → no match. Note: this is a same-file regex, not cross-symbol.
  2. `nest-eager-relation`: `@OneToMany(() => X, { eager: true })` → positive match; without eager → no match
- [ ] GREEN: In `pattern-tools.ts` `BUILTIN_PATTERNS` object, add 2 new entries with regex + description ending in `(NestJS)`.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts`
  Expected: 9 NestJS patterns total (7 Wave 1 + 2 Wave 2), all tests pass
- [ ] Acceptance: 2 Wave 2 anti-patterns added to `search_patterns` — automatically picked up by `nest_audit` pattern scanning
- [ ] Commit: `feat: add 2 Wave 2 NestJS anti-patterns (graphql-no-auth, eager-relation)`

### Task 18: Documentation updates and tool count bump
**Files:** `src/instructions.ts`, `CLAUDE.md`, `README.md`, `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`
**Complexity:** standard
**Dependencies:** Task 16
**Execution routing:** default implementation tier

- [ ] RED: Documentation task. Use existing grep-based verification from Task 12a of Wave 1 plan.
- [ ] GREEN:
  1. **Dynamic baseline** — at implementation time re-verify current count: `node -e "const src=require('fs').readFileSync('src/register-tools.ts','utf8'); const matches=[...new Set((src.match(/name:\\s*\"(\\w+)\"/g)||[]).map(m=>m.match(/\"(\\w+)\"/)[1]))]; console.log(matches.length)"`. At plan time this returned **88 unique tools**. Wave 2 adds **5 tools** → expected new count = **93 tools** (38 core + 55 discoverable, since `nest_audit` already core in Wave 1).
  2. Update `src/instructions.ts` line 5: `88 MCP tools (38 core, 50 hidden...)` → `93 MCP tools (38 core, 55 hidden...)`.
  3. Update `CLAUDE.md`: tool count from 88 → 93, `nest-ext-tools.ts` added to `src/tools/` file listing.
  4. Update `README.md`: tool count from 88 → 93, mention Wave 2 NestJS features in feature table.
  5. Update `rules/codesift.md`, `rules/codesift.mdc`, `rules/codex.md`, `rules/gemini.md`: tool mapping table add rows for nest_graphql_map, nest_websocket_map, nest_schedule_map, nest_typeorm_map, nest_microservice_map. Update tool count references from 88 → 93.
- [ ] Verify:
  1. `grep -rEn "\b88 (tools|MCP)\b|\b50 (hidden|discoverable)\b" src/ rules/ CLAUDE.md README.md 2>/dev/null | grep -v "docs/specs/"` returns zero matches.
  2. `grep -rEn "\b93 (tools|MCP)\b" src/instructions.ts CLAUDE.md README.md rules/codesift.md rules/codesift.mdc rules/codex.md rules/gemini.md` returns at least 7 matches (one per file).
  Expected: no stale `88`/`50` tool-count references; `93` present in every updated file
- [ ] Acceptance: Documentation consistent across repo with post-Wave-2 tool count (93)
- [ ] Commit: `docs: update tool count to 93 and document Wave 2 NestJS tools`
