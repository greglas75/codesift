# Implementation Plan: Next.js Tier 1 Tools — Full 14-Tool Wave

**Spec:** inline — no spec (based on real-world MYA project audit + competitor research)
**spec_id:** none
**planning_mode:** inline
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 52
**Estimated complexity:** 23 complex / 29 standard across 9 PRs

## Scope

Eleven new/enhanced Next.js tools (Q1, Q2, Q3, T1, T2, T3, T4, T5, T6, T8, T11) organized into 9 sequential PRs, built on top of the existing Next.js intelligence foundation (`src/utils/nextjs.ts`, `nextjs-component-tools.ts`, `nextjs-route-tools.ts` — already merged).

**Deferred (not in this plan):**
- T7 migration assistant (Vercel codemods exist)
- T9 bundle impact estimation (needs actual webpack parser — deferred to v2)
- T10 i18n audit (niche use case — deferred)

## Architecture Summary

**New shared helpers** in `src/utils/nextjs.ts`:
- `parseMetadataExport(tree, source): MetadataFields` — used by T1, T11
- `extractFetchCalls(tree, source): FetchCall[]` — used by Q2, T6
- `extractZodSchema(tree, source): ZodShape | null` — used by T2, T3
- `extractLinkHrefs(tree, source): LinkRef[]` — used by T5

**New tool files** (following `src/tools/nextjs-*-tools.ts` pattern):
- `nextjs-metadata-tools.ts` (T1)
- `nextjs-security-tools.ts` + `nextjs-security-readers.ts` + `nextjs-security-scoring.ts` (T2, 3-file split)
- `nextjs-api-contract-tools.ts` + `nextjs-api-contract-readers.ts` (T3, 2-file split)
- `nextjs-boundary-tools.ts` (T4)
- `nextjs-link-tools.ts` (T5)
- `nextjs-data-flow-tools.ts` (T6)
- `nextjs-middleware-coverage-tools.ts` (T8)
- `nextjs-framework-audit-tools.ts` + `src/utils/nextjs-audit-cache.ts` (T11)

**Tools extended** (Q1, Q2, Q3):
- `nextjs-component-tools.ts` — `suggested_fix` field on `NextjsComponentEntry`
- `nextjs-route-tools.ts` — `rendering_reason` field on `NextjsRouteEntry`
- `pattern-tools.ts` — `nextjs-missing-use-client` builtin pattern

## Technical Decisions

| Decision | Choice |
|---|---|
| Zod schema extraction | AST callee match on `z.{object,string,number,...}` + chained methods. Other validators (Yup/Joi/TypeBox) → `schema_lib: "unknown"` |
| OpenAPI generation | Simplified `handler_shape` (not full OpenAPI). Field name signals "best-effort contract" |
| Waterfall detection | Same-scope + no shared identifier between awaits. Respect `// sequential intentional` comment opt-out |
| Metadata scoring | Weighted: title 25, desc 20, OG 20, canonical 15, twitter 10, JSON-LD 10. Length gates for title/desc. Placeholder OG images rejected |
| Bundle estimation | Signals only (`loc`, `import_count`, `dynamic_import_count`, `third_party_imports`). Deterministic ranking score, no byte estimates |
| Link integrity matching | Literal-only. Template literals → `"unresolved"` bucket |
| Auth guard detection | Default pattern set (auth, getSession, currentUser, clerk.auth, validateRequest). Confidence: high/medium/low |
| T11 performance | Shared `NextjsAuditCache` with 60s TTL eviction. Sequential sub-tools inside, concurrency=10 inside each |
| No new npm deps | Internal batching via `for...of + slice + Promise.all` pattern |

## Quality Strategy

**At-risk CQ gates**: CQ8 (error handling on AST failures), CQ11 (file size, enforced by 3-file/2-file splits for T2/T3), CQ14 (duplication avoided via shared helpers), CQ17 (T11 performance via cache), CQ25 (pattern consistency with existing registration/test patterns).

**Ship-level gates**:
- Every new helper: 4-8 unit tests in `tests/utils/nextjs.test.ts` covering happy path + empty/null + non-literal AST + malformed source
- Every new tool: integration tests in `tests/parser/` pool (WASM enabled)
- Each fixture's `expected.json` authored BEFORE running the tool (Q17 anti-echo)
- No regression in full `npx vitest run` suite
- T11 memory regression test: 50-file scan under 200MB peak RSS

**Pool assignment**: All tests that call `parseFile` or walk ASTs go in `tests/parser/` pool. Pure logic tests (scoring, regex matching) can go in `tests/utils/` (core pool).

---

## Task Breakdown

### PR #1 — Shared Helpers + Quick Wins (Tasks 1-7)

> **Execution order within PR #1**: Tasks 1 → 2 → 3 → 4 MUST run sequentially (all edit `src/utils/nextjs.ts` and `tests/parser/nextjs-helpers.test.ts`; parallel execution produces merge conflicts). Tasks 5, 6, 7 can run in parallel after their dependencies are met (Task 6 depends on Task 2; others are independent).

### Task 1: Add `parseMetadataExport` helper

**Files:** `src/utils/nextjs.ts`, `tests/parser/nextjs-helpers.test.ts` (NEW)
**Complexity:** complex
**Dependencies:** none (but Tasks 2-4 serialize on this file — see PR #1 header)
**Execution routing:** deep

- [ ] RED: Write 6 test cases for `parseMetadataExport(tree, source)`:
  - Static `export const metadata = { title: "Foo", description: "Bar" }` → returns `{ title: "Foo", description: "Bar" }`
  - `export const metadata` with `openGraph: { images: ["/og.png"] }` → `openGraph.images[0] === "/og.png"`
  - `export async function generateMetadata` returning object → extracts fields from return
  - Missing export → returns `{}` (empty object)
  - Non-object initializer (variable reference) → returns `{ _non_literal: true }`
  - Nested `twitter: { card: "summary_large_image" }` → extracted
  Test file: `tests/parser/nextjs-helpers.test.ts` (parser pool for WASM).
- [ ] GREEN: Export `parseMetadataExport(tree: Parser.Tree, source: string): MetadataFields` in `src/utils/nextjs.ts`.
  - Walk `descendantsOfType("export_statement")`
  - For static export: find `variable_declarator` named `metadata`, read its object initializer
  - For function export: find `generateMetadata` function, walk return statement for object literal
  - Extract known fields: `title`, `description`, `openGraph`, `twitter`, `alternates.canonical`, `robots`, `other` (catch-all)
  - Return `MetadataFields` interface — define in same file
  - ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-helpers.test.ts -t parseMetadataExport`
  Expected: `Tests 6 passed (6)`
- [ ] Acceptance: Shared helper needed by T1, T11
- [ ] Commit: `feat(utils): add parseMetadataExport helper for Next.js metadata extraction`

---

### Task 2: Add `extractFetchCalls` helper

**Files:** `src/utils/nextjs.ts`, `tests/parser/nextjs-helpers.test.ts`
**Complexity:** complex
**Dependencies:** Task 1 (sequential — shared file)
**Execution routing:** deep

- [ ] RED: Write 7 test cases for `extractFetchCalls(tree, source)`:
  - Single `fetch('/api/data')` → one entry, `cacheOption: null`
  - `fetch('/api/data', { cache: 'no-store' })` → `cacheOption: 'no-store'`, flagged as SSR trigger
  - `fetch('/api/data', { next: { revalidate: 60 } })` → `cacheOption: 'isr-60'`
  - Two sequential `await fetch` in same scope → `isSequential: true` for second
  - Two awaits with shared identifier (`const data = await fetch(a); const more = await fetch(\`${data}\`)`) → `isSequential: false` (dependent)
  - `cookies()` call → entry with `callee: 'cookies'`, dynamic trigger
  - `headers()` call → entry with `callee: 'headers'`, dynamic trigger
- [ ] GREEN: Export `extractFetchCalls(tree: Parser.Tree, source: string): FetchCall[]`.
  - Walk `call_expression` nodes for names: `fetch`, `cookies`, `headers`, `unstable_noStore`
  - For each: capture `{ callee, line, cacheOption, isSequential }`
  - `isSequential` rule per D3: two awaits in same `statement_block`, no shared identifier between them
  - Detect `// sequential intentional` comment preceding await → suppress isSequential
  - Return `FetchCall[]`
  - ≤60 lines (complex rules)
- [ ] Verify: `npx vitest run tests/parser/nextjs-helpers.test.ts -t extractFetchCalls`
  Expected: `Tests 7 passed (7)`
- [ ] Acceptance: Shared helper needed by Q2, T6
- [ ] Commit: `feat(utils): add extractFetchCalls helper for fetch/cookies/headers detection`

---

### Task 3: Add `extractZodSchema` helper

**Files:** `src/utils/nextjs.ts`, `tests/parser/nextjs-helpers.test.ts`
**Complexity:** complex
**Dependencies:** Task 2
**Execution routing:** deep

- [ ] RED: Write 6 test cases:
  - `z.object({ name: z.string() })` → returns `{ fields: { name: { type: "string" } }, partial: false }`
  - Chained `z.object({}).strict().refine(...)` → returns non-null shape with chain methods captured in `partial: false`
  - `z.object({ age: z.number().int().min(0) })` → `fields.age === { type: "number", constraints: ["int", "min"] }`
  - Non-Zod object literal `{ name: "foo" }` → returns `null`
  - Nested: `z.object({ user: z.object({ name: z.string() }) })` → nested shape in fields
  - Yup/Joi call (e.g., `yup.object()`) → returns `null` (Zod-only detection). Downstream tools (T2, T3) wrap null results and add `schema_lib: "unknown"` context at their own aggregation level
- [ ] GREEN: Export `extractZodSchema(tree: Parser.Tree, source: string): ZodShape | null`.
  - Walk `call_expression` for callee matching `member_expression` where object is `z` (or `zod`)
  - Property must be in allowlist: `object|string|number|boolean|array|union|enum|literal|optional|nullable|record|tuple|discriminatedUnion|date`
  - Recursively parse `z.object({...})` arguments — each property value must also be a Zod call
  - Handle chained methods: `.extend()`, `.merge()`, `.omit()`, `.pick()`, `.strict()`, `.refine()`
  - Return `{ fields: Record<string, ZodFieldType>, partial: boolean }` — `partial: true` when unresolved fields present
  - ≤80 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-helpers.test.ts -t extractZodSchema`
  Expected: `Tests 6 passed (6)`
- [ ] Acceptance: Shared helper needed by T2, T3
- [ ] Commit: `feat(utils): add extractZodSchema helper for Zod AST detection`

---

### Task 4: Add `extractLinkHrefs` helper

**Files:** `src/utils/nextjs.ts`, `tests/parser/nextjs-helpers.test.ts`
**Complexity:** standard
**Dependencies:** Task 3
**Execution routing:** default

- [ ] RED: Write 5 test cases:
  - `<Link href="/about">` → `{ href: "/about", line: N, isDynamic: false, kind: "link" }`
  - `<Link href={\`/users/${id}\`}>` → `isDynamic: true`, raw expression captured
  - `router.push("/dashboard")` → `{ href: "/dashboard", kind: "router_push" }`
  - `router.replace("/login")` → `{ href: "/login", kind: "router_replace" }`
  - `<a href="/external">` → NOT returned (only `<Link>` JSX component matches)
- [ ] GREEN: Export `extractLinkHrefs(tree: Parser.Tree, source: string): LinkRef[]`.
  - Walk `jsx_opening_element` where name is `Link` — find `jsx_attribute` with name `href`
  - If attribute value is `string` literal → `isDynamic: false`
  - If attribute value is `jsx_expression` with template literal or identifier → `isDynamic: true`
  - Walk `call_expression` where callee is `router.push` or `router.replace` — extract first argument
  - Return `LinkRef[]` type — define in same file
  - ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-helpers.test.ts -t extractLinkHrefs`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Shared helper needed by T5
- [ ] Commit: `feat(utils): add extractLinkHrefs helper for Link and router calls`

---

### Task 5: Q1 — Add `suggested_fix` to `NextjsComponentEntry`

**Files:** `src/tools/nextjs-component-tools.ts`, `tests/parser/nextjs-component-tools.test.ts`
**Complexity:** standard
**Dependencies:** none (independent of helpers)
**Execution routing:** default

- [ ] RED: Write 3 test cases:
  - File with `"use client"` but no hooks → `suggested_fix: "Remove 'use client' directive (no client signals detected)"`, violations `["unnecessary_use_client"]`
  - File with `useState` but no directive → `suggested_fix: "Add 'use client' directive at top of file"`, classification `"client_inferred"`
  - Pure server component (no directive, no signals) → `suggested_fix: undefined`
- [ ] GREEN: Add `suggested_fix?: string` to `NextjsComponentEntry` interface. In `classifyAndDetect` (or wherever entries are finalized), populate after classification:
  - `client_inferred` → `"Add 'use client' directive at top of file"`
  - `violations.includes("unnecessary_use_client")` → `"Remove 'use client' directive (no client signals detected)"`
  - Other cases → leave undefined
- [ ] Verify: `npx vitest run tests/parser/nextjs-component-tools.test.ts -t suggested_fix`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Q1 — suggested_fix field populated for actionable cases
- [ ] Commit: `feat(nextjs-tools): add suggested_fix field for client boundary violations`

---

### Task 6: Q2 — Add `rendering_reason` to `NextjsRouteEntry`

**Files:** `src/tools/nextjs-route-tools.ts`, `tests/parser/nextjs-route-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 2 (uses `extractFetchCalls`)
**Execution routing:** default

- [ ] RED: Write 4 test cases:
  - Route with `cookies()` call → `rendering: "ssr"`, `rendering_reason: "cookies() called at line N"`
  - Route with `fetch(url, { cache: 'no-store' })` → `rendering_reason: "fetch with cache:'no-store' at line N"`
  - Route with `export const dynamic = "force-dynamic"` → `rendering_reason: "dynamic='force-dynamic' config export"`
  - Static page (no SSR triggers) → `rendering_reason: undefined`
- [ ] GREEN: Add `rendering_reason?: string` to `NextjsRouteEntry`. In `parseRouteFile`, after `classifyRendering` returns `"ssr"`, call `extractFetchCalls(tree, source)` and pick first SSR trigger:
  - If `config.dynamic === "force-dynamic"` → format from config
  - Else if any fetch with `cacheOption === "no-store"` → format from fetch
  - Else if any `cookies()` or `headers()` call → format from that
  - Else `"unknown SSR trigger"`
- [ ] Verify: `npx vitest run tests/parser/nextjs-route-tools.test.ts` (full file — guards against regressing existing route classification tests)
  Expected: `Tests N passed` (all existing tests + 4 new cases pass)
- [ ] Acceptance: Q2 — explains why a route is SSR
- [ ] Commit: `feat(nextjs-route-tools): add rendering_reason field explaining SSR triggers`

---

### Task 7: Q3 — Add `nextjs-missing-use-client` pattern

**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Write 3 test cases:
  - `.tsx` file with `useState` but no `"use client"` at top → pattern matches
  - `.tsx` file with `"use client"` + `useState` → pattern does NOT match
  - `.tsx` file in `pages/` directory with `useState` → pattern does NOT match (Pages Router doesn't need directive)
- [ ] GREEN: Add entry to `BUILTIN_PATTERNS`:
  - `"nextjs-missing-use-client"`: regex matching file source that contains `useState|useEffect|useRef|useCallback|useMemo|useContext|onClick=|onChange=|onSubmit=` but does NOT start with `["'\`]use client["'\`]` in first 512 bytes
  - `fileIncludePattern: /(^|\/)app\/.*\.(tsx|jsx)$/`
  - Description: `"Client-only API used without 'use client' directive — component will error at build (Next.js App Router)"`
- [ ] Verify: `npx vitest run tests/tools/pattern-tools.test.ts -t missing-use-client`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Q3 — pattern available via search_patterns for mass scans
- [ ] Commit: `feat(patterns): add nextjs-missing-use-client builtin pattern`

---

### PR #2 — T1 Metadata Audit (Tasks 8-12)

### Task 8: T1 skeleton + types

**Files:** `src/tools/nextjs-metadata-tools.ts` (NEW), `tests/parser/nextjs-metadata-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: Skeleton test `it("exports nextjsMetadataAudit function", () => expect(typeof nextjsMetadataAudit).toBe("function"))`.
- [ ] GREEN: Create `src/tools/nextjs-metadata-tools.ts` with types: `MetadataField`, `MetadataScore`, `NextjsMetadataAuditResult`. Export stub `async function nextjsMetadataAudit(repo, options?)` that throws `"not implemented"`. Export from `src/tools/nextjs-tools.ts` barrel.
- [ ] Verify: `npx vitest run tests/parser/nextjs-metadata-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T1 skeleton in place
- [ ] Commit: `feat(nextjs-metadata-tools): add skeleton and types`

---

### Task 9: T1 metadata scorer (pure function)

**Files:** `src/tools/nextjs-metadata-tools.ts`, `tests/parser/nextjs-metadata-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 8
**Execution routing:** deep

- [ ] RED: Write 8 test cases for `scoreMetadata(fields: MetadataFields): MetadataScore`. Every test MUST specify complete input MetadataFields object for reproducibility:
  - Input: `{ title: "Complete Product Page Title", description: "A detailed description of exactly 50 or more characters here.", openGraph: { images: ["/real-og.jpg"] }, alternates: { canonical: "/products" }, twitter: { card: "summary" }, other: { "application/ld+json": {} } }` → score 100, grade `"excellent"`
  - Input: `{ description: "A detailed description of exactly 50 or more characters here.", openGraph: { images: ["/real-og.jpg"] }, alternates: { canonical: "/products" }, twitter: { card: "summary" }, other: { "application/ld+json": {} } }` (missing title) → score 75, grade `"good"`
  - Input: `{ openGraph: { images: ["/real-og.jpg"] }, alternates: { canonical: "/products" }, twitter: { card: "summary" }, other: { "application/ld+json": {} } }` (missing title AND description, all others present = 20+15+10+10 = 55) → score 55, grade `"needs_work"`
  - Input: `{ title: "Complete Product Page Title" }` (only title with length ≥10) → score 25, grade `"poor"`
  - Input: `{}` (empty) → score 0, grade `"poor"`
  - Input: `{ title: "Short", description: "A detailed description of exactly 50 or more characters here." }` (title 5 chars, below gate) → title=0, desc=20, score 20, violations includes `"title_too_short"`
  - Input: `{ title: "Complete Product Page Title", description: "Too short" }` (desc 9 chars) → title=25, desc=0, score 25, violations includes `"description_too_short"`
  - Input: `{ title: "Complete Product Page Title", description: "A detailed description of exactly 50 or more characters here.", openGraph: { images: ["/og-image.png"] } }` (placeholder OG) → title=25, desc=20, OG=0, score 45, violations includes `"og_image_placeholder"`
- [ ] GREEN: Implement `scoreMetadata(fields): { score: number, grade: "poor"|"needs_work"|"good"|"excellent", violations: string[] }`:
  - Pure function, no I/O
  - Weights per D4: title 25, desc 20, OG 20, canonical 15, twitter 10, JSON-LD 10
  - Length gates: title ≥10, desc ≥50 (zero points below threshold + violation flag)
  - Placeholder OG: reject `"/og-image.png"`, `"/favicon.ico"`, empty strings
  - Grade thresholds: 0-39 poor, 40-69 needs_work, 70-89 good, 90-100 excellent
  - ≤40 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-metadata-tools.test.ts -t scoreMetadata`
  Expected: `Tests 8 passed (8)`
- [ ] Acceptance: T1 scoring logic per D4 (weighted fields, length gates, placeholder rejection)
- [ ] Commit: `feat(nextjs-metadata-tools): implement weighted metadata scoring`

---

### Task 10: T1 `nextjsMetadataAudit` orchestrator

**Files:** `src/tools/nextjs-metadata-tools.ts`, `tests/parser/nextjs-metadata-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 8, Task 9, Task 1
**Execution routing:** deep

- [ ] RED: Write 3 integration tests against `tests/fixtures/nextjs-app-router/`:
  - Call `nextjsMetadataAudit(repo)` → returns result with `total_pages ≥ 1`, `scores[]` populated
  - Aggregate counts: `excellent`, `good`, `needs_work`, `poor` all defined
  - At least 1 page with metadata should have score >0
- [ ] GREEN: Implement `nextjsMetadataAudit(repo, options?)`:
  - Get `index = await getCodeIndex(repo)`
  - Walk `app/**/page.{tsx,jsx,ts,js}` files via `walkDirectory`
  - For each page: parse via `parseFile`, call `parseMetadataExport(tree, source)`, call `scoreMetadata(fields)`
  - Aggregate: `{ total_pages, scores: [...], counts: { excellent, good, needs_work, poor }, top_issues: [...] }`
  - Batch: concurrency=10
  - Include `limitations` array: `["does not check remote Open Graph image resolution"]`
  - ≤60 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-metadata-tools.test.ts -t orchestrator`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T1 orchestrator wired to helpers
- [ ] Commit: `feat(nextjs-metadata-tools): implement orchestrator with workspace walk and scoring`

---

### Task 11: T1 registration + formatter + shortener

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `src/formatters-shortening.ts`, `tests/formatters/nextjs-metadata-formatter.test.ts` (NEW)
**Complexity:** complex
**Dependencies:** Task 10
**Execution routing:** deep

- [ ] RED: Create `tests/formatters/nextjs-metadata-formatter.test.ts` with 3 tests: (a) `formatNextjsMetadataAudit(result)` renders table with columns `URL | Score | Grade | Missing Fields` (assert via `toContain`), (b) `formatNextjsMetadataAuditCompact(result)` shows only counts summary + top 5 issues (assert output length < 500 chars), (c) `TOOL_DEFINITIONS.find(t => t.name === "nextjs_metadata_audit")` returns entry with `category: "analysis"`.
- [ ] GREEN:
  - Add `formatNextjsMetadataAudit(result)` to `formatters.ts`
  - Add `formatNextjsMetadataAuditCompact/Counts` to `formatters-shortening.ts`
  - Call `registerShortener("nextjs_metadata_audit", ...)` 
  - Append to `TOOL_DEFINITIONS`:
    ```typescript
    {
      name: "nextjs_metadata_audit",
      category: "analysis",
      searchHint: "nextjs seo metadata title description og image audit",
      description: "Audit Next.js page metadata for SEO completeness with per-route scoring",
      schema: {
        repo: z.string().optional(),
        workspace: z.string().optional(),
        max_routes: z.number().int().positive().optional(),
      },
      handler: async (args) => formatNextjsMetadataAudit(await nextjsMetadataAudit(args.repo as string, { ... })),
    }
    ```
  - Add to `CORE_TOOL_NAMES` (visible by default — high-value tool)
- [ ] Verify: `npx vitest run tests/formatters/nextjs-metadata-formatter.test.ts`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T1 tool registered and visible
- [ ] Commit: `feat(register-tools): register nextjs_metadata_audit as core analysis tool`

---

### Task 12: T1 fixture with `expected.json`

**Files:** `tests/fixtures/nextjs-metadata/` (NEW), `tests/fixtures/nextjs-metadata/expected.json` (NEW)
**Complexity:** standard
**Dependencies:** Task 11
**Execution routing:** default

- [ ] RED: Fixture test asserts `expected.json` has pre-authored scores for 4 fixture pages.
- [ ] GREEN: Create fixture directory with 4 pages:
  - `app/page.tsx` — full metadata (title, description, OG image, canonical, twitter, JSON-LD) → expected score 100
  - `app/about/page.tsx` — title + description only → expected score 45
  - `app/blog/page.tsx` — title only, too short → expected score 0 (length gate violation)
  - `app/products/page.tsx` — placeholder OG image → expected score 75
  - `expected.json`: author BEFORE running tool, store `{ "routes": { "app/page.tsx": 100, ... }, "counts": {...} }`
  - `next.config.js` (trigger Next.js detection)
- [ ] Verify: `npx vitest run tests/parser/nextjs-metadata-tools.test.ts -t fixture-expected`
  Expected: actual scores from `nextjsMetadataAudit` match `expected.json` exactly
- [ ] Acceptance: T1 has frozen ground truth for regression
- [ ] Commit: `test(fixtures): add nextjs-metadata fixture with pre-authored expected scores`

---

### PR #3 — T2 Server Actions Security Audit (Tasks 13-19)

### Task 13: T2 types + 3-file skeleton

**Files:** `src/tools/nextjs-security-tools.ts` (NEW), `src/tools/nextjs-security-readers.ts` (NEW), `src/tools/nextjs-security-scoring.ts` (NEW), `tests/parser/nextjs-security-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Write skeleton test asserting each file exports its stub.
- [ ] GREEN: Create 3 files per D10 split:
  - `nextjs-security-tools.ts`: types (`ServerActionAudit`, `AuthGuardInfo`, `SecurityScore`, `ServerActionsAuditResult`) + stub `nextjsAuditServerActions(repo, options?)`
  - `nextjs-security-readers.ts`: stubs for `extractServerActionFunctions(tree, source)`, `detectAuthGuard(tree, source)`, `detectInputValidation(tree, source)`, `detectRateLimiting(tree, source)`
  - `nextjs-security-scoring.ts`: stub for `scoreServerAction(info): SecurityScore`
  - Export main function from `nextjs-tools.ts` barrel
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t exports`
  Expected: 4 passed (one per file export)
- [ ] Acceptance: T2 skeleton in place with file split
- [ ] Commit: `feat(nextjs-security-tools): add 3-file skeleton with types`

---

### Task 14: T2 `extractServerActionFunctions` reader

**Files:** `src/tools/nextjs-security-readers.ts`, `tests/parser/nextjs-security-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 13
**Execution routing:** deep

- [ ] RED: Write 4 test cases:
  - File with file-scope `"use server"` + 3 exported async functions → returns 3 entries
  - File without `"use server"` → returns empty array
  - Function with inline `"use server"` directive → captured as action
  - Non-async function in `"use server"` file → still captured (some server actions are sync)
- [ ] GREEN: Implement `extractServerActionFunctions(tree, source): ServerActionFn[]`:
  - Use `scanDirective` to check file-scope `"use server"` first
  - If file-scope: walk `export_statement` + `function_declaration`/`variable_declarator` for exported functions, return all
  - Else: walk function bodies for inline `"use server"` directive as first statement
  - Each entry: `{ name, file, line, isAsync, bodyNode }`
  - ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t extractServerActionFunctions`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Server action enumeration works
- [ ] Commit: `feat(nextjs-security-readers): extract server action function list from AST`

---

### Task 15: T2 `detectAuthGuard` reader

**Files:** `src/tools/nextjs-security-readers.ts`, `tests/parser/nextjs-security-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 14
**Execution routing:** deep

- [ ] RED: Write 5 test cases per D7:
  - Function with `const session = await auth(); if (!session) throw ...` → confidence `"high"`
  - Function with `await auth()` but result not checked → confidence `"medium"`
  - Function with comment mentioning auth but no call → confidence `"low"`
  - Function wrapped in `withAuth(fn)` HOC → `auth_pattern: "hoc"`, confidence `"medium"`
  - Function with no auth indicators → confidence `"none"`, `auth_required` not set
- [ ] GREEN: Implement `detectAuthGuard(fn: ServerActionFn): AuthGuardInfo`:
  - Walk function body for `call_expression` matching default set: `auth`, `getSession`, `getServerSession`, `currentUser`, `validateRequest`, `auth.protect`
  - Check if call result is used in early-return conditional (look for `if (!result) return` or `throw` within N lines of call)
  - Return `{ confidence: "high"|"medium"|"low"|"none", pattern: "direct"|"hoc"|"none", callsite?: { name, line } }`
  - ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t detectAuthGuard`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Auth guard detection per D7 confidence rules
- [ ] Commit: `feat(nextjs-security-readers): detect auth guards with confidence levels`

---

### Task 16: T2 `detectInputValidation` + `detectRateLimiting` readers

**Files:** `src/tools/nextjs-security-readers.ts`, `tests/parser/nextjs-security-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 15, Task 3 (uses extractZodSchema)
**Execution routing:** deep

- [ ] RED: Write 6 test cases:
  - Server action calling `z.object(...).parse(input)` → `input_validation: { lib: "zod", confidence: "high" }`
  - Server action with `.safeParse(...)` → same but `confidence: "high"`
  - Server action without any validation → `input_validation: { lib: "none", confidence: "high" }`
  - Server action with manual `if (!name) throw ...` checks → `input_validation: { lib: "manual", confidence: "medium" }`
  - Server action with `ratelimit.limit(ip)` (Upstash pattern) → `rate_limiting: { lib: "upstash", confidence: "high" }`
  - Server action with no rate limiting → `rate_limiting: { lib: "none" }`
- [ ] GREEN: Implement two readers:
  - `detectInputValidation(fn, tree, source)`: look for `.parse()`, `.safeParse()` call on Zod schema (use `extractZodSchema` for disambiguation). Fallback: count manual `if` throws in first 5 statements as manual validation.
  - `detectRateLimiting(fn, tree, source)`: look for known rate-limit identifiers: `ratelimit.limit`, `rateLimit`, `createRateLimiter`, `@ratelimit/`
  - Both pure functions, ≤40 lines each
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t "detectInputValidation|detectRateLimiting"`
  Expected: `Tests 6 passed (6)`
- [ ] Acceptance: Input validation + rate limiting detection
- [ ] Commit: `feat(nextjs-security-readers): detect input validation and rate limiting`

---

### Task 17: T2 `scoreServerAction` pure scoring

**Files:** `src/tools/nextjs-security-scoring.ts`, `tests/parser/nextjs-security-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 15, Task 16
**Execution routing:** default

- [ ] RED: Write 5 test cases:
  - All checks passing (auth high, validation high, rate limit high) → score 100, grade `"excellent"`
  - Missing rate limit only → score 80
  - Missing validation and auth → score 20
  - No checks at all → score 0, grade `"poor"`
  - Auth medium + validation high → score 70
- [ ] GREEN: Implement `scoreServerAction(audit: ServerActionAudit): SecurityScore`:
  - Pure function, input is aggregated `{ auth, validation, rate_limiting, error_handling }` info
  - Weights: auth 40, validation 30, rate_limiting 20, error_handling 10
  - Confidence multipliers: high=1.0, medium=0.5, low=0.2, none=0
  - Return `{ score, grade, top_missing: string[] }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t scoreServerAction`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Security scoring is deterministic and testable
- [ ] Commit: `feat(nextjs-security-scoring): implement weighted security scoring`

---

### Task 18: T2 `nextjsAuditServerActions` orchestrator

**Files:** `src/tools/nextjs-security-tools.ts`, `tests/parser/nextjs-security-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 14, 15, 16, 17
**Execution routing:** deep

- [ ] RED: Write 3 integration tests with inline fixtures:
  - Fixture with 3 server actions (one secure, one with missing auth, one with missing validation) → returns `actions` array with correct score distribution
  - Project with no `"use server"` files → returns empty `actions`, `total: 0`
  - Handles parse failure on one file gracefully
- [ ] GREEN: Implement `nextjsAuditServerActions(repo, options?)`:
  - Get index, discover workspaces
  - Walk `.ts`/`.tsx` files, filter to those with file-scope `"use server"` or containing inline directives
  - For each file: parse, call `extractServerActionFunctions`, then per-function call `detectAuthGuard`, `detectInputValidation`, `detectRateLimiting`, then `scoreServerAction`
  - Batch: concurrency=10
  - Aggregate: `{ total, actions: [...], counts: { excellent, good, needs_work, poor }, violations: [...], parse_failures: [...], scan_errors: [...] }`
  - ≤80 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t "orchestrator|audit"`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T2 end-to-end security audit
- [ ] Commit: `feat(nextjs-security-tools): implement server actions security audit orchestrator`

---

### Task 19: T2 registration + formatter + fixture

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/fixtures/nextjs-security/` (NEW), `tests/fixtures/nextjs-security/expected.json`
**Complexity:** standard
**Dependencies:** Task 18
**Execution routing:** default

- [ ] RED: Fixture test asserts `expected.json` matches tool output for 3 hand-authored server actions (secure, missing-auth, missing-validation).
- [ ] GREEN:
  - Create fixture: `app/actions/secure.ts` (full checks), `app/actions/no-auth.ts`, `app/actions/no-validation.ts`, `next.config.js`
  - Author `expected.json` BEFORE running tool (Q17 anti-echo)
  - Add `formatNextjsAuditServerActions` to `formatters.ts`
  - Register tool in `TOOL_DEFINITIONS` with category `analysis`, hidden (not in CORE_TOOL_NAMES — advanced tool)
- [ ] Verify: `npx vitest run tests/parser/nextjs-security-tools.test.ts -t fixture`
  Expected: `Tests 1 passed (1)` + expected.json match
- [ ] Acceptance: T2 end-to-end with frozen ground truth
- [ ] Commit: `feat(register-tools): register nextjs_audit_server_actions with security fixture`

---

### PR #4 — T3 API Contract (Tasks 20-25)

### Task 20: T3 types + 2-file skeleton

**Files:** `src/tools/nextjs-api-contract-tools.ts` (NEW), `src/tools/nextjs-api-contract-readers.ts` (NEW), `tests/parser/nextjs-api-contract-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 3 (extractZodSchema)
**Execution routing:** default

- [ ] RED: Skeleton export tests (2 per file).
- [ ] GREEN: Create 2 files per D10:
  - `nextjs-api-contract-tools.ts`: types (`HandlerShape`, `ApiContractResult`, `HttpMethodInfo`) + stub `nextjsApiContract(repo, options?)`
  - `nextjs-api-contract-readers.ts`: stubs for `extractHttpMethods`, `extractRequestBodySchema`, `extractQueryParams`, `extractResponseShapes`
  - Export from `nextjs-tools.ts` barrel
- [ ] Verify: `npx vitest run tests/parser/nextjs-api-contract-tools.test.ts -t exports`
  Expected: `Tests 2 passed (2)`
- [ ] Acceptance: T3 skeleton with file split
- [ ] Commit: `feat(nextjs-api-contract-tools): add skeleton and types`

---

### Task 21: T3 `extractHttpMethods` + `extractQueryParams` readers

**Files:** `src/tools/nextjs-api-contract-readers.ts`, `tests/parser/nextjs-api-contract-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 20
**Execution routing:** default

- [ ] RED: Write 6 test cases:
  - `route.ts` with `export async function GET` → `methods: ["GET"]`
  - With GET + POST + DELETE → `methods: ["DELETE", "GET", "POST"]` (sorted)
  - `export async function GET(req) { const { searchParams } = new URL(req.url) }` → `query_params: ["*"]` (wildcard for runtime access)
  - `export async function GET({ searchParams }: { searchParams: { id: string } })` → `query_params: [{ name: "id", type: "string" }]`
  - No methods exported → `methods: []`
  - Export with `{ withAuth }` wrapper → detected but flagged `wrapped: true`
- [ ] GREEN: Implement 2 readers:
  - `extractHttpMethods(tree)`: walk `export_statement` for function names matching `GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS`
  - `extractQueryParams(tree, source)`: walk handler function parameter — check for destructured `searchParams` type annotation OR runtime `req.url` + `searchParams` access (return wildcard)
- [ ] Verify: `npx vitest run tests/parser/nextjs-api-contract-tools.test.ts -t "extractHttpMethods|extractQueryParams"`
  Expected: `Tests 6 passed (6)`
- [ ] Acceptance: HTTP method + query param extraction
- [ ] Commit: `feat(nextjs-api-contract-readers): extract HTTP methods and query params`

---

### Task 22: T3 `extractRequestBodySchema` reader (uses Zod)

**Files:** `src/tools/nextjs-api-contract-readers.ts`, `tests/parser/nextjs-api-contract-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 21
**Execution routing:** deep

- [ ] RED: Write 4 test cases:
  - Handler with `const body = schema.parse(await req.json())` where `schema` is defined in same file → `request_schema: { fields: {...} }`
  - Handler with imported schema `const body = CreateUserSchema.parse(...)` → `request_schema: { ref: "CreateUserSchema", resolved: false }`
  - Handler with `const body = await req.json()` no validation → `request_schema: null`
  - Handler with `req.formData()` → `request_schema: { type: "form" }`
- [ ] GREEN: Implement `extractRequestBodySchema(tree, source)`:
  - Walk handler function body for `.parse()` or `.safeParse()` call on a schema
  - If schema is local variable, use `extractZodSchema` to resolve shape
  - If imported, return `{ ref: "Name", resolved: false }`
  - Detect `req.formData()` for multipart form data
- [ ] Verify: `npx vitest run tests/parser/nextjs-api-contract-tools.test.ts -t extractRequestBodySchema`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Request body schema extraction
- [ ] Commit: `feat(nextjs-api-contract-readers): extract request body schemas with Zod integration`

---

### Task 23: T3 `extractResponseShapes` reader

**Files:** `src/tools/nextjs-api-contract-readers.ts`, `tests/parser/nextjs-api-contract-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 22
**Execution routing:** default

- [ ] RED: Write 5 test cases:
  - `return NextResponse.json({ users: [] })` → `{ type: "json", example: { users: [] }, status: 200 }`
  - `return NextResponse.json({ error: "..." }, { status: 400 })` → `status: 400`
  - `return new Response(null, { status: 204 })` → `{ type: "empty", status: 204 }`
  - Multiple returns (success + error) → `response_shapes: [{ status: 200, ... }, { status: 400, ... }]`
  - Return stream → `{ type: "stream" }`
- [ ] GREEN: Implement `extractResponseShapes(tree, source)`:
  - Walk function body for `return_statement` nodes
  - For each return, identify call: `NextResponse.json`, `Response`, `Response.redirect`
  - Extract status code from second arg options if present, default 200
  - Attempt to read first arg shape (object literal = JSON; identifier = unknown)
  - Return array of `{ status, type, body_shape? }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-api-contract-tools.test.ts -t extractResponseShapes`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Response shape extraction
- [ ] Commit: `feat(nextjs-api-contract-readers): extract response shapes and status codes`

---

### Task 24: T3 `nextjsApiContract` orchestrator

**Files:** `src/tools/nextjs-api-contract-tools.ts`, `tests/parser/nextjs-api-contract-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 21, 22, 23
**Execution routing:** deep

- [ ] RED: Write 3 integration tests:
  - Fixture with 3 route handlers (GET/POST/DELETE) → returns 3 entries with correct methods
  - Hybrid fixture (App + Pages Router) → includes both, tagged with `router` field
  - Outputs `completeness_score` based on fraction of handlers with resolved schemas
- [ ] GREEN: Implement `nextjsApiContract(repo, options?)`:
  - Walk `app/api/**/route.{ts,tsx}` and `pages/api/**/*.{ts,js}`
  - For each route file: derive URL path (`deriveUrlPath`), parse, call all readers
  - Build `HandlerShape[]` per handler: `{ method, path, query_params, body_schema, response_shapes, inferred_status_codes, completeness }`
  - Optional `output: "handler_shape"|"openapi31"` param — v1 only supports `handler_shape`
  - Aggregate: `{ handlers, total, completeness_score, limitations: ["Zod-only schema detection", "best-effort response shape inference"] }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-api-contract-tools.test.ts -t orchestrator`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T3 end-to-end API contract extraction
- [ ] Commit: `feat(nextjs-api-contract-tools): implement handler shape extraction orchestrator`

---

### Task 25: T3 registration + formatter + fixture

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/fixtures/nextjs-api-contracts/` (NEW)
**Complexity:** standard
**Dependencies:** Task 24
**Execution routing:** default

- [ ] RED: Fixture test with 3 route handlers + `expected.json` match.
- [ ] GREEN:
  - Create fixture: `app/api/users/route.ts` (GET + POST with Zod body), `app/api/products/[id]/route.ts` (GET + DELETE), `next.config.js`
  - Author `expected.json`
  - Add `formatNextjsApiContract` (renders markdown table: Method | Path | Body | Response | Status)
  - Register tool in `TOOL_DEFINITIONS`, hidden
- [ ] Verify: `npx vitest run tests/parser/nextjs-api-contract-tools.test.ts -t fixture`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T3 registered with fixture
- [ ] Commit: `feat(register-tools): register nextjs_api_contract with fixture`

---

### PR #5 — T4 Boundary Analyzer (Tasks 26-30)

### Task 26: T4 skeleton + types

**Files:** `src/tools/nextjs-boundary-tools.ts` (NEW), `tests/parser/nextjs-boundary-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Skeleton test.
- [ ] GREEN: Create file with types (`ComponentSignals`, `BoundaryEntry`, `NextjsBoundaryResult`) + stub. Export from barrel.
- [ ] Verify: `npx vitest run tests/parser/nextjs-boundary-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T4 skeleton
- [ ] Commit: `feat(nextjs-boundary-tools): add skeleton and types`

---

### Task 27: T4 component signal extraction

**Files:** `src/tools/nextjs-boundary-tools.ts`, `tests/parser/nextjs-boundary-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 26
**Execution routing:** default

- [ ] RED: Write 4 test cases:
  - File with 100 LOC, 5 imports → `{ loc: 100, import_count: 5, third_party_imports: [...], dynamic_import_count: 0 }`
  - File with `import dynamic from "next/dynamic"` + `dynamic(() => import(...))` → `dynamic_import_count: 1`
  - File importing from `./local` + `react` + `@/components` → `third_party_imports: ["react"]` (only truly external)
  - Empty file → all counts 0
- [ ] GREEN: Implement `extractComponentSignals(filePath, source, tree): ComponentSignals`:
  - `loc = source.split('\n').length`
  - Walk `import_statement` for source literals — classify as local (`./`, `../`, `@/`) vs third-party
  - Walk `call_expression` for `dynamic(() => import(...))` calls
  - Return signals
- [ ] Verify: `npx vitest run tests/parser/nextjs-boundary-tools.test.ts -t extractComponentSignals`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: T4 signal extraction per D5
- [ ] Commit: `feat(nextjs-boundary-tools): extract component signals (LOC, imports, dynamic)`

---

### Task 28: T4 ranking score calculator

**Files:** `src/tools/nextjs-boundary-tools.ts`, `tests/parser/nextjs-boundary-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 27
**Execution routing:** default

- [ ] RED: Write 4 test cases:
  - `{ loc: 100, import_count: 5, dynamic_import_count: 0, third_party_imports: ["react", "lodash"] }` → `score = 100 + 5*20 + 0*(-30) + 2*15 = 230`
  - File with dynamic imports gets reduced score: `loc: 100, import: 0, dynamic: 1` → `score = 100 + 0 - 30 + 0 = 70`
  - File with only local imports → `score = loc + import_count*20` (no third-party bonus)
  - Empty file → score 0
- [ ] GREEN: Implement `rankingScore(signals): number`:
  - Formula per D5: `loc + (import_count * 20) + (dynamic_import_count * -30) + (third_party_count * 15)`
  - Pure function, ≤15 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-boundary-tools.test.ts -t rankingScore`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Ranking heuristic per D5
- [ ] Commit: `feat(nextjs-boundary-tools): implement ranking score heuristic`

---

### Task 29: T4 `nextjsBoundaryAnalyzer` orchestrator

**Files:** `src/tools/nextjs-boundary-tools.ts`, `tests/parser/nextjs-boundary-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 27, Task 28
**Execution routing:** deep

- [ ] RED: Write 3 integration tests against `nextjs-app-router` fixture:
  - Returns array of `BoundaryEntry` for all `"use client"` files
  - Top 5 sorted descending by score
  - `client_count` and `total_client_loc` aggregates populated
- [ ] GREEN: Implement `nextjsBoundaryAnalyzer(repo, options?)`:
  - Walk `.tsx`/`.jsx` files in `app/`
  - Filter: only files with `"use client"` (use `scanDirective`)
  - For each: extract signals + compute ranking score
  - Sort by score desc, return top N (default 20)
  - Aggregate: `{ entries, client_count, total_client_loc, largest_offender, limitations: [...] }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-boundary-tools.test.ts -t orchestrator`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T4 end-to-end analysis
- [ ] Commit: `feat(nextjs-boundary-tools): implement boundary analyzer orchestrator`

---

### Task 30: T4 registration + formatter

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/formatters/nextjs-formatter.test.ts`
**Complexity:** standard
**Dependencies:** Task 29
**Execution routing:** default

- [ ] RED: Write 2 tests:
  - `formatNextjsBoundaryAnalyzer(result)` on sample `NextjsBoundaryResult` with 3 entries renders a text table containing headers `"Rank"`, `"Path"`, `"LOC"`, `"Imports"`, `"Score"` and at least 3 data rows (assert via `expect(output).toContain(...)`)
  - `TOOL_DEFINITIONS.find(t => t.name === "nextjs_boundary_analyzer")` returns an entry with `category: "analysis"` and the handler resolves (import + filter check)
- [ ] GREEN: Add `formatNextjsBoundaryAnalyzer(result)` to `formatters.ts` — renders top-N table ordered by score desc. Register tool in `TOOL_DEFINITIONS` with standard schema pattern, hidden (not in CORE_TOOL_NAMES).
- [ ] Verify: `npx vitest run tests/formatters/nextjs-formatter.test.ts -t boundary`
  Expected: `Tests 2 passed (2)`
- [ ] Acceptance: T4 registered with formatter
- [ ] Commit: `feat(register-tools): register nextjs_boundary_analyzer with top-N formatter`

---

### PR #6 — T5 Link Integrity (Tasks 31-34)

### Task 31: T5 skeleton + types

**Files:** `src/tools/nextjs-link-tools.ts` (NEW), `tests/parser/nextjs-link-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 4 (extractLinkHrefs)
**Execution routing:** default

- [ ] RED: Skeleton test.
- [ ] GREEN: Create file. Import `LinkRef` type from `src/utils/nextjs.ts` (single source of truth — do NOT re-declare). Add new types local to this file: `BrokenLink`, `LinkIntegrityResult`. Export stub `nextjsLinkIntegrity(repo, options?)`. Export from barrel.
- [ ] Verify: `npx vitest run tests/parser/nextjs-link-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T5 skeleton
- [ ] Commit: `feat(nextjs-link-tools): add skeleton and types`

---

### Task 32: T5 route pattern matcher

**Files:** `src/tools/nextjs-link-tools.ts`, `tests/parser/nextjs-link-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 31
**Execution routing:** default

- [ ] RED: Write 5 test cases for `matchRoutePattern(href: string, routes: string[])`:
  - `"/about"` vs `["/about", "/contact"]` → match
  - `"/products/123"` vs `["/products/[id]"]` → match (dynamic param)
  - `"/blog/foo/bar"` vs `["/blog/[...slug]"]` → match (catch-all)
  - `"/nonexistent"` vs `["/about"]` → no match
  - `"/products"` vs `["/products/[id]"]` → no match (requires id)
- [ ] GREEN: Implement `matchRoutePattern(href, routes): boolean`:
  - Convert each route pattern to regex: `[id]` → `[^/]+`, `[...slug]` → `.+`, `[[...slug]]` → `.*`
  - Return true if any regex matches href literal
  - Pure function, ≤30 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-link-tools.test.ts -t matchRoutePattern`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Dynamic route matching
- [ ] Commit: `feat(nextjs-link-tools): implement dynamic route pattern matcher`

---

### Task 33: T5 orchestrator with route cross-reference

**Files:** `src/tools/nextjs-link-tools.ts`, `tests/parser/nextjs-link-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 32
**Execution routing:** deep

- [ ] RED: Write 4 integration tests:
  - Fixture with valid Link refs → `broken_count: 0`
  - Fixture with `<Link href="/nonexistent">` → 1 broken link entry
  - Fixture with template literal `href={\`/products/${id}\`}` → 1 unresolved entry
  - Fixture with `router.push("/login")` → resolved or broken correctly
- [ ] GREEN: Implement `nextjsLinkIntegrity(repo, options?)`:
  - Call `nextjsRouteMap(repo)` to get route list
  - Walk all `.tsx`/`.jsx` files in `app/` and `src/app/`
  - For each: parse, call `extractLinkHrefs`, classify each ref via `matchRoutePattern`
  - Aggregate: `{ total_refs, resolved_count, broken_count, unresolved_count, broken: BrokenLink[] }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-link-tools.test.ts -t orchestrator`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: T5 link integrity end-to-end
- [ ] Commit: `feat(nextjs-link-tools): implement link integrity orchestrator`

---

### Task 34: T5 registration + formatter + fixture

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/fixtures/nextjs-links/` (NEW), `tests/fixtures/nextjs-links/expected.json` (NEW)
**Complexity:** standard
**Dependencies:** Task 33
**Execution routing:** default

- [ ] RED: Fixture test asserts tool output matches pre-authored `expected.json` for 5 link references (3 resolved, 1 broken, 1 unresolved).
- [ ] GREEN:
  - Create fixture with `app/nav.tsx` containing: `<Link href="/about">`, `<Link href="/products/123">`, `<Link href="/nonexistent">`, `<Link href={\`/users/${id}\`}>`, `router.push("/dashboard")`. Plus target routes: `app/about/page.tsx`, `app/products/[id]/page.tsx`, `app/dashboard/page.tsx`, `next.config.js`
  - **Author `expected.json` BEFORE running tool** (Q17 anti-echo): `{ "total_refs": 5, "resolved_count": 3, "broken_count": 1, "unresolved_count": 1, "broken": [{ "href": "/nonexistent", "file": "app/nav.tsx" }], "unresolved": [{ "reason": "template_literal", "file": "app/nav.tsx" }] }`
  - Add `formatNextjsLinkIntegrity(result)` to `formatters.ts` rendering a 3-column table (Status / Href / Location)
  - Register tool in `TOOL_DEFINITIONS`, hidden
- [ ] Verify: `npx vitest run tests/parser/nextjs-link-tools.test.ts -t fixture`
  Expected: `Tests 1 passed (1)` + tool output matches `expected.json` exactly
- [ ] Acceptance: T5 registered with frozen ground truth fixture (closes Q17 gap)
- [ ] Commit: `feat(register-tools): register nextjs_link_integrity with link fixture`

---

### PR #7 — T6 Data Flow Analysis (Tasks 35-39)

### Task 35: T6 skeleton + types

**Files:** `src/tools/nextjs-data-flow-tools.ts` (NEW), `tests/parser/nextjs-data-flow-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 2 (extractFetchCalls)
**Execution routing:** default

- [ ] RED: Skeleton test.
- [ ] GREEN: Create file with types (`DataFlowEntry`, `FetchAnalysis`, `NextjsDataFlowResult`) + stub. Export from barrel.
- [ ] Verify: `npx vitest run tests/parser/nextjs-data-flow-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T6 skeleton
- [ ] Commit: `feat(nextjs-data-flow-tools): add skeleton and types`

---

### Task 36: T6 waterfall classifier

**Files:** `src/tools/nextjs-data-flow-tools.ts`, `tests/parser/nextjs-data-flow-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 35
**Execution routing:** deep

- [ ] RED: Write 5 test cases for `classifyFetches(fetches: FetchCall[]): FetchAnalysis`:
  - 2 sequential awaits, no shared identifier → `waterfall: true`
  - 2 awaits where 2nd references 1st's result → `waterfall: false`
  - `Promise.all([fetch, fetch])` → `waterfall: false` (parallel)
  - Single fetch → `waterfall: false`
  - Fetch with `// sequential intentional` comment → `waterfall: false` (opt-out)
- [ ] GREEN: Implement `classifyFetches(fetches)`:
  - Group by scope (same statement_block from extractFetchCalls)
  - For each pair, check `isSequential` flag + comment opt-out
  - Return `{ fetches, waterfall_pairs: [...], has_opt_out: boolean }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-data-flow-tools.test.ts -t classifyFetches`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Waterfall detection per D3
- [ ] Commit: `feat(nextjs-data-flow-tools): implement waterfall classifier`

---

### Task 37: T6 cache directive analyzer

**Files:** `src/tools/nextjs-data-flow-tools.ts`, `tests/parser/nextjs-data-flow-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 36
**Execution routing:** default

- [ ] RED: Write 4 test cases:
  - Fetch with `{ cache: 'force-cache' }` → `cache_strategy: "cached"`
  - Fetch with `{ cache: 'no-store' }` → `cache_strategy: "no-cache"`
  - Fetch with `{ next: { revalidate: 60 } }` → `cache_strategy: "isr-60"`
  - Fetch with no options → `cache_strategy: "default"`
- [ ] GREEN: Implement `classifyCacheStrategy(fetch: FetchCall): CacheStrategy`:
  - Map `cacheOption` field (from extractFetchCalls) to strategy name
  - Pure function, ≤20 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-data-flow-tools.test.ts -t classifyCacheStrategy`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Cache strategy classification
- [ ] Commit: `feat(nextjs-data-flow-tools): classify fetch cache strategies`

---

### Task 38: T6 `nextjsDataFlow` orchestrator

**Files:** `src/tools/nextjs-data-flow-tools.ts`, `tests/parser/nextjs-data-flow-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 36, Task 37
**Execution routing:** deep

- [ ] RED: Write 3 integration tests with inline fixtures:
  - Page with 2 sequential awaits → `waterfall_count: 1`
  - Page with `Promise.all` parallel fetches → `waterfall_count: 0`
  - Project with no data fetching → empty result
- [ ] GREEN: Implement `nextjsDataFlow(repo, options?)`:
  - Walk `app/**/page.tsx` files (optionally scope via `url_path` filter)
  - For each: parse, call `extractFetchCalls`, then `classifyFetches`, then per-fetch `classifyCacheStrategy`
  - Build `DataFlowEntry[]` per page: `{ url_path, fetches: [...], waterfall_count, cache_distribution }`
  - Aggregate: `{ entries, total_pages, total_waterfalls, cache_summary }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-data-flow-tools.test.ts -t orchestrator`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T6 end-to-end data flow analysis
- [ ] Commit: `feat(nextjs-data-flow-tools): implement data flow orchestrator`

---

### Task 39: T6 registration + formatter + fixture

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/fixtures/nextjs-data-flow/` (NEW)
**Complexity:** standard
**Dependencies:** Task 38
**Execution routing:** default

- [ ] RED: Fixture test.
- [ ] GREEN: Fixture with 3 pages (waterfall, parallel, none) + `expected.json`. Formatter. Hidden registration.
- [ ] Verify: `npx vitest run tests/parser/nextjs-data-flow-tools.test.ts -t fixture`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T6 registered
- [ ] Commit: `feat(register-tools): register nextjs_data_flow with fixture`

---

### PR #8 — T8 Middleware Coverage (Tasks 40-43)

### Task 40: T8 skeleton + types

**Files:** `src/tools/nextjs-middleware-coverage-tools.ts` (NEW), `tests/parser/nextjs-middleware-coverage-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none (uses existing traceMiddleware + nextjsRouteMap)
**Execution routing:** default

- [ ] RED: Skeleton test.
- [ ] GREEN: Create file with types (`CoverageEntry`, `SecurityWarning`, `NextjsMiddlewareCoverageResult`) + stub. Export from barrel.
- [ ] Verify: `npx vitest run tests/parser/nextjs-middleware-coverage-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T8 skeleton
- [ ] Commit: `feat(nextjs-middleware-coverage-tools): add skeleton and types`

---

### Task 41: T8 coverage calculator

**Files:** `src/tools/nextjs-middleware-coverage-tools.ts`, `tests/parser/nextjs-middleware-coverage-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 40
**Execution routing:** default

- [ ] RED: Write 4 test cases with inline fixtures:
  - Middleware matching `/admin/:path*` + 3 admin pages + 2 public pages → 3 protected, 2 unprotected
  - No middleware → 0 protected, all unprotected
  - `matcher: [...]` array with 2 patterns → coverage per pattern
  - Computed matcher → fail-open, all routes flagged as protected (per existing traceMiddleware behavior)
- [ ] GREEN: Implement `calculateCoverage(routes, middleware): CoverageMap`:
  - For each route, call existing `traceMiddleware(repoRoot, route.url_path)`, use `applies` field
  - Build map `Map<url_path, boolean>`
  - Return `{ protected: string[], unprotected: string[], total_routes: number }`
- [ ] Verify: `npx vitest run tests/parser/nextjs-middleware-coverage-tools.test.ts -t calculateCoverage`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: Coverage calculation
- [ ] Commit: `feat(nextjs-middleware-coverage-tools): implement coverage calculator`

---

### Task 42: T8 admin route security flagging

**Files:** `src/tools/nextjs-middleware-coverage-tools.ts`, `tests/parser/nextjs-middleware-coverage-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 41
**Execution routing:** default

- [ ] RED: Write 3 test cases for `flagSecurityWarnings(coverage: CoverageMap, options)`:
  - `/admin/dashboard` unprotected → `{ severity: "high", route: "/admin/dashboard", reason: "admin route without middleware" }`
  - `/admin/users` protected → no warning
  - Custom `flag_admin_prefix: "/dashboard"` option → `/dashboard/settings` unprotected → warning
- [ ] GREEN: Implement `flagSecurityWarnings(coverage, options): SecurityWarning[]`:
  - Default prefixes: `/admin`, `/dashboard` (configurable)
  - For each unprotected route matching prefix → emit warning with `severity: "high"`
  - Return sorted by severity
- [ ] Verify: `npx vitest run tests/parser/nextjs-middleware-coverage-tools.test.ts -t flagSecurityWarnings`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: Security warnings for admin routes
- [ ] Commit: `feat(nextjs-middleware-coverage-tools): flag unprotected admin routes`

---

### Task 43a: T8 `nextjsMiddlewareCoverage` orchestrator

**Files:** `src/tools/nextjs-middleware-coverage-tools.ts`, `tests/parser/nextjs-middleware-coverage-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 41, Task 42
**Execution routing:** deep

- [ ] RED: Write 2 integration tests with inline fixtures:
  - Fixture with middleware + 3 admin routes + 2 public routes → returns coverage map with correct protected/unprotected classification + security warnings array
  - Fixture with no middleware.ts → all routes unprotected, admin routes emit high-severity warnings
- [ ] GREEN: Implement `nextjsMiddlewareCoverage(repo, options?)`:
  - Call `nextjsRouteMap(repo)` to get routes
  - Call `calculateCoverage(routes, middleware)` from Task 41
  - Call `flagSecurityWarnings(coverage, options)` from Task 42
  - Return `{ coverage: {...}, warnings: [...], total: N }`
  - ≤50 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-middleware-coverage-tools.test.ts -t orchestrator`
  Expected: `Tests 2 passed (2)`
- [ ] Acceptance: T8 orchestrator complete
- [ ] Commit: `feat(nextjs-middleware-coverage-tools): implement coverage orchestrator`

---

### Task 43b: T8 registration + formatter + fixture

**Files:** `src/register-tools.ts`, `src/formatters.ts`, `tests/fixtures/nextjs-middleware-coverage/` (NEW)
**Complexity:** standard
**Dependencies:** Task 43a
**Execution routing:** default

- [ ] RED: Fixture test — 4 routes (2 admin, 2 public) + middleware + `expected.json`. Assert tool output matches expected.
- [ ] GREEN:
  - Create fixture directory with `app/admin/dashboard/page.tsx`, `app/admin/users/page.tsx`, `app/page.tsx`, `app/about/page.tsx`, `middleware.ts` with `matcher: ["/admin/:path*"]`, `next.config.js`
  - Author `expected.json` BEFORE running tool: `{ protected: ["/admin/dashboard", "/admin/users"], unprotected: ["/", "/about"], warnings: [] }`
  - Add `formatNextjsMiddlewareCoverage` to `formatters.ts` (table: URL / Protected / Severity)
  - Register tool in `TOOL_DEFINITIONS`, hidden (not in CORE_TOOL_NAMES)
- [ ] Verify: `npx vitest run tests/parser/nextjs-middleware-coverage-tools.test.ts -t fixture`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T8 registered with frozen ground truth fixture (closes P7-2 gap)
- [ ] Commit: `feat(register-tools): register nextjs_middleware_coverage with security fixture`

---

### PR #9 — T11 Framework Audit Meta-Tool (Tasks 44-50)

### Task 44: T11 `NextjsAuditCache` shared cache

**Files:** `src/utils/nextjs-audit-cache.ts` (NEW), `tests/utils/nextjs-audit-cache.test.ts` (NEW)
**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep

- [ ] RED: Write 5 test cases:
  - Cache hit returns same promise for concurrent calls
  - Cache hit after first resolve returns same resolved value
  - TTL eviction after 60s (fake timers)
  - Eviction doesn't affect in-flight promises
  - Cache clear removes all entries
- [ ] GREEN: Implement `NextjsAuditCache` class:
  - Properties: `parseFileCache: Map<string, { promise: Promise<Tree>, expires: number }>`, `walkCache: Map<string, string[]>`
  - Methods: `getParsedFile(path)`, `getWalk(root, pattern)`, `clear()`, `size()`
  - TTL from env var `NEXTJS_AST_CACHE_TTL_MS`, default 60000
  - Promise-sharing pattern (not result caching)
  - ≤60 lines
- [ ] Verify: `npx vitest run tests/utils/nextjs-audit-cache.test.ts`
  Expected: `Tests 5 passed (5)`
- [ ] Acceptance: Shared cache with TTL eviction per D8
- [ ] Commit: `feat(utils): add NextjsAuditCache with TTL eviction`

---

### Task 45: T11 skeleton + types

**Files:** `src/tools/nextjs-framework-audit-tools.ts` (NEW), `tests/parser/nextjs-framework-audit-tools.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** Task 44
**Execution routing:** default

- [ ] RED: Skeleton test.
- [ ] GREEN: Create file with types (`AuditDimension`, `FrameworkAuditResult`, `AuditSummary`) + stub `frameworkAudit(repo, options?)`. Export from barrel.
- [ ] Verify: `npx vitest run tests/parser/nextjs-framework-audit-tools.test.ts -t exports`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: T11 skeleton
- [ ] Commit: `feat(nextjs-framework-audit-tools): add skeleton and types`

---

### Task 46: T11 tool dispatcher

**Files:** `src/tools/nextjs-framework-audit-tools.ts`, `tests/parser/nextjs-framework-audit-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 45, 11 (T1 registered), 19 (T2 registered), 25 (T3 registered), 30 (T4 registered), 34 (T5 registered), 39 (T6 registered), 43b (T8 registered) — dispatcher imports each tool's public function
**Execution routing:** deep

- [ ] RED: Write 3 test cases with mocked sub-tool responses:
  - Call with default `tools: ["components", "routes", "metadata", "security", "api_contract", "boundary", "links", "data_flow", "middleware_coverage"]` → invokes all 9 sub-tools
  - Call with `tools: ["metadata"]` → only invokes T1
  - One sub-tool throws → other sub-tools still complete, error captured in `tool_errors[]`
- [ ] GREEN: Implement dispatcher:
  - Accept `options.tools?: string[]` (default: all 9)
  - Sequential invocation with shared `NextjsAuditCache` instance
  - Each sub-tool wrapped in try-catch, errors to `tool_errors: [{ tool, error }]`
  - Returns raw sub-tool results in `sub_results` field
  - ≤60 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-framework-audit-tools.test.ts -t dispatcher`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T11 dispatches to sub-tools with isolation
- [ ] Commit: `feat(nextjs-framework-audit-tools): implement sub-tool dispatcher`

---

### Task 47: T11 aggregate scoring

**Files:** `src/tools/nextjs-framework-audit-tools.ts`, `tests/parser/nextjs-framework-audit-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 46
**Execution routing:** deep

- [ ] RED: Write 4 test cases for `aggregateScores(sub_results): AuditSummary`:
  - All sub-tools return perfect scores → aggregate 100, grade "excellent"
  - Metadata 50 + security 80 + others 100 → weighted aggregate ~85
  - Missing sub-tool result → skipped from weighting
  - All sub-tools fail → aggregate 0, grade "poor"
- [ ] GREEN: Implement `aggregateScores(sub_results)`:
  - Define per-dimension weight: metadata 15, security 25, components 15, routes 10, api_contract 10, boundary 10, links 5, data_flow 5, middleware_coverage 5
  - Normalize each sub-tool result to 0-100 (if not already scored — e.g., link integrity: `resolved / (resolved + broken)` × 100)
  - Return `{ overall_score, grade, dimensions: Record<string, {score, weight, contribution}>, top_issues: [...] }`
  - ≤60 lines
- [ ] Verify: `npx vitest run tests/parser/nextjs-framework-audit-tools.test.ts -t aggregateScores`
  Expected: `Tests 4 passed (4)`
- [ ] Acceptance: T11 unified scoring
- [ ] Commit: `feat(nextjs-framework-audit-tools): implement weighted aggregate scoring`

---

### Task 48: T11 registration + formatter + shortener

**Files:** `src/tools/nextjs-framework-audit-tools.ts`, `src/register-tools.ts`, `src/formatters.ts`, `src/formatters-shortening.ts`
**Complexity:** complex
**Dependencies:** Task 47, 11, 19, 25, 30, 34, 39, 43b (all sub-tools must be registered for framework_audit dispatcher to resolve them)
**Execution routing:** deep

- [ ] RED: Test that full formatter renders dimensions table; compact formatter shows only score + top issues.
- [ ] GREEN:
  - Wire dispatcher + aggregator into `frameworkAudit` public function
  - Add `formatFrameworkAudit` (full table with dimensions + sub-results)
  - Add `formatFrameworkAuditCompact/Counts` (top-line score + top 5 issues)
  - Register shortener
  - Register tool in `TOOL_DEFINITIONS`, add to `CORE_TOOL_NAMES` (visible — flagship meta-tool)
- [ ] Verify: `npx vitest run tests/formatters/ -t frameworkAudit`
  Expected: `Tests 3 passed (3)`
- [ ] Acceptance: T11 visible as core tool
- [ ] Commit: `feat(register-tools): register framework_audit as core meta-tool`

---

### Task 49: T11 integration test against real fixture

**Files:** `tests/parser/nextjs-framework-audit-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 48, all fixtures from PRs 2-8
**Execution routing:** deep

- [ ] RED: Write 2 integration tests:
  - Run full `frameworkAudit` on `tests/fixtures/nextjs-app-router/` → returns `overall_score ≥ 0`, `dimensions` has entries for all 9 tools, no `tool_errors`
  - Run with subset `tools: ["metadata", "boundary"]` → only 2 dimensions populated
- [ ] GREEN: No production changes — this task only adds integration tests
- [ ] Verify: `npx vitest run tests/parser/nextjs-framework-audit-tools.test.ts -t integration`
  Expected: `Tests 2 passed (2)`
- [ ] Acceptance: T11 integration validated
- [ ] Commit: `test(framework-audit): add end-to-end integration tests`

---

### Task 50: T11 memory regression test

**Files:** `tests/parser/nextjs-framework-audit-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 49
**Execution routing:** default

- [ ] RED: Write 1 memory test:
  - Synthetic 50-file fixture in tmpdir (20 components, 20 routes, 10 api routes)
  - Run full `frameworkAudit`
  - Measure peak RSS via `process.memoryUsage().rss` before and after
  - Assert peak increase < 200MB
- [ ] GREEN: No production changes — test only
- [ ] Verify: `npx vitest run tests/parser/nextjs-framework-audit-tools.test.ts -t memory`
  Expected: `Tests 1 passed (1)`, peak memory logged
- [ ] Acceptance: Memory regression ceiling enforced
- [ ] Commit: `test(framework-audit): add memory regression ceiling test`

---

### Task 51: Update docs with new tool count

**Files:** `CLAUDE.md`, `README.md`, `src/instructions.ts`, `tests/instructions.test.ts`
**Complexity:** standard
**Dependencies:** Task 11, 19, 25, 30, 34, 39, 43, 48 (all registration tasks)
**Execution routing:** default

- [ ] RED: Update `tests/instructions.test.ts` to assert new tool count. Initial run fails (count mismatch).
- [ ] GREEN: Count actual tools in `TOOL_DEFINITIONS` after all registrations. Update count references:
  - Current (pre-plan): 108 total / 44 core
  - After this plan: +11 tools (Q1, Q2, Q3 extend existing so no count change for them; T1-T6, T8, T11 = 8 new tools; with T1 and T11 as core = 2 new core)
  - New total: 116 / 46 core
  - Update `CLAUDE.md`, `README.md`, `src/instructions.ts`
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: `Tests 1 passed (1)`
- [ ] Acceptance: Tool counts synchronized
- [ ] Commit: `docs: bump tool count to 116 for Next.js tier-1 additions`

---

## Task Count Summary

| PR | Tasks | Complex | Standard |
|----|-------|---------|----------|
| PR #1 Shared helpers + Q1/Q2/Q3 | 7 | 3 | 4 |
| PR #2 T1 metadata audit | 5 | 2 | 3 |
| PR #3 T2 security audit | 7 | 5 | 2 |
| PR #4 T3 API contract | 6 | 3 | 3 |
| PR #5 T4 boundary analyzer | 5 | 1 | 4 |
| PR #6 T5 link integrity | 4 | 1 | 3 |
| PR #7 T6 data flow | 5 | 2 | 3 |
| PR #8 T8 middleware coverage | 5 | 1 | 4 |
| PR #9 T11 framework_audit + docs | 8 | 5 | 3 |
| **Total** | **52** | **23** | **29** |

## Dependency Summary

- **PR #1** serialized: Task 1 → 2 → 3 → 4 (all edit `src/utils/nextjs.ts`). Tasks 5, 6, 7 independent.
- **PR #2** needs Task 1 (parseMetadataExport)
- **PR #3** needs Task 3 (extractZodSchema)
- **PR #4** needs Task 3 (extractZodSchema) — PR #3 and PR #4 can overlap but share a file (readers)
- **PR #5** independent (uses existing detectSignals)
- **PR #6** needs Task 4 (extractLinkHrefs)
- **PR #7** needs Task 2 (extractFetchCalls)
- **PR #8** independent (uses existing traceMiddleware)
- **PR #9** needs ALL prior PRs (imports each tool)

## Verification Commands (Cumulative)

```bash
# Type check
npx tsc --noEmit

# Full test suite (no regressions)
npx vitest run

# PR-specific focused run
npx vitest run tests/parser/nextjs-helpers.test.ts tests/parser/nextjs-*-tools.test.ts tests/utils/nextjs-audit-cache.test.ts

# Accuracy validation scripts (if applicable)
npx tsx scripts/validate-nextjs-accuracy.ts
npx tsx scripts/validate-nextjs-route-count.ts

# Memory regression
npx vitest run tests/parser/nextjs-framework-audit-tools.test.ts -t memory
```

## Open Questions (for user review)

None — all Tech Lead and QA questions resolved during planning phase. Decisions D1-D10 captured in Technical Decisions section.
