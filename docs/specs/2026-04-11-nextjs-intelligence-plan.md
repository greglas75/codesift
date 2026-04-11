# Implementation Plan: Next.js Framework Intelligence

**Spec:** docs/specs/2026-04-11-nextjs-intelligence-spec.md
**spec_id:** 2026-04-11-nextjs-intelligence-2017
**planning_mode:** spec-driven
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 34
**Estimated complexity:** 8 complex / 26 standard across 5 PRs

## Architecture Summary

Five sequential PRs deliver hybrid-router Next.js intelligence:

- **PR #1 Foundation** — new `src/utils/nextjs.ts` shared helpers (directive scanner, workspace discovery, URL path normalizer, `computeLayoutChain`, `traceMiddleware`), symlink support in `walk.ts` with cycle detection, broadened `detectFrameworks`, extended `NextConventions` type
- **PR #2 search_patterns** — 6 new Next.js patterns + `fileExcludePattern` suppression field on `BUILTIN_PATTERNS`
- **PR #3 trace_route** — `.tsx`/`.jsx` matching, Pages Router handler finder, middleware/layout/server-action tracing, extended `RouteTraceResult`
- **PR #4 analyze_nextjs_components** — new tool at `src/tools/nextjs-component-tools.ts` (AST-based classifier, two-stage directive detection, 9-stage data flow)
- **PR #5 nextjs_route_map** — new tool at `src/tools/nextjs-route-tools.ts` (route enumeration with rendering strategy classification, hybrid conflict detection)

Dependency graph: PR #1 blocks all; PR #2/3/4 are independent; PR #5 depends on PR #4 (shared `nextjs-tools.ts` barrel file).

## Technical Decisions

- **Tree-sitter pattern**: programmatic visitor via `descendantsOfType()` (not query language) — matches existing codebase convention in `typescript.ts`, `ast-query-tools.ts`
- **Concurrency**: inline `for + slice + Promise.all` batching (concurrency=10) — matches `index-tools.ts` `PARSE_CONCURRENCY` pattern; no new `p-limit` dependency
- **File I/O**: `node:fs/promises` `readFile` async — consistent with 100% of existing async reads
- **File split**: `nextjs-tools.ts` → `nextjs-component-tools.ts` (PR #4) + `nextjs-route-tools.ts` (PR #5). Barrel `nextjs-tools.ts` re-exports both. Prevents 300-line CQ11 overflow
- **No new npm dependencies** — all needs covered by `web-tree-sitter`, `picomatch`, `chokidar`, `node:fs`, existing tooling
- **`is_client_component` on route entries**: use `scanDirective()` only (Q1 decision) — no full AST for route map entries
- **Shared helpers** (`computeLayoutChain`, `traceMiddleware`): live in `src/utils/nextjs.ts` (Q2 decision) — single source of truth, tested in isolation
- **Pattern suppression**: extend `BUILTIN_PATTERNS` entry shape with optional `fileExcludePattern?: RegExp` (A1 decision) — typed, extensible, cleaner than hardcoded path check
- **Route-tools helper exports**: named exports with `@internal` JSDoc comment (A2 decision) — allows direct unit testing without mocking the whole `traceRoute` pipeline
- **Test pool**: `nextjs-component-tools.test.ts` and `nextjs-route-tools.test.ts` placed in `tests/parser/` (parser pool, WASM-enabled, 30s timeout)
- **Function signature for scripts**: `analyzeNextjsComponents(repo, options)` resolves repo root internally via `getCodeIndex(repo).root`; validation scripts call the tool directly with repo name of their fixture directory

## Quality Strategy

**At-risk CQ gates**: CQ8 (error handling on file reads + tree-sitter exceptions), CQ11 (file size — mitigated by file split), CQ14 (duplication — mitigated by `utils/nextjs.ts` consolidation), CQ17 (async batching performance), CQ25 (pattern consistency for registration + testing).

**Critical test gates (Q7, Q11, Q17)**: every error path tested with error injection (not filesystem permissions); all branches of `middleware_applies` (literal-match true, literal-match false, computed fail-open) covered; `expected.json` written BEFORE implementation to prevent input-echo anti-pattern.

**Ship-level gates**:
- Fixture invariant: `parse_failures.length === 0` asserted in a dedicated test
- Non-Next.js app/ false-positive regression test in PR #1 (TanStack Router, SvelteKit, Nuxt fixtures)
- Three-branch `middleware_applies` test in PR #3
- SC1 accuracy script (`scripts/validate-nextjs-accuracy.ts`) in PR #4
- SC2 route count validator (`scripts/validate-nextjs-route-count.ts`) in PR #5
- SC3/SC4 benchmark (`scripts/benchmark-nextjs-tools.ts`) in PR #4

---

## Task Breakdown

### PR #1 — Foundation (Tasks 1-9)

### Task 1: Add `scanDirective` helper to new `src/utils/nextjs.ts`

**Files:** `src/utils/nextjs.ts` (NEW), `tests/utils/nextjs.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: In `tests/utils/nextjs.test.ts`, write 8 test cases for `scanDirective(filePath)`:
  - plain `"use client"` at top → returns `"use client"`
  - plain `"use server"` at top → returns `"use server"`
  - file with BOM prefix + `"use client"` → returns `"use client"`
  - file with `/* copyright */\n"use client"` multi-line docblock → returns `"use client"`
  - file with `// line comment\n"use client"` → returns `"use client"`
  - file with shebang `#!/...\n"use client"` → returns `"use client"`
  - file with NO directive → returns `null`
  - file with directive past 600-byte offset → returns `null` (documented limitation)
  Use `createFixture()` pattern from `tests/tools/project-tools.test.ts`. Assertions use exact string equality via `toBe`.
- [ ] GREEN: Implement `export async function scanDirective(filePath: string): Promise<"use client" | "use server" | null>` in `src/utils/nextjs.ts`:
  - Read first 512 bytes via `readFile(filePath, { encoding: "utf8", flag: "r" })` then `.slice(0, 512)`
  - Wrap in try/catch — return `null` on any read error
  - Strip BOM (`\uFEFF`)
  - Strip leading `/* ... */` blocks and `// ...` line comments (helper `stripBomAndComments`, internal, ≤20 lines)
  - Match regex `/^\s*["'\`](use (?:client|server))["'\`]\s*;?/` on stripped content
  - Return `"use client"` | `"use server"` | `null`
  - Exported constant `DIRECTIVE_WINDOW = 512`
- [ ] Verify: `npx vitest run tests/utils/nextjs.test.ts -t scanDirective`
  Expected: `Tests 8 passed (8)`
- [ ] Acceptance: Spec AC3 (foundation directive scanner — 8 fixture cases)
- [ ] Commit: `feat(utils): add scanDirective with 512-byte window and comment stripping`

---

### Task 2: Add `deriveUrlPath` route path normalizer to `src/utils/nextjs.ts`

**Files:** `src/utils/nextjs.ts`, `tests/utils/nextjs.test.ts`
**Complexity:** standard
**Dependencies:** Task 1 (must run sequentially — both tasks edit `src/utils/nextjs.ts`)
**Execution routing:** default

- [ ] RED: Add 6 test cases for `deriveUrlPath(filePath, router)`:
  - `"app/page.tsx"`, `"app"` → `"/"`
  - `"app/(auth)/login/page.tsx"`, `"app"` → `"/login"` (route group stripped)
  - `"app/products/[id]/page.tsx"`, `"app"` → `"/products/[id]"` (dynamic preserved)
  - `"app/blog/[...slug]/page.tsx"`, `"app"` → `"/blog/[...slug]"` (catch-all preserved)
  - `"pages/api/users.ts"`, `"pages"` → `"/api/users"`
  - `"src/app/page.tsx"`, `"app"` → `"/"` (src/ prefix stripped)
- [ ] GREEN: Implement `export function deriveUrlPath(filePath: string, router: "app" | "pages"): string`:
  - Strip leading `src/` if present
  - If `router === "app"`: strip `app/`, strip trailing `/(page|layout|route|...)\.[jt]sx?$`, strip `(groupName)/` occurrences
  - If `router === "pages"`: strip `pages/`, strip `.{tsx,jsx,ts,js}` extension
  - Prepend `/` if result is not empty, else return `/`
  - Pure function, ≤30 lines
- [ ] Verify: `npx vitest run tests/utils/nextjs.test.ts -t deriveUrlPath`
  Expected: `Tests 6 passed (6)`
- [ ] Acceptance: Spec AC26 (route group stripped), AC27 (parallel/intercepting route types — partial, completed in Task 3)
- [ ] Commit: `feat(utils): add deriveUrlPath for App Router and Pages Router URL normalization`

---

### Task 3: Add `discoverWorkspaces` monorepo helper

**Files:** `src/utils/nextjs.ts`, `tests/utils/nextjs.test.ts`
**Complexity:** standard
**Dependencies:** Task 2 (sequential — shares `src/utils/nextjs.ts`)
**Execution routing:** default

- [ ] RED: Add 4 test cases for `discoverWorkspaces(repoRoot)`:
  - Repo with single `next.config.ts` at root → returns `[]` (single-app fallback, not a monorepo)
  - Repo with 2 configs at `apps/web/next.config.ts` + `apps/admin/next.config.js` → returns 2 entries
  - Repo with 1 config at `apps/web/` (only one) → returns 1 entry
  - Repo with no `next.config.*` → returns `[]`
  Use `createFixture()` to build tmpdir fixtures.
- [ ] GREEN: Implement `export async function discoverWorkspaces(repoRoot: string): Promise<{ root: string; configFile: string }[]>`:
  - Use `readdir` with depth limit 3 to find files matching `/^next\.config\.(js|mjs|cjs|ts)$/`
  - Collect directory of each match as workspace root
  - If only 1 config found AND it's at repoRoot, return `[]` (single-app; no auto-detect needed)
  - If ≥1 config found NOT at root, return all entries
  - Return `[]` if no configs
  - Skip `node_modules`, `.git`, `dist` directories
  - ≤40 lines
- [ ] Verify: `npx vitest run tests/utils/nextjs.test.ts -t discoverWorkspaces`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Spec AC22 (monorepo auto-detect with ≥2 configs)
- [ ] Commit: `feat(utils): add discoverWorkspaces for monorepo Next.js detection`

---

### Task 4: Add `followSymlinks` option with cycle detection to `walk.ts`

**Files:** `src/utils/walk.ts`, `tests/utils/walk.test.ts` (extend existing or create)
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep

- [ ] RED: Write 3 test cases:
  - `walkDirectory(root, { followSymlinks: true })` on fixture with `a -> b` symlink → walks both
  - Circular symlink `a -> b -> a` → terminates, logs warning in result (no infinite loop)
  - Symlink to missing target → skipped silently (no error thrown)
  Assertions use `expect(files).toContain(...)` for positive cases, `expect(Promise).resolves` for termination. Use `fs.symlinkSync` in fixture setup; wrap in `describe.skipIf(process.platform === "win32")` for Windows CI compatibility.
- [ ] GREEN: Modify `WalkOptions` interface to add `followSymlinks?: boolean` (default false). In `walkDirectory`:
  - Maintain a `visitedInodes: Set<number>` passed through recursive calls
  - When encountering a symlink, use `fs.stat()` to resolve target + get inode via `stat.ino`
  - If inode already in set, log warning and skip (cycle detected)
  - If `followSymlinks === false`, skip symlinks as before
  - If target is missing, catch ENOENT and skip silently
  - Only touch the symlink-handling branch; preserve existing walk behavior for non-symlink files
- [ ] Verify: `npx vitest run tests/utils/walk.test.ts -t symlink`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Spec AC4 (walk.ts follows symlinks without infinite loop) + FM4 mitigation
- [ ] Commit: `feat(utils): add followSymlinks to walkDirectory with cycle detection`

---

### Task 5: Broaden `detectFrameworks` to fire on `pages/`, `next.config.*`, or App Router conventions

**Files:** `src/utils/framework-detect.ts`, `tests/utils/framework-detect.test.ts` (extend/create)
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep

- [ ] RED: Write 7 test cases using `mockIndex()`:
  - Project with only `pages/index.tsx` → `detectFrameworks` returns set containing `"nextjs"`
  - Project with only `app/page.tsx` + `app/layout.tsx` → returns `"nextjs"`
  - Project with only `next.config.ts` at root → returns `"nextjs"`
  - **False positive regression**: TanStack Router fixture — `app/routes/__root.tsx`, `app/routes/index.tsx`, NO `next.config.*`, NO `pages/`, NO Next.js convention files → does NOT return `"nextjs"`
  - **False positive regression**: SvelteKit — `src/routes/+page.svelte` → no `"nextjs"`
  - Existing: App Router with API route `app/api/users/route.ts` → returns `"nextjs"` (regression)
  - Non-Next.js: NestJS project with `@nestjs/` imports → returns `"nestjs"`, not `"nextjs"`
- [ ] GREEN: Rewrite the `nextjs` detection branch in `detectFrameworks()`:
  - Check 1: Any file matches `/^(src\/)?next\.config\.[mc]?[jt]sx?$/` → true
  - Check 2: Any file matches `NEXT_PAGES_FILE` regex AND path has a concrete `.tsx`/`.ts`/`.jsx`/`.js` extension → true
  - Check 3: Any file matches `/(^|\/)app\/.*\/(page|layout|loading|error|not-found|global-error|default|template|route)\.[jt]sx?$/` → true
  - Add `frameworks.add("nextjs")` if any check passes
  - Export 3 new regex constants: `NEXT_CONFIG_FILE`, `NEXT_APP_CONVENTION_FILE`, `NEXT_PAGES_FILE` (if not already exported)
- [ ] Verify: `npx vitest run tests/utils/framework-detect.test.ts`
  Expected: `Tests 7 passed (7)` including all 7 new cases; all existing tests pass
- [ ] Acceptance: Spec AC1 (detectFrameworks fires on projects with next.config.* OR app/ convention files OR pages/) + Spec AC5 (full suite regression — run `npx vitest run` after this change, no regressions in find_dead_code/analyze_project/trace_route) + false-positive regression (QA-4)
- [ ] Commit: `fix(framework-detect): broaden nextjs detection and prevent false positives`

---

### Task 6: Extend `NextConventions` type and `extractNextConventions` to use shared scanDirective

**Files:** `src/tools/project-tools.ts`, `tests/tools/project-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 1, Task 5
**Execution routing:** default

- [ ] RED: Add 3 test cases in `project-tools.test.ts`:
  - Fixture with `pages/index.tsx` → `conventions.config.pages_router === true`, `config.app_router === false`
  - Fixture with both `app/page.tsx` AND `pages/_app.tsx` → both flags true (hybrid)
  - Fixture with `pages/_app.tsx`, `pages/_document.tsx`, `pages/_error.tsx` → each appears in `conventions.pages[]` with `type` of `"app"`, `"document"`, `"error_page"` respectively
- [ ] GREEN: In `src/tools/project-tools.ts`:
  - Add `pages_router: boolean` to `NextConventions.config`
  - Add `"app" | "document" | "error_page"` to `NextConventions.pages[].type` enum (already done via quick wins but verify: also extend enum in `extractNextConventions` page-type detection)
  - Add detection: `_app.tsx` → `type: "app"`, `_document.tsx` → `type: "document"`, `_error.tsx` → `type: "error_page"`
  - Replace current inline 80-byte directive scan loop (lines ~1075-1083) with `await scanDirective(...)` imported from `../utils/nextjs.ts`
  - Populate `config.pages_router = files.some(f => /(^|\/)pages\/.*\.[jt]sx?$/.test(f.path))`
  - Ensure `extractNextConventions` is now `async` (change signature); update the call site in `analyzeProject` to `await`
- [ ] Verify: `npx vitest run tests/tools/project-tools.test.ts -t NextConventions`
  Expected: `Tests 3 passed (3)` plus no regressions in existing project-tools tests
- [ ] Acceptance: Spec AC2 (pages_router flag), Spec §Data Model (Pages Router types in NextConventions)
- [ ] Commit: `feat(project-tools): add pages_router flag and Pages Router special file types`

---

### Task 7: Add `computeLayoutChain` helper to `src/utils/nextjs.ts`

**Files:** `src/utils/nextjs.ts`, `tests/utils/nextjs.test.ts`
**Complexity:** standard
**Dependencies:** Task 3 (sequential — shares `src/utils/nextjs.ts`)
**Execution routing:** default

- [ ] RED: Add 4 test cases:
  - Fixture with `app/layout.tsx` + `app/products/layout.tsx` + `app/products/[id]/page.tsx` — chain for `app/products/[id]/page.tsx` is `["app/layout.tsx", "app/products/layout.tsx"]`
  - Fixture with no layouts — chain is `[]`
  - Fixture with root layout only — chain is `["app/layout.tsx"]`
  - Target file that is itself a layout — chain includes ancestor layouts only, not self
- [ ] GREEN: Implement `export async function computeLayoutChain(filePath: string, repoRoot: string): Promise<string[]>`:
  - Parse `filePath` (relative to `repoRoot`) into segments
  - Walk up ancestor directories; for each, check if `layout.tsx`/`layout.jsx`/`layout.ts`/`layout.js` exists via `fs.access()`
  - Collect in order from root to leaf
  - Stop walking when path leaves `app/` directory
  - Return relative paths from `repoRoot`
  - ≤40 lines
- [ ] Verify: `npx vitest run tests/utils/nextjs.test.ts -t computeLayoutChain`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Spec AC10 (trace_route returns layout_chain)
- [ ] Commit: `feat(utils): add computeLayoutChain walker for App Router layout hierarchy`

---

### Task 8: Add `traceMiddleware` helper to `src/utils/nextjs.ts`

**Files:** `src/utils/nextjs.ts`, `tests/utils/nextjs.test.ts`
**Complexity:** complex
**Dependencies:** Task 7 (sequential — shares `src/utils/nextjs.ts`)
**Execution routing:** deep

- [ ] RED: Add 5 test cases covering ALL 4 branches of `middleware.applies` plus the not-found case:
  - Literal matcher matches path: `middleware.ts` with `export const config = { matcher: "/api/:path*" }`, path `"/api/users"` → `{ applies: true }`
  - Literal matcher array, none match: `matcher: ["/admin/:path*"]`, path `"/api/users"` → `{ applies: false }`
  - Computed matcher (Identifier in AST): `matcher: computedVal` → `{ applies: true }` (fail-open), `matchers: ["<computed>"]`
  - `middleware.ts` exists BUT has no `config` export at all (only `export function middleware(req)`) → `{ matchers: [], applies: true }` (fail-open per Next.js default: no matcher = all routes)
  - No `middleware.ts` exists → returns `null`
  Use tree-sitter parsing in the test fixture. Test file must be placed in `tests/parser/` pool to have WASM access.
- [ ] GREEN: Implement `export async function traceMiddleware(repoRoot: string, urlPath: string): Promise<{ file: string; matchers: string[]; applies: boolean } | null>`:
  - Check for `middleware.ts`/`middleware.js`/`src/middleware.ts`/`src/middleware.js`
  - Return `null` if not found
  - Use existing `parseFile` from parser-manager.ts to parse the middleware file
  - Walk AST to find `export const config = { ... }` and extract `matcher` field
  - If `matcher` is string literal → `matchers = [value]`, `applies = matchesMatcher([value], urlPath)`
  - If `matcher` is array of string literals → extract each, `applies = any literal matches urlPath`
  - If `matcher` is Identifier/computed → `matchers = ["<computed>"]`, `applies = true` (fail-open)
  - If no `config` export → `matchers = []`, `applies = true` (fail-open per Next.js default)
  - Internal helper `matchesMatcher(patterns: string[], urlPath: string): boolean` uses `picomatch` for glob matching
  - ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs.test.ts -t traceMiddleware` (or wherever WASM tests land)
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Spec AC11 (three branches of middleware.applies) — all three branches covered by explicit fixtures
- [ ] Commit: `feat(utils): add traceMiddleware with literal and fail-open matcher support`

---

### Task 9: Create App Router test fixture for downstream PRs

**Files:** `tests/fixtures/nextjs-app-router/` (NEW, 20+ files), `tests/fixtures/nextjs-app-router/README.md`
**Complexity:** standard
**Dependencies:** none (can run in parallel with other PR #1 tasks)
**Execution routing:** default

- [ ] RED: Write test `it("fixture invariant: all App Router fixture files have valid structure", ...)` in `tests/tools/fixtures.test.ts` that: walks `tests/fixtures/nextjs-app-router/`, asserts at least 20 files exist, asserts each `.tsx` file has valid JSX (parseable by tree-sitter without error). Initial run will fail (fixture doesn't exist).
- [ ] GREEN: Create fixture directory with these files (minimal content per spec §Validation Methodology):
  - `app/layout.tsx` (root layout, server component)
  - `app/page.tsx` (home, server)
  - `app/(auth)/login/page.tsx` (route group, server)
  - `app/(auth)/layout.tsx` (nested layout, server)
  - `app/products/[id]/page.tsx` (dynamic route, server)
  - `app/products/[id]/layout.tsx` (nested layout, server)
  - `app/products/loading.tsx` (client by convention)
  - `app/products/error.tsx` (must be client, has `"use client"`)
  - `app/not-found.tsx` (server)
  - `app/global-error.tsx` (client, `"use client"`)
  - `app/@modal/page.tsx` (parallel route)
  - `app/default.tsx` (parallel fallback)
  - `app/template.tsx` (template)
  - `app/api/users/route.ts` (GET + POST exports)
  - `app/components/ClientButton.tsx` (`"use client"`, uses `useState`)
  - `app/components/ServerComponent.tsx` (server, no signals)
  - `app/components/UnnecessaryClient.tsx` (`"use client"` but no hooks/events — unnecessary_use_client case)
  - `app/components/AsyncClient.tsx` (`"use client"` + async function — violation)
  - `app/components/DynamicImport.tsx` (uses `next/dynamic({ ssr: false })`)
  - `app/components/WithHooks.tsx` (no directive but uses `useState` — client_inferred)
  - `app/components/WithDocblock.tsx` (long docblock + `"use client"` within 512 bytes — should be detected)
  - `middleware.ts` (literal matcher: `matcher: ["/api/:path*"]`)
  - `next.config.ts`
  - `README.md` — document that `expected.json` is frozen ground truth; maintained by Task 25 (PR #4)
- [ ] Verify: `npx vitest run tests/tools/fixtures.test.ts`
  Expected: `Tests 1 passed (1)` — fixture structure valid
- [ ] Acceptance: Spec §Validation Methodology (App Router fixture with 20+ files)
- [ ] Commit: `test(fixtures): add App Router fixture with 20+ convention files`

---

### PR #2 — search_patterns Extension (Tasks 10-12)

### Task 10: Extend `BUILTIN_PATTERNS` shape with `fileExcludePattern` field

**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** PR #1 merged
**Execution routing:** default

- [ ] RED: Write test `"nextjs-wrong-router suppressed on pages/ files"`: fixture file `pages/index.tsx` containing `import { useRouter } from "next/router"`, run `searchPatterns(repo, "nextjs-wrong-router")`, assert `result.matches.length === 0`. Also test `app/page.tsx` with same import still matches (1 match). Assertion: `expect(matches).toHaveLength(0)` and `expect(appMatches).toHaveLength(1)`.
- [ ] GREEN: Modify `BUILTIN_PATTERNS` type to add optional `fileExcludePattern?: RegExp`:
  ```typescript
  const BUILTIN_PATTERNS: Record<string, { regex: RegExp; description: string; fileExcludePattern?: RegExp }> = { ... }
  ```
  In `searchPatterns()`, before running the regex against a symbol, check if symbol's `file` matches the pattern's `fileExcludePattern` — if yes, skip that symbol. Add `fileExcludePattern: /(^|\/)pages\//` to the existing `nextjs-wrong-router` entry.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "wrong-router"`
  Expected: `Tests 2 passed` (suppress case + non-suppress case)
- [ ] Acceptance: Spec AC7 (nextjs-wrong-router suppressed on Pages Router files)
- [ ] Commit: `feat(patterns): add fileExcludePattern field for router-type-aware suppression`

---

### Task 11: Add 6 new Next.js anti-pattern regexes

**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 10
**Execution routing:** default

- [ ] RED: For each of the 6 new patterns, write positive + negative test cases (12 tests total):
  1. `nextjs-fetch-waterfall` — positive: async function with `await fetch('/a')` then `await fetch('/b')` within 300 chars; negative: single `await fetch` or sequential with dependency
  2. `nextjs-missing-metadata` — positive: `app/somewhere/page.tsx` without `metadata` / `generateMetadata` export; negative: page.tsx with `export const metadata = {...}`
  3. `nextjs-unnecessary-use-client` — positive: file starts with `"use client"` but no hooks/events; negative: file with `"use client"` + `useState`
  4. `nextjs-pages-in-app` — positive: `app/index.tsx` (Pages Router convention inside `app/`); negative: `app/page.tsx`
  5. `nextjs-missing-error-boundary` — positive: directory with `page.tsx` but no sibling `error.tsx`; negative: directory with both
  6. `nextjs-use-client-in-layout` — positive: `app/layout.tsx` starting with `"use client"`; negative: `app/layout.tsx` without directive
- [ ] GREEN: Add 6 entries to `BUILTIN_PATTERNS`:
  - `"nextjs-fetch-waterfall"`: regex `/await\s+fetch\s*\([^)]*\)[\s\S]{0,300}await\s+fetch\s*\(/` (symbol-scope, can be file_pattern-limited by caller)
  - `"nextjs-missing-metadata"`: regex at file-scope; leveraging existing symbol-source scan — match files whose path includes `app/` + `/page.` AND whose source lacks `export (const|function|async function)\s+(metadata|generateMetadata)` (use negative lookahead or combined pattern; alternatively implement as a file-scope helper if regex is insufficient; accept that regex-only may have edge cases and document)
  - `"nextjs-unnecessary-use-client"`: regex matching files starting with `"use client"` but lacking `useState|useEffect|useRef|useCallback|useMemo|useContext|useReducer|onClick|onChange|onSubmit|window\.|document\.|localStorage\.`  (complex; may need helper)
  - `"nextjs-pages-in-app"`: regex `/(^|\/)app\/[^/]*\/index\.(tsx|jsx|ts|js)$/` matching file PATH (requires file-scope matching — use `fileExcludePattern` inverse, or a `fileIncludePattern` field)
  - `"nextjs-missing-error-boundary"`: file-scope — match `app/**/page.tsx` files whose sibling `error.tsx` does not exist (requires file-system check — may be deferred to a helper or accepted as v1 limitation)
  - `"nextjs-use-client-in-layout"`: regex matching files named `layout.tsx`/`layout.ts` with `"use client"` in first 512 bytes — combine source regex `/^[\s\S]{0,512}["'\`]use client["'\`]/` with `fileIncludePattern: /(^|\/)app\/.*\/layout\.[jt]sx?$/`
  Some patterns need a new optional `fileIncludePattern?: RegExp` field mirroring `fileExcludePattern`. Add it if needed.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t "nextjs-"`
  Expected: `Tests 12 passed (12)` (6 positive + 6 negative)
- [ ] Acceptance: Spec AC6 (each of 6 new patterns returns ≥1 positive and 0 negative)
- [ ] Commit: `feat(patterns): add 6 Next.js anti-pattern detectors`

---

### Task 12: Verify `listPatterns` includes new patterns AND suppress filter works correctly

**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 11
**Execution routing:** default

- [ ] RED: Write 2 test cases that DRIVE implementation changes:
  1. `listPatterns()` returns entries with a new `fileExcludePattern` field populated (as string/serialized form) when present — e.g., the `nextjs-wrong-router` entry must expose its exclude pattern in the listing output so agents know which files are suppressed. This test FAILS initially because `listPatterns()` currently returns only `{ name, description }`, not the new field.
  2. Full suite regression check: `listPatterns()` length equals previous count + 6. This guards against accidentally breaking existing 35+ patterns. Test FAILS if Task 11 somehow broke an existing entry during edit.
- [ ] GREEN: Modify `listPatterns()` to include the new `fileExcludePattern` / `fileIncludePattern` fields (serialized as `.source` strings) in its output. Update the return type. Verify existing tests still pass with the new fields present (backward-compatible additive change).
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t listPatterns`
  Expected: `Tests 2 passed (2)`
- [ ] Acceptance: Spec AC8 (new pattern descriptions surface in listPatterns output), Spec AC9 (no regressions in existing patterns)
- [ ] Commit: `feat(patterns): surface fileExcludePattern in listPatterns output`

---

### PR #3 — trace_route Extension (Tasks 13-18)

### Task 13: Fix `findNextJSHandlers` to match `.tsx`/`.jsx` route files

**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** PR #1 merged
**Execution routing:** default

- [ ] RED: Write test for `trace_route` on a fixture with `app/api/upload/route.tsx` exporting `POST`: expect handler found. Also test existing `route.ts` case (regression). Note this is the first test in a new `tests/tools/route-tools.test.ts` file — create the file and use `createFixture()` + `mockIndex()` pattern. Assertion: `expect(result.handlers).toHaveLength(1)` and `expect(result.handlers[0].symbol.name).toBe("POST")`.
- [ ] GREEN: In `findNextJSHandlers` in `src/tools/route-tools.ts`, change file suffix check from `endsWith("/route.ts") || endsWith("/route.js")` to include `.tsx` and `.jsx` variants. Change regex from `/route\.\w+$/` pattern to `/route\.[jt]sx?$/`.
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts -t tsx`
  Expected: `Tests 1 passed (1)`, existing trace_route tests in `tools.test.ts` also pass
- [ ] Acceptance: Spec AC14 (`.tsx` route files matched by trace_route)
- [ ] Commit: `fix(route-tools): match .tsx and .jsx route files in findNextJSHandlers`

---

### Task 14: Add `findPagesRouterHandlers` for Pages Router API routes

**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 13
**Execution routing:** deep

- [ ] RED: Write 3 test cases:
  - Fixture with `pages/api/users.ts` exporting default function `handler` — `trace_route("/api/users")` returns handler with `router: "pages"`
  - Fixture with BOTH `pages/api/users.ts` AND `app/api/users/route.ts` — returns BOTH handlers, each tagged with `router: "pages"` and `router: "app"` respectively
  - Fixture with `pages/api/exotic.ts` with `const h = (req,res) => {...}; export default h;` (variable indirection) — resolves to the variable initializer, handler found
- [ ] GREEN: Add optional field `router?: "app" | "pages"` to `RouteHandler` interface. Implement internal function `findPagesRouterHandlers(index: CodeIndex, searchPath: string): RouteHandler[]`:
  - Match files under `pages/api/`
  - Derive URL path: strip `pages/api/` → prepend `/api/` (or use `deriveUrlPath(file.path, "pages")`)
  - Compare derived path against `searchPath`
  - Find default-exported symbol in the file (look for symbol with `name === "default"` or an `export default` adjacent to a function)
  - Push handler with `framework: "nextjs"`, `router: "pages"`
  - One-level variable-indirection resolution: if default export is a variable, find the variable's initializer (if it's an identifier referring to a function, use that symbol)
  - Export as `/** @internal exported for unit testing */` per A2 decision
  - Add to the `handlers` array in `traceRoute()` alongside existing `findNextJSHandlers()`
  - Also add `router: "app"` to existing App Router handlers in `findNextJSHandlers`
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts -t PagesRouter`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Spec AC13 (Pages Router trace returns handler with `router: "pages"`; hybrid returns both)
- [ ] Commit: `feat(route-tools): add Pages Router handler detection with router disambiguation`

---

### Task 15: Integrate `computeLayoutChain` and `traceMiddleware` into `traceRoute`

**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 13, Task 14, PR #1 Task 7 + 8
**Execution routing:** deep

- [ ] RED: Write 4 test cases:
  - Route at `app/products/[id]/page.tsx` with ancestor layouts → `result.layout_chain === ["app/layout.tsx", "app/products/layout.tsx"]`
  - Route with NO ancestor layouts → `result.layout_chain === []`
  - Route with middleware.ts literal matcher matching path → `result.middleware.applies === true`, `result.middleware.matchers === ["/api/:path*"]`
  - Route with middleware.ts but matcher does NOT cover path → `result.middleware.applies === false`
- [ ] GREEN: In `traceRoute()`:
  - Import `computeLayoutChain` and `traceMiddleware` from `src/utils/nextjs.ts`
  - After handler resolution, for the first handler's file, compute `layout_chain` via `computeLayoutChain(handler.file, repoRoot)`
  - Compute `middleware` via `traceMiddleware(repoRoot, path)`
  - Assign both to `RouteTraceResult` (new optional fields)
  - Extend `RouteTraceResult` interface with `middleware?`, `layout_chain?`, `server_actions?` (all optional)
  - Only populate these fields when handlers are found AND at least one has `framework: "nextjs"` — skip for non-Next.js routes
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts -t "layout_chain|middleware"`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Spec AC10 (layout_chain), AC11 (middleware.applies three branches)
- [ ] Commit: `feat(route-tools): integrate layout chain and middleware tracing into traceRoute`

---

### Task 16: Add `findServerActions` to detect `"use server"` functions in route call chains

**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools.test.ts`, `src/utils/nextjs.ts`
**Complexity:** complex
**Dependencies:** Task 15
**Execution routing:** deep

- [ ] RED: Write 3 test cases:
  - Fixture: `app/actions/updateUser.ts` has file-scope `"use server"` + exported `updateUser` function; `app/users/page.tsx` calls `updateUser` — `trace_route("/users")` returns `server_actions: [{ name: "updateUser", file: "app/actions/updateUser.ts", called_from: "..." }]`
  - Fixture with no server actions → `server_actions: []`
  - Fixture with function body containing `"use server"` directive inside (not file-level) — NOT detected (documented limitation), `server_actions: []`
- [ ] GREEN: Implement `findServerActions(repoRoot, handlers, callChain, adjacency)` in `route-tools.ts`:
  - For each symbol in the call chain, check the symbol's file via `scanDirective()`
  - If file has `"use server"` directive, treat all exported functions in that file as server actions
  - Collect `{ name, file, called_from }` tuples
  - `called_from` = the symbol in the call chain that invoked this server action
  - Populate `RouteTraceResult.server_actions` field
  - Use `scanDirective` for detection (file-level only, not nested — documented EC limitation)
- [ ] Verify: `npx vitest run tests/tools/route-tools.test.ts -t server_actions`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Spec AC12 (server actions tagged when route calls `"use server"` function)
- [ ] Commit: `feat(route-tools): detect server actions in route call chains`

---

### Task 17: Extend `formatTraceRoute` to render middleware/layout/server-actions

**Files:** `src/formatters.ts`, `tests/formatters/route-formatter.test.ts` (create/extend)
**Complexity:** standard
**Dependencies:** Task 15, Task 16
**Execution routing:** default

- [ ] RED: Test that `formatTraceRoute(result)` on a sample `RouteTraceResult` with middleware + layout_chain + server_actions outputs:
  - String contains `"Middleware: middleware.ts (applies)"`
  - String contains `"Layout chain: app/layout.tsx → app/products/layout.tsx"`
  - String contains `"Server Actions: updateUser (app/actions/updateUser.ts)"`
  Assertion uses `expect(output).toMatch(/Middleware:/)` etc.
- [ ] GREEN: In `formatTraceRoute()`, detect if `result.middleware`, `result.layout_chain`, or `result.server_actions` are present; if yes, render each in its own section after the handler list. Preserve existing format for routes without these fields.
- [ ] Verify: `npx vitest run tests/formatters/ -t formatTraceRoute`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: Spec AC15 (Mermaid output includes middleware actor and layout nodes — partial, Mermaid in next task)
- [ ] Commit: `feat(formatters): render middleware, layout chain, and server actions in trace output`

---

### Task 18: Extend `routeToMermaid` to include middleware actor and layouts

**Files:** `src/formatters.ts`, `tests/formatters/route-formatter.test.ts`
**Complexity:** standard
**Dependencies:** Task 17
**Execution routing:** default

- [ ] RED: Test that `routeToMermaid(result)` on a sample result with middleware + layout_chain outputs a string containing `"participant Middleware"` and a sequence line `"Client->>+Middleware"`. Also test that a result WITHOUT middleware does NOT add the Middleware actor (regression).
- [ ] GREEN: In `routeToMermaid()`, if `result.middleware?.applies === true`, add Middleware as first actor after Client and add a sequence `Client->>+Middleware: request → Middleware->>+Controller: continue`. For `layout_chain`, add a sequence `Controller->>+Layout1: render → Layout1->>+Layout2: render` etc. Preserve existing Mermaid structure otherwise.
- [ ] Verify: `npx vitest run tests/formatters/ -t routeToMermaid`
  Expected: `Tests 2 passed (2)` (with middleware, without middleware)
- [ ] Acceptance: Spec AC15 (Mermaid includes middleware actor and layout chain nodes)
- [ ] Commit: `feat(formatters): add middleware actor and layout nodes to routeToMermaid`

---

### PR #4 — analyze_nextjs_components (Tasks 19-25)

### Task 19: Define types and create `src/tools/nextjs-component-tools.ts` skeleton

**Files:** `src/tools/nextjs-component-tools.ts` (NEW), `src/tools/nextjs-tools.ts` (NEW barrel), `tests/parser/nextjs-component-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** PR #1 merged
**Execution routing:** default

- [ ] RED: Write skeleton test `it("exports analyzeNextjsComponents function", () => expect(typeof analyzeNextjsComponents).toBe("function"))`. The test file is in `tests/parser/` (WASM pool). Initial run fails — module doesn't exist.
- [ ] GREEN: Create `src/tools/nextjs-component-tools.ts`:
  - Export types: `ComponentClassification`, `NextjsComponentEntry`, `NextjsComponentsResult` (per spec §Data Model)
  - Export stub: `export async function analyzeNextjsComponents(repo: string, options?: {...}): Promise<NextjsComponentsResult>` — implementation throws `new Error("not implemented")` for now
  - Create `src/tools/nextjs-tools.ts` barrel: `export * from "./nextjs-component-tools.js"` (PR #5 will add another re-export)
  - Define constants: `MAX_FILE_SIZE_BYTES = 2_097_152`, `CLIENT_HOOKS_EXCLUDE = new Set(["useId", "useContext"])` (tunable), `EVENT_HANDLER_ATTRS = new Set([...])`, `BROWSER_GLOBALS = new Set([...])`
- [ ] Verify: `npx vitest run tests/parser/nextjs-component-tools.test.ts -t "exports"`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: Spec §Data Model (NextjsComponentEntry, NextjsComponentsResult types defined)
- [ ] Commit: `feat(nextjs-tools): add component tool types and skeleton`

---

### Task 20: Implement `classifyFile` two-stage directive detection

**Files:** `src/tools/nextjs-component-tools.ts`, `tests/parser/nextjs-component-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 19
**Execution routing:** deep

- [ ] RED: Write 4 test cases for `classifyFile(filePath, repoRoot)`:
  - File with `"use client"` at top → directive = `"use client"`, classification pending (computed later via signals)
  - File with `if (x) { "use client" }` (conditional, inside block) → directive = `null` (rejected by AST position check in stage 3)
  - File that fails tree-sitter parse (malformed JSX) → entry with `classification: "ambiguous"`, file added to parse_failures (verified via caller)
  - File that passes stage 1 (512-byte scan finds `"use client"` substring in a comment) but stage 3 AST confirms it's inside a comment, not `Program.body[0]` → directive = `null`
- [ ] GREEN: Implement `classifyFile(filePath: string, repoRoot: string): Promise<NextjsComponentEntry>`:
  - Stage 1: Call `scanDirective(filePath)` from utils/nextjs.ts (fast reject via 512-byte window)
  - Stage 2: If stage 1 returned non-null OR we need to detect inferred client (always), parse file via `parseFile(filePath)` from parser-manager.ts
  - Stage 3: If tree-sitter parse failed, return `{ classification: "ambiguous", ..., file included in caller's parse_failures }` (or throw a typed error caught by caller)
  - Stage 4: Confirm directive — walk `tree.rootNode.namedChildren[0]` — must be ExpressionStatement whose first named child is a StringLiteral with text `"use client"` or `"use server"` — otherwise directive = null
  - For now, stub signal detection to return all-false (detailed in Task 21)
  - Return partial entry with directive field set correctly
- [ ] Verify: `npx vitest run tests/parser/nextjs-component-tools.test.ts -t directive`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Spec EC1.1-EC1.5 (directive detection including conditional rejection, 512-byte window, BOM, comment stripping)
- [ ] Commit: `feat(nextjs-tools): implement two-stage directive detection in classifyFile`

---

### Task 21: Implement signal detection (hooks, event handlers, browser globals)

**Files:** `src/tools/nextjs-component-tools.ts`, `tests/parser/nextjs-component-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 20
**Execution routing:** deep

- [ ] RED: Write 5 test cases for internal `detectSignals(tree, source)`:
  - File with `useState(...)` call → `signals.hooks: ["useState"]`
  - File with `<div onClick={() => {}}>` → `signals.event_handlers: ["onClick"]`
  - File with `window.location` → `signals.browser_globals: ["window"]`
  - File with `import dynamic from "next/dynamic"` + `dynamic(() => ..., { ssr: false })` → `signals.dynamic_ssr_false: true`
  - File with NO signals → all empty arrays/false
- [ ] GREEN: Implement internal helper `detectSignals(tree: Parser.Tree, source: string): NextjsComponentEntry["signals"]`:
  - Walk `descendantsOfType("call_expression")` for hook detection — match callee name against `/^use[A-Z]\w*$/`, exclude `CLIENT_HOOKS_EXCLUDE` set
  - Walk `descendantsOfType("jsx_attribute")` for event handlers — match attribute name against `EVENT_HANDLER_ATTRS` set
  - Walk `descendantsOfType("member_expression")` for browser globals — check if object identifier is in `BROWSER_GLOBALS` set
  - For `next/dynamic`: walk `descendantsOfType("import_statement")` — match source literal `"next/dynamic"` — then walk `descendantsOfType("call_expression")` for `dynamic(...)` calls — check second arg for `ssr: false` property
  - Return `{ hooks: [...], event_handlers: [...], browser_globals: [...], dynamic_ssr_false: boolean }`
  - ≤50 lines (CQ11 gate)
- [ ] Verify: `npx vitest run tests/parser/nextjs-component-tools.test.ts -t detectSignals`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Spec AC19 (detects next/dynamic with ssr:false as `signals.dynamic_ssr_false: true`) + Spec §Data Flow stages 4-7 (AST walking for hooks, events, browser globals, next/dynamic)
- [ ] Commit: `feat(nextjs-tools): add AST-based signal detection for client component heuristics`

---

### Task 22: Implement classification decision table

**Files:** `src/tools/nextjs-component-tools.ts`, `tests/parser/nextjs-component-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 21
**Execution routing:** default

- [ ] RED: Write 8 test cases for internal `applyClassificationTable(directive, signals)`:
  1. directive=null, no signals → `"server"`
  2. directive=null, has hooks → `"client_inferred"`
  3. directive=null, has events → `"client_inferred"`
  4. directive=null, has browser globals → `"client_inferred"`
  5. directive=`"use client"`, no signals → `"client_explicit"` + violation `"unnecessary_use_client"`
  6. directive=`"use client"`, has hooks → `"client_explicit"`
  7. directive=`"use server"`, no signals → `"server"` (use server is not a client signal)
  8. directive=null, dynamic_ssr_false=true → `"client_inferred"` with `signals.dynamic_ssr_false: true`
- [ ] GREEN: Implement pure function `applyClassificationTable(directive, signals): { classification, violations }`:
  - If directive === `"use client"`:
    - If any signal is present → `classification: "client_explicit"`, `violations: []`
    - Else → `classification: "client_explicit"`, `violations: ["unnecessary_use_client"]`
  - If directive === `"use server"` → `classification: "server"`
  - If directive === null:
    - If any signal is present (hooks OR events OR browser globals OR dynamic_ssr_false) → `classification: "client_inferred"`
    - Else → `classification: "server"`
  - Pure function, ≤20 lines, no I/O
- [ ] Verify: `npx vitest run tests/parser/nextjs-component-tools.test.ts -t applyClassificationTable`
  Expected: `Tests 8 passed (8)` — all 8 decision table rows
- [ ] Acceptance: Spec §Data Flow stage 8 (classification decision table)
- [ ] Commit: `feat(nextjs-tools): implement component classification decision table`

---

### Task 23: Implement orchestrator `analyzeNextjsComponents`

**Files:** `src/tools/nextjs-component-tools.ts`, `tests/parser/nextjs-component-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 20, Task 21, Task 22, Task 9 (fixture)
**Execution routing:** deep

- [ ] RED: Write 4 integration test cases against `tests/fixtures/nextjs-app-router/`:
  - `result.counts.total >= 20`
  - `result.parse_failures === []` (fixture invariant — QA-1)
  - `result.counts.unnecessary_use_client >= 1` (fixture includes `UnnecessaryClient.tsx`)
  - `result.counts.client_explicit >= 3` (fixture has `ClientButton.tsx`, `error.tsx`, `global-error.tsx`)
  Use `getCodeIndex(repo).root` to derive absolute path; test creates a tmpdir repo copy of fixture and indexes it.
- [ ] GREEN: Implement `analyzeNextjsComponents(repo, options)`:
  - Check kill switch: if `process.env.CODESIFT_DISABLE_TOOLS?.includes("analyze_nextjs_components")`, throw `"tool disabled"`
  - Get `index = await getCodeIndex(repo)`; use `index.root` as project root
  - If `options?.workspace` provided, scope root to `join(index.root, options.workspace)`
  - Else call `discoverWorkspaces(index.root)` — if result non-empty, iterate over each workspace; else use `index.root` as single workspace
  - For each workspace, use `walkDirectory(workspace/app, { followSymlinks: true })` to collect `.tsx`/`.jsx` files
  - Cap at `options?.max_files ?? 2000`; set `truncated: true` if capped
  - Process files in batches of 10 (`for i += 10; Promise.all(chunk.map(classifyFile))`)
  - Catch per-file errors — push to `parse_failures` or `scan_errors`
  - For each classified file, run `detectSignals` (Task 21) then `applyClassificationTable` (Task 22) to finalize classification
  - Aggregate into `NextjsComponentsResult`
  - Include `limitations: ["no transitive client boundary detection via barrel files"]`
  - ≤50 lines (delegates to helpers)
- [ ] Verify: `npx vitest run tests/parser/nextjs-component-tools.test.ts -t "analyze.*fixture"`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Spec AC16-AC23 (analyzeNextjsComponents full flow)
- [ ] Commit: `feat(nextjs-tools): implement analyzeNextjsComponents orchestrator`

---

### Task 24: Register `analyze_nextjs_components` tool and add formatter

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/formatters/nextjs-formatter.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 23
**Execution routing:** default

- [ ] RED: Write 2 tests:
  - `formatNextjsComponents(result)` on sample `NextjsComponentsResult` outputs string containing `"Total: N components"`, `"Server: N"`, `"Client (explicit): N"`, etc.
  - `TOOL_DEFINITIONS` includes entry with `name: "analyze_nextjs_components"`, `category: "analysis"` — verify via import + filter
- [ ] GREEN:
  - Add `formatNextjsComponents(result: NextjsComponentsResult): string` to `formatters.ts` — renders counts + top N violations + parse_failures summary
  - Add tool entry to `TOOL_DEFINITIONS` in `register-tools.ts`:
    ```typescript
    {
      name: "analyze_nextjs_components",
      category: "analysis",
      searchHint: "nextjs component server client classifier",
      description: "Classify Next.js files as Server or Client components; detect unnecessary use client",
      schema: {
        repo: z.string().optional().describe("Repo name (auto-resolved from CWD)"),
        workspace: z.string().optional().describe("Monorepo workspace path"),
        file_pattern: z.string().optional(),
        max_files: z.number().int().positive().optional(),
      },
      handler: async (args) => {
        const result = await analyzeNextjsComponents(args.repo as string, {
          workspace: args.workspace as string | undefined,
          file_pattern: args.file_pattern as string | undefined,
          max_files: args.max_files as number | undefined,
        });
        return formatNextjsComponents(result);
      },
    }
    ```
  - Do NOT add to `CORE_TOOL_NAMES` (hidden tool per spec)
- [ ] Verify: `npx vitest run tests/formatters/nextjs-formatter.test.ts`
  Expected: `Tests 2 passed (2)` + no regression in `register-tools.test.ts`
- [ ] Acceptance: Spec §Integration Points (tool registration); Spec AC21 (truncated flag rendered); Spec SC5 (manual smoke test — run `analyze_nextjs_components` on /Users/greglas/DEV/codesift-mcp itself or another real Next.js project accessible to the author; record the output's top 1 actionable finding in the PR description; commit a snapshot of the finding to `tests/fixtures/nextjs-smoke-test-2026-04-11/` per OQ1 resolution)
- [ ] Commit: `feat(register-tools): register analyze_nextjs_components as hidden analysis tool`

---

### Task 25: Create SC1 accuracy validator and SC3/SC4 benchmark scripts

**Files:** `scripts/validate-nextjs-accuracy.ts` (NEW), `scripts/benchmark-nextjs-tools.ts` (NEW), `tests/fixtures/nextjs-app-router/expected.json` (NEW)
**Complexity:** complex
**Dependencies:** Task 23, Task 9
**Execution routing:** deep

- [ ] RED: Add CI-smoke test that runs both scripts and asserts exit code 0 on the existing fixture. Assertion: `expect(childProcess.spawnSync("npx", ["tsx", "scripts/validate-nextjs-accuracy.ts"]).status).toBe(0)`.
- [ ] GREEN:
  - Author `tests/fixtures/nextjs-app-router/expected.json` BEFORE running the tool — manually reason about each fixture file and write `{ "app/page.tsx": { "classification": "server", "directive": null, ... }, ... }` for all 20+ files. This is the frozen ground truth per QA-1. Include the deliberate `UnnecessaryClient.tsx` case.
  - Author `scripts/validate-nextjs-accuracy.ts`:
    - Import `analyzeNextjsComponents`
    - Call on `tests/fixtures/nextjs-app-router/`
    - Compare result.files against `expected.json`
    - Assert `result.parse_failures.length === 0` (fixture invariant)
    - Compute precision for `unnecessary_use_client` flag: `correctly_flagged / total_flagged >= 0.95`
    - Compute recall for directive detection: `correctly_detected / total_with_directive === 1.0`
    - Exit code 1 on any failure, 0 on success
  - Author `scripts/benchmark-nextjs-tools.ts`:
    - Create synthetic fixture in tmpdir with 200 component files (for SC4 only; SC3 route-map benchmark extended in Task 33 below)
    - Run `analyzeNextjsComponents` and measure elapsed time; assert `< 3000ms`
    - Exit code 1 on missed deadline
    - Do NOT reference `nextjsRouteMap` here — it does not exist until PR #5 Task 30. The SC3 route benchmark is added by Task 33.
- [ ] Verify: `npx tsx scripts/validate-nextjs-accuracy.ts && npx tsx scripts/benchmark-nextjs-tools.ts`
  Expected: both exit 0; output includes `"SC1: PASS precision=X recall=Y"` and `"SC4: PASS elapsed=Yms"`
- [ ] Acceptance: Spec SC1 (≥95% precision, 100% recall), SC4 (<3s on 200 components); SC3 deferred to Task 33
- [ ] Commit: `feat(scripts): add nextjs accuracy validator and component benchmark`

---

### PR #5 — nextjs_route_map (Tasks 26-34)

### Task 26: Define route-map types and create `src/tools/nextjs-route-tools.ts` skeleton

**Files:** `src/tools/nextjs-route-tools.ts` (NEW), `src/tools/nextjs-tools.ts` (update barrel), `tests/parser/nextjs-route-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** PR #4 merged
**Execution routing:** default

- [ ] RED: Write skeleton test `it("exports nextjsRouteMap function", ...)` — initial fail.
- [ ] GREEN: Create `src/tools/nextjs-route-tools.ts`:
  - Export types: `RenderingStrategy`, `NextjsRouteEntry`, `NextjsRouteMapResult` (per spec §Data Model)
  - Export stub: `export async function nextjsRouteMap(repo, options?): Promise<NextjsRouteMapResult>` — throws not implemented
  - Update `src/tools/nextjs-tools.ts` barrel to re-export route-tools types and function
- [ ] Verify: `npx vitest run tests/parser/nextjs-route-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: Spec §Data Model (NextjsRouteEntry types defined)
- [ ] Commit: `feat(nextjs-tools): add route map types and skeleton`

---

### Task 27: Implement `readRouteSegmentConfig` AST initializer reader

**Files:** `src/tools/nextjs-route-tools.ts`, `tests/parser/nextjs-route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 26
**Execution routing:** deep

- [ ] RED: Write 6 test cases for internal `readRouteSegmentConfig(tree, source)`:
  - `export const dynamic = "force-dynamic"` → `{ dynamic: "force-dynamic" }`
  - `export const revalidate = 60` → `{ revalidate: 60 }`
  - `export const revalidate = false` → `{ revalidate: false }`
  - `export const runtime = "edge"` → `{ runtime: "edge" }`
  - `export const dynamic = someVar` (Identifier) → `{ dynamic: undefined, dynamic_non_literal: true }`
  - `export async function generateStaticParams() { ... }` → `{ has_generate_static_params: true }`
- [ ] GREEN: Implement `readRouteSegmentConfig(tree, source): NextjsRouteEntry["config"]`:
  - Walk `descendantsOfType("export_statement")` and inspect `lexical_declaration` → `variable_declarator`
  - For each known name (`dynamic`, `revalidate`, `runtime`, `fetchCache`, `preferredRegion`, `maxDuration`, `dynamicParams`), inspect initializer:
    - `string` literal → read value
    - `number` literal → parseFloat
    - `false`/`true` literal → read boolean
    - Anything else (Identifier, BinaryExpression, etc.) → set `<name>_non_literal: true` flag, leave value undefined
  - For `generateStaticParams`, check for `function_declaration` or `method_definition` with that name → set `has_generate_static_params: true`
  - Pure function, ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-route-tools.test.ts -t readRouteSegmentConfig`
  Expected: `Tests 6 passed (6)`
- [ ] Acceptance: Spec EC3.1 (non-literal dynamic flag), EC3.2 (revalidate numeric vs expression)
- [ ] Commit: `feat(nextjs-route-tools): read route segment config exports from AST`

---

### Task 28: Implement `classifyRendering` decision table

**Files:** `src/tools/nextjs-route-tools.ts`, `tests/parser/nextjs-route-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 27
**Execution routing:** default

- [ ] RED: Write 8 test cases for `classifyRendering(config, router, pagesRouterSignals)`:
  1. App Router, `dynamic = "force-dynamic"` → `"ssr"`
  2. App Router, `dynamic = "force-static"` → `"static"`
  3. App Router, `revalidate = 60` → `"isr"`
  4. App Router, `runtime = "edge"` → `"edge"`
  5. App Router, `has_generate_static_params: true` → `"static"`
  6. App Router, no config → `"static"` (Next.js default)
  7. Pages Router with `getServerSideProps` exported → `"ssr"`
  8. Pages Router with `getStaticProps` + no `revalidate` → `"static"`
- [ ] GREEN: Implement `classifyRendering(config, router, pagesSignals): RenderingStrategy`:
  - Apply table rules in priority order (runtime=edge > force-dynamic > force-static > revalidate > generateStaticParams > default)
  - Pages Router: check `pagesSignals.hasGetServerSideProps`, `pagesSignals.hasGetStaticProps`, `pagesSignals.hasRevalidateInReturn`
  - Pure function, ≤30 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-route-tools.test.ts -t classifyRendering`
  Expected: `Tests 8 passed (8)`
- [ ] Acceptance: Spec AC28 (rendering strategy correctly classified)
- [ ] Commit: `feat(nextjs-route-tools): implement rendering strategy classification table`

---

### Task 29: Implement `parseRouteFile` per-file processor

**Files:** `src/tools/nextjs-route-tools.ts`, `tests/parser/nextjs-route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 27, Task 28
**Execution routing:** deep

- [ ] RED: Write 5 test cases for `parseRouteFile(filePath, repoRoot, router)`:
  - `app/page.tsx` (no config, no metadata) → `{ rendering: "static", has_metadata: false }`
  - `app/products/[id]/page.tsx` with `export const metadata = {...}` → `{ has_metadata: true, url_path: "/products/[id]" }`
  - `app/api/users/route.ts` with `export async function GET` and `export async function POST` → `{ methods: ["GET", "POST"] }`
  - `pages/api/users.ts` → `{ router: "pages", type: "route", url_path: "/api/users" }`
  - `app/(auth)/login/page.tsx` → `{ url_path: "/login" }` (route group stripped)
- [ ] GREEN: Implement `parseRouteFile(filePath, repoRoot, router): Promise<NextjsRouteEntry>`:
  - Parse file via `parseFile(filePath)`
  - Call `readRouteSegmentConfig(tree, source)` for config
  - Detect `has_metadata`: look for `export const metadata =` or `export async function generateMetadata`
  - For `route.*` files, scan for exported HTTP methods: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`
  - Derive `url_path` via `deriveUrlPath(filePath, router)`
  - Derive `type`: look at filename (page, route, layout, loading, error, etc.); check for `@folder` prefix → "parallel"; `(.)`/`(..)`/`(...)` prefixes → "intercepting"
  - Call `scanDirective(filePath)` — set `is_client_component = (directive === "use client")`
  - Call `classifyRendering(config, router, pagesRouterSignals)` for `rendering` field
  - Call `computeLayoutChain(filePath, repoRoot)` for `layout_chain`
  - Return `NextjsRouteEntry`
  - ≤50 lines (delegates to helpers)
- [ ] Verify: `npx vitest run tests/parser/nextjs-route-tools.test.ts -t parseRouteFile`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Spec AC24-AC26, AC29-AC31 (route entries, metadata, methods, layout_chain)
- [ ] Commit: `feat(nextjs-route-tools): implement parseRouteFile with rendering and metadata detection`

---

### Task 30: Implement `nextjsRouteMap` orchestrator with hybrid conflict detection

**Files:** `src/tools/nextjs-route-tools.ts`, `tests/parser/nextjs-route-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 29
**Execution routing:** deep

- [ ] RED: Write 3 test cases using INLINE tmpdir fixtures (via `createFixture()` — NOT the committed `tests/fixtures/` directories, which are authored in Task 32). Each inline fixture is ≤10 files and created fresh per test. The committed fixtures are reserved for Task 33's validator script.
  - Inline App Router fixture (5 files: layout.tsx, page.tsx, (auth)/login/page.tsx, api/users/route.ts, middleware.ts) → `result.routes[]` contains 4+ entries, `result.conflicts === []`, no `scan_errors`
  - Inline Pages Router fixture (4 files: _app.tsx, _document.tsx, _error.tsx, index.tsx) → `result.routes[]` contains 4 entries with correct `type` values
  - Inline hybrid fixture (monorepo: 1 App Router + 1 Pages Router at same URL `/`) → `result.conflicts.length === 1`, conflict has both `app` and `pages` file paths
- [ ] GREEN: Implement `nextjsRouteMap(repo, options)`:
  - Check kill switch
  - Get index, resolve project root
  - Call `discoverWorkspaces(projectRoot)`; iterate over each workspace (or use root if none)
  - For each workspace, walk `app/` + `pages/` via `walkDirectory(... { followSymlinks: true })`
  - Filter to canonical convention files (App Router: `page|layout|loading|error|not-found|default|template|global-error|route`; Pages Router: all `.tsx`/`.ts` in `pages/`, including `_app`, `_document`, `_error`)
  - Cap at `options?.max_routes ?? 1000`; set `truncated: true` if capped
  - Batch-parse files (concurrency=10) via `parseRouteFile`
  - On error per file, push to `scan_errors`
  - Call `traceMiddleware(root, "/")` once per workspace for `middleware` field; per-route `middleware_applies` computed via `traceMiddleware(root, route.url_path).applies`
  - Detect conflicts: build `Map<url_path, { app?, pages? }>` — emit entry in `conflicts[]` when both present
  - Return `NextjsRouteMapResult`
- [ ] Verify: `npx vitest run tests/parser/nextjs-route-tools.test.ts -t "nextjsRouteMap"`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Spec AC24, AC25 (all conventions enumerated), AC33 (hybrid conflicts)
- [ ] Commit: `feat(nextjs-route-tools): implement nextjsRouteMap with hybrid conflict detection`

---

### Task 31: Register `nextjs_route_map` tool and add formatter + shortener

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `src/formatters-shortening.ts`, `tests/formatters/nextjs-formatter.test.ts`
**Complexity:** standard
**Dependencies:** Task 30
**Execution routing:** default

- [ ] RED: Write 3 tests:
  - `formatNextjsRouteMap(result)` outputs table with columns: URL, Type, Rendering, Router, Metadata
  - `formatNextjsRouteMapCompact(raw)` outputs shorter text (no per-route details, only grouped counts)
  - `TOOL_DEFINITIONS` includes entry with `name: "nextjs_route_map"`; `CORE_TOOL_NAMES` includes it (visible tool)
- [ ] GREEN:
  - Add `formatNextjsRouteMap`, `formatNextjsRouteMapCompact`, `formatNextjsRouteMapCounts` to `formatters.ts` / `formatters-shortening.ts`
  - Call `registerShortener("nextjs_route_map", formatNextjsRouteMapCompact, formatNextjsRouteMapCounts)` in `formatters-shortening.ts` or `register-tools.ts`
  - Add tool entry to `TOOL_DEFINITIONS`:
    ```typescript
    {
      name: "nextjs_route_map",
      category: "analysis",
      searchHint: "nextjs route map App Router Pages Router rendering strategy",
      description: "Complete Next.js route map with rendering strategy per route",
      schema: {
        repo: z.string().optional(),
        workspace: z.string().optional(),
        router: z.enum(["app", "pages", "both"]).optional(),
        include_metadata: z.boolean().optional(),
        max_routes: z.number().int().positive().optional(),
      },
      handler: async (args) => { ... },
    }
    ```
  - Add `"nextjs_route_map"` to `CORE_TOOL_NAMES` array (visible by default)
- [ ] Verify: `npx vitest run tests/formatters/nextjs-formatter.test.ts -t nextjs_route_map`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Spec AC34 (progressive shortener), Spec §Integration Points (tool registration visible)
- [ ] Commit: `feat(register-tools): register nextjs_route_map as core analysis tool with shortener`

---

### Task 32: Create Pages Router and hybrid test fixtures with predetermined expected.json

**Files:** `tests/fixtures/nextjs-pages-router/` (NEW, 15+ files), `tests/fixtures/nextjs-pages-router/expected.json` (NEW), `tests/fixtures/nextjs-hybrid/` (NEW), `tests/fixtures/nextjs-hybrid/expected.json` (NEW)
**Complexity:** standard
**Dependencies:** Task 26
**Execution routing:** default

- [ ] RED: Add `fixtures.test.ts` assertion that both new fixture directories have ≥13 files (pages-router) and contain `apps/web-app/` + `apps/web-pages/` subdirs (hybrid). Also assert both `expected.json` files exist: hybrid has `conflicts[]` array with length ≥1 AND a `routes_count` scalar; pages-router has a `routes` object mapping file paths to expected `{ url_path, type, rendering }` entries.
- [ ] GREEN: Create fixture structures per spec §Validation Methodology:
  - `tests/fixtures/nextjs-pages-router/`: `pages/index.tsx`, `pages/about.tsx`, `pages/_app.tsx`, `pages/_document.tsx`, `pages/_error.tsx`, `pages/api/users.ts`, `pages/api/posts.ts` (with `getStaticProps`), `pages/products/[id].tsx` (dynamic), `pages/blog/[...slug].tsx` (catch-all), `pages/ssr-page.tsx` (with `getServerSideProps`), `pages/isr-page.tsx` (with `getStaticProps` + `revalidate: 60`), `pages/static-page.tsx` (plain `getStaticProps`), `next.config.js` — 13+ files
  - `tests/fixtures/nextjs-pages-router/expected.json` — frozen ground truth listing each file's expected `{ url_path, router, type, rendering }` — authored BEFORE Task 33's validator runs. This closes the P7-1 gap.
  - `tests/fixtures/nextjs-hybrid/`:
    - `apps/web-app/next.config.ts`
    - `apps/web-app/app/layout.tsx`
    - `apps/web-app/app/page.tsx` → url_path `/`
    - `apps/web-app/app/api/users/route.ts` → url_path `/api/users`
    - `apps/web-pages/next.config.js`
    - `apps/web-pages/pages/index.tsx` → url_path `/`
    - `apps/web-pages/pages/api/users.ts` → url_path `/api/users`
  - `tests/fixtures/nextjs-hybrid/expected.json` — authored BEFORE implementation with:
    ```json
    {
      "conflicts": [
        { "url_path": "/", "app": "apps/web-app/app/page.tsx", "pages": "apps/web-pages/pages/index.tsx" },
        { "url_path": "/api/users", "app": "apps/web-app/app/api/users/route.ts", "pages": "apps/web-pages/pages/api/users.ts" }
      ],
      "routes_count": 7
    }
    ```
- [ ] Verify: `npx vitest run tests/tools/fixtures.test.ts`
  Expected: `Tests 1 passed` (fixtures exist with required structure and expected.json files)
- [ ] Acceptance: Spec §Validation Methodology (Pages Router + hybrid fixtures with predetermined conflicts per QA-6); closes P7-1 pages-router expected.json gap
- [ ] Commit: `test(fixtures): add Pages Router and hybrid fixtures with frozen expected.json`

---

### Task 33: Implement SC2 route count validator and SC3 route-map benchmark

**Files:** `scripts/validate-nextjs-route-count.ts` (NEW), `scripts/benchmark-nextjs-tools.ts` (extend)
**Complexity:** complex
**Dependencies:** Task 30, Task 32
**Execution routing:** deep

- [ ] RED: Add smoke test that runs `scripts/validate-nextjs-route-count.ts` and asserts exit code 0.
- [ ] GREEN:
  - Author `scripts/validate-nextjs-route-count.ts`:
    - For each of 3 fixtures (app-router, pages-router, hybrid — NOW available from Task 32 and Task 9):
      - Walk fixture via `picomatch` with canonical globs:
        - App Router: `app/**/{page,route,layout,loading,error,not-found,default,template,global-error}.{tsx,jsx,ts,js}`
        - Pages Router: `pages/**/*.{tsx,jsx,ts,js}` (includes `_app`, `_document`, `_error`, `pages/api/**`)
      - Collect into `Set<string>` for deduplication (QA-5)
      - Call `nextjsRouteMap(fixture, {})`
      - Assert `walked.size === result.routes.length`
      - Exit code 1 on mismatch with error message showing the diff (which files were missed or extra)
  - Extend `scripts/benchmark-nextjs-tools.ts` for SC3:
    - Generate 500 synthetic route files in tmpdir (e.g., `app/p{i}/page.tsx` for i in 1..500)
    - Call `nextjsRouteMap` (which exists after Task 30) and measure elapsed time
    - Assert `< 5000ms`
- [ ] Verify: `npx tsx scripts/validate-nextjs-route-count.ts && npx tsx scripts/benchmark-nextjs-tools.ts`
  Expected: both exit 0; output includes `"SC2: PASS 3/3 fixtures"` and `"SC3: PASS elapsed=Yms"`
- [ ] Acceptance: Spec SC2 (exact count equality across 3 fixtures), SC3 (<5s on 500 routes)
- [ ] Commit: `feat(scripts): add SC2 route count validator and SC3 route-map benchmark`

---

### Task 34: Update CLAUDE.md, README.md, and instructions.ts tool count

**Files:** `CLAUDE.md`, `README.md`, `src/instructions.ts`
**Complexity:** standard
**Dependencies:** Task 24, Task 31
**Execution routing:** default

- [ ] RED: Write test `tests/instructions.test.ts` that asserts the CodeSift tool count in `CODESIFT_INSTRUCTIONS` is `74` (up from 72). Also verify `CLAUDE.md` contains `"74 MCP tools"`. Use `fs.readFileSync` on these files in the test. Assertion: `expect(instructionsString).toContain("74 MCP tools")`.
- [ ] GREEN: Update all tool-count references from 72 → 74:
  - `src/instructions.ts` — first line of `CODESIFT_INSTRUCTIONS`
  - `CLAUDE.md` — `## Architecture` section, any grep count examples
  - `README.md` — header / feature list
  - Update `core` count: 36 → 37 (only `nextjs_route_map` is added to `CORE_TOOL_NAMES`; `analyze_nextjs_components` is hidden)
  - Update `discoverable` count: 36 → 37 (one hidden tool added)
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: `Tests 1 passed (1)`; also `rg "72 MCP tools" src/ CLAUDE.md README.md` returns no matches
- [ ] Acceptance: Spec §Backward Compatibility (tool count updated across documentation)
- [ ] Commit: `docs: update tool count to 74 for nextjs intelligence additions`

---

## Task Count Summary

| PR | Tasks | Complex | Standard |
|----|-------|---------|----------|
| PR #1 Foundation | 9 | 3 | 6 |
| PR #2 search_patterns | 3 | 0 | 3 |
| PR #3 trace_route | 6 | 4 | 2 |
| PR #4 analyze_nextjs_components | 7 | 4 | 3 |
| PR #5 nextjs_route_map | 9 | 5 | 4 |
| **Total** | **34** | **16** | **18** |

Complex tasks (16) will use the deep implementation tier in `zuvo:execute`. Standard tasks (18) use the default tier.

## Dependency Summary

- PR #1 Tasks 1-9: serialized chain for `nextjs.ts` edits: 1 → 2 → 3 → 7 → 8. Tasks 4, 5 are independent (different files). Task 6 depends on Task 1 + Task 5. Task 9 is independent.
- PR #2 Tasks 10-12 depend on PR #1 merged (for the shared util imports).
- PR #3 Tasks 13-18 depend on PR #1 merged, with sequential dependencies 13 → 14 → 15 → 16 → 17 → 18.
- PR #4 Tasks 19-25 depend on PR #1 + PR #3 merged (share `scanDirective`, fixture), sequential 19 → 20 → 21 → 22 → 23 → 24 → 25.
- PR #5 Tasks 26-34: sequential 26 → 27 → 28 → 29 → 30 → 31. Task 32 (create committed fixtures) depends on Task 26 only and can run in parallel with 27-31. Task 33 (SC2 validator + SC3 benchmark) depends on both Task 30 (`nextjsRouteMap` implemented) AND Task 32 (committed fixtures exist). Task 34 (doc updates) depends on Task 24 + Task 31.

## Verification Commands (Cumulative)

Each PR must pass these before merge:

```bash
# Type check
npx tsc --noEmit

# Full test suite (no regressions)
npx vitest run

# PR-specific test scope
npx vitest run tests/utils/nextjs.test.ts tests/parser/nextjs-*.test.ts

# Validation scripts (PR #4, #5)
npx tsx scripts/validate-nextjs-accuracy.ts
npx tsx scripts/validate-nextjs-route-count.ts
npx tsx scripts/benchmark-nextjs-tools.ts
```

Full suite must pass with zero regressions before each PR merges.
