# Implementation Plan: Astro 5 Completion for CodeSift MCP

**Spec:** inline — no spec
**spec_id:** none
**planning_mode:** inline
**source_of_truth:** inline brief (audit findings 2026-05-04)
**plan_revision:** 3
**status:** Approved
**Approved:** 2026-05-04T00:00:00Z (interactive — user "okay lec")
**Created:** 2026-05-04
**Tasks:** 16 (Task 4 split into 4 + 4b after reviewer feedback)
**Estimated complexity:** 10 standard, 6 complex

---

## Architecture Summary

Existing Astro foundation (9 tools, plan 2026-04-11 approved/shipped) covers islands, hydration (AH01–AH12), routes, actions (AA01–AA06), content collections (Astro 5 Content Layer), config, migration (AM01–AM10), audit meta-tool. This plan adds **6 new sub-tools + 1 migration extension + auto-load + audit gate extension** to close the Astro 5 gap.

**New sub-tools** (all in `src/tools/`):
- `astro-middleware.ts` — parse `src/middleware.ts` (`onRequest`, `sequence()`, route guards, ordering)
- `astro-sessions.ts` — Astro 5 Sessions API (`Astro.session.*` usage + adapter compat)
- `astro-db-audit.ts` — Astro DB (`db/config.ts` `defineTable`, references, N+1, missing indexes)
- `astro-env-validator.ts` — Astro 5 `astro:env` (envField schema vs `import.meta.env.*` / `astro:env/{client,server}` imports)
- `astro-image-audit.ts` — raw `<img>` vs `<Image>`/`<Picture>`, alt, `getImage()` tracking
- `astro-svg-components.ts` — `*.svg?component` imports + Astro 5 native SVG component patterns

**Modified files:**
- `src/tools/astro-audit.ts` — extend `AstroAuditResult.gates` with 6 new fields, fan out to new sub-tools, rebalance `deriveOverallScore` for 13 gates
- `src/tools/astro-migration.ts` — append AM11–AM14 (Vite 6 + Rollup 5 breaking changes)
- `src/register-tools.ts` — `FRAMEWORK_TOOL_GROUPS` entry for `astro.config.{mjs,ts,cjs,js}`; `TOOL_DEFINITIONS` for 6 new tools (NOT in `CORE_TOOL_NAMES` — only meta-tool stays core)
- `src/tools/astro-helpers.ts` — NEW shared helpers extracted from `astro-content-collections.ts` (`stripQuotes`, `getProperty`, `classifyZodField`)

**Dependency direction:** all new sub-tools → `astro-helpers.ts` + `parseAstroTemplate` + `extractAstroConventions` + `getCodeIndex`. `astro-audit.ts` orchestrates all sub-tools in parallel via `tryImportOptionalTool`.

## Technical Decisions

- **Pattern:** Two-function split (`fooFromIndex(index)` testable core + `astroFooHandler(args)` MCP handler), Zod-validated input, issue-based result type, tree-sitter AST walking where structure matters, `parseAstroTemplate` regex pass for HTML scans.
- **Reuse mandatory (CQ14):** `parseAstroTemplate` (`src/parser/astro-template.ts`), `extractAstroConventions` (`src/tools/astro-config.ts`), `extractAstroSymbols` (`src/parser/extractors/astro.ts`). Extract `stripQuotes`, `getProperty`, `classifyZodField` from `astro-content-collections.ts` into shared `astro-helpers.ts` first (Task 1 prerequisite).
- **No new dependencies.** Use existing `tree-sitter`, `zod`, `web-tree-sitter`.
- **Meta-tool over many tools:** Extend `astro_audit.gates` (NestJS `nest_audit` precedent). Sub-tools registered but hidden — only `astro_audit` in `CORE_TOOL_NAMES`. Discoverable via `describe_tools`.
- **Auto-load:** File-based via `FRAMEWORK_TOOL_GROUPS` (PHP/Kotlin/Python precedent), keys: `astro.config.mjs`, `astro.config.ts`, `astro.config.cjs`, `astro.config.js`.
- **DB audit standalone** (Astro DB-specific, not folded into `dependency_audit`).
- **SVG via dedicated tool** (extractor change deferred unless needed).
- **AM11–AM14 inline** in `astro-migration.ts` (no new file).

## Quality Strategy

- **Framework:** Vitest. Conventions: `tests/tools/astro-<name>.test.ts`, tmpdir fixtures, `beforeAll(initParser())`, `beforeEach` rmSync cleanup. Reference: `tests/tools/astro-actions.test.ts`.
- **Activated CQ gates:**
  - **CQ3** (validation): all tools accept MCP input → Zod schema with explicit types/enums.
  - **CQ6** (unbounded): file walks need `maxFiles=5000` cap (mirror `astro-migration.ts`).
  - **CQ8** (errors): all `readFile`/parse via `safeReadFile` or try/catch → empty result + warning, never throw.
  - **CQ14** (duplication): mandate import of `astro-helpers.ts` + `parseAstroTemplate` + `extractAstroConventions`.
- **Risk-driven coverage:** Each tool gets (1) empty project → graceful pass, (2) malformed input → graceful error, (3) happy path with fixture, (4) astro_audit integration showing the new gate.
- **Score rebalance test:** explicit assertions on `deriveOverallScore` boundaries with 13 gates (1 fail vs 2 fails vs 3 warns) before/after.

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| G1 | Auto-load Astro tools on `astro.config.*` detection | deliverable | Task 13 | FRAMEWORK_TOOL_GROUPS entry |
| G2 | `astro_middleware` tool — parse middleware.ts | deliverable | Task 2 | onRequest/sequence/guards |
| G3 | `astro_sessions` tool — Astro 5 Sessions API | deliverable | Task 3 | adapter compat |
| G4 | `astro_db_audit` tool — Astro DB schema + N+1 | deliverable | Task 4, Task 4b | 4=schema parser; 4b=N+1 + missing-index detectors |
| G5 | `astro_env_validator` tool — astro:env schema vs usage | deliverable | Task 5 | envField type cross-check |
| G6 | `astro_image_audit` tool — `<img>` vs `<Image>`, alt | deliverable | Task 6 | parseAstroTemplate reuse |
| G7 | `astro_svg_components` tool — *.svg?component | deliverable | Task 7 | Astro 5 native SVG |
| G8 | AM11–AM14 in astro-migration.ts | deliverable | Task 8 | Vite 6 / Rollup 5 |
| G9 | Extend `astro_audit.gates` with 6 fields + sections | deliverable | Task 9 | result type only |
| G10 | Wire 6 sub-tools into astroAudit() orchestration | deliverable | Task 10 | tryImportOptionalTool fan-out |
| G11 | Rebalance `deriveOverallScore` for 13 gates | deliverable | Task 11 | scale or retune thresholds |
| G12 | Register 6 tools in TOOL_DEFINITIONS (hidden) | deliverable | Task 12 | NOT CORE |
| G13 | Foundation: extract astro-helpers.ts | deliverable | Task 1 | DRY for new tools |
| G14 | astro_audit integration test (13 gates) | deliverable | Task 14 | full meta-tool flow |
| G15 | End-to-end smoke fixture | deliverable | Task 15 | full Astro 5 project fixture |
| C1 | No new npm dependencies | constraint | Task 1–8 | reuse tree-sitter/zod |
| C2 | File limits: utils ≤100, services ≤300 LOC | constraint | Task 1, Task 4, Task 4b | db-audit pre-split into schema-parser + detectors |
| C3 | Reuse helpers (CQ14) | constraint | Task 1 prereq for Tasks 2–7 + Task 4b | mandate imports |
| C4 | maxFiles=5000 cap on walks (CQ6) | constraint | Tasks 4, 5, 6, 7 | walkDirectory |
| C5 | Graceful file/parse errors (CQ8) | constraint | Tasks 2–8 | safeReadFile + try/catch |
| C6 | Zod input validation (CQ3) | constraint | Task 12 | TOOL_DEFINITIONS schemas |
| C7 | Only meta-tool in CORE_TOOL_NAMES | constraint | Task 12 | sub-tools discoverable |

## Review Trail

- Plan reviewer: revision 1 → ISSUES FOUND (CRITICAL: Task 4 conditional split; WARNING: Task 5 dependency ambiguity; INFO: Task 13 NEW marker)
- Plan reviewer: revision 2 → addressed by splitting Task 4 into 4 (schema parser) + 4b (N+1/missing-index detectors); Task 5 committed to independent tree-sitter parse (no extractAstroConventions extension); Task 13 test file marked NEW
- Cross-model validation: revision 2 → 1 CRITICAL (Task 12 deps missed Task 4b), 2 WARNINGs (Task 9 false-coupled to Task 8; Task 10 task bloat — full fixture redundant with Task 14), 2 INFOs (SMOKE3 wording; C3 row missing 4b)
- Plan reviewer: revision 3 → addressed: Task 12 deps now `Tasks 2–7, 4b`; Task 9 deps narrowed to `Tasks 2–7, 4b` (Task 8 dropped — migration codes don't shape gate types); Task 10 trimmed to mock/stub-based wiring (full fixture stays in Task 14); SMOKE3 wording updated to "after Tasks 1–15"; C3 row extended
- Status gate: Approved (user 2026-05-04)

---

## Task Breakdown

### Task 1: Extract `astro-helpers.ts` shared utilities
**Files:** `src/tools/astro-helpers.ts` (NEW), `src/tools/astro-content-collections.ts` (refactor imports), `tests/tools/astro-helpers.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: in `tests/tools/astro-helpers.test.ts` assert: `stripQuotes('"a"') === 'a'`, `getProperty(astNode, 'name')` returns the matching property node, `classifyZodField(node)` returns `{ type: 'string', required: true }` for `z.string()` and `{ type: 'number', required: false }` for `z.number().optional()`.
- [ ] GREEN: extract from `astro-content-collections.ts` into `astro-helpers.ts`: `stripQuotes`, `getProperty(node, name)`, `classifyZodField(node)`. Re-export them from `astro-content-collections.ts` for back-compat OR refactor its imports to point at the new module. Keep file ≤100 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-helpers.test.ts tests/tools/astro-content-collections.test.ts`
  Expected: `Tests: passed`, exit code 0. Existing content-collections tests still pass (no regression).
- [ ] Acceptance Proof:
  - G13 / C3: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-helpers.test.ts -t "stripQuotes|getProperty|classifyZodField"`. Expected: 3 tests pass. Artifact: `.zuvo/proofs/task-1-G13.txt`.
  - C2: file `src/tools/astro-helpers.ts` ≤ 100 lines. Proof: `wc -l src/tools/astro-helpers.ts | awk '{ exit ($1 <= 100) ? 0 : 1 }'`. Expected: exit 0. Artifact: `.zuvo/proofs/task-1-C2.txt`.
- [ ] Commit: `extract astro-helpers shared utilities (stripQuotes, getProperty, classifyZodField)`

---

### Task 2: `astro_middleware` tool
**Files:** `src/tools/astro-middleware.ts` (NEW), `tests/tools/astro-middleware.test.ts` (NEW), `tests/fixtures/astro-middleware/` (fixtures)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep

- [ ] RED: in `tests/tools/astro-middleware.test.ts`, build a tmpdir Astro project with `src/middleware.ts` exporting `export const onRequest = sequence(authGuard, logger);`. Call `auditMiddlewareFromIndex(index)` and assert: `result.handlers` lists `onRequest`, `result.sequence` lists `['authGuard','logger']` in order, `result.routes_protected_count >= 0`, `result.issues` is array. Add empty-project case (`result.handlers === []`, `issues === []`). Add malformed-syntax case → `result.issues[0].code === 'MW00'` (parse error), no throw.
- [ ] GREEN: create `auditMiddlewareFromIndex(index, opts?)` and `astroMiddlewareAudit(args)`. Use tree-sitter to parse `src/middleware.{ts,js}`, find `export const onRequest`, detect `sequence(...)` calls and arg order, identify guard patterns (early `return new Response()`, `redirect()`). Use `safeReadFile` (CQ8). Reuse `getProperty` from `astro-helpers`. Issue codes MW00 (parse fail), MW01 (no onRequest export), MW02 (sequence ordering ambiguous), MW03 (guard without redirect/throw). File target ≤180 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-middleware.test.ts`
  Expected: all tests pass, exit 0.
- [ ] Acceptance Proof:
  - G2: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-middleware.test.ts -t "happy path|empty|malformed"`. Expected: 3+ tests pass. Artifact: `.zuvo/proofs/task-2-G2.txt`.
  - C5: graceful malformed input. Proof: `npx vitest run tests/tools/astro-middleware.test.ts -t "malformed"`. Expected: returns `{ issues: [{code:'MW00'}] }`, no throw. Artifact: `.zuvo/proofs/task-2-C5.txt`.
- [ ] Commit: `add astro_middleware tool — parses src/middleware.ts onRequest/sequence/guards`

---

### Task 3: `astro_sessions` tool
**Files:** `src/tools/astro-sessions.ts` (NEW), `tests/tools/astro-sessions.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: build tmpdir fixture with `astro.config.mjs` having `experimental: { session: true }` + adapter `@astrojs/node`, plus a page using `Astro.session.set('user', ...)`. Assert `auditSessionsFromIndex(index)` returns: `adapter: '@astrojs/node'`, `config_found: true`, `usage_count >= 1`, `adapter_compatibility['@astrojs/node'] === true`, `issues === []`. Add cases: (a) Sessions used without config → `issues[0].code === 'SE01'`; (b) Unsupported adapter (e.g., `@astrojs/cloudflare` with kv missing) → `SE02`.
- [ ] GREEN: `auditSessionsFromIndex(index)` calls `extractAstroConventions` (reuse) for adapter + experimental flags. Walk `.astro`/`.ts`/`.tsx` files via `walkDirectory(maxFiles:5000)`, regex+text scan for `Astro.session.` and `context.session.`. Build adapter compat table (constants: node=true, vercel=true, cloudflare=requires kv config, deno=true, netlify=requires storage). File ≤160 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-sessions.test.ts`
  Expected: all tests pass.
- [ ] Acceptance Proof:
  - G3: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-sessions.test.ts`. Expected: tests pass, `result.adapter` and `result.adapter_compatibility` populated. Artifact: `.zuvo/proofs/task-3-G3.txt`.
  - C4: file cap. Proof: `grep -n "maxFiles" src/tools/astro-sessions.ts`. Expected: matches `maxFiles: 5000` or equivalent. Artifact: `.zuvo/proofs/task-3-C4.txt`.
- [ ] Commit: `add astro_sessions tool — Astro 5 Sessions API usage + adapter compatibility`

---

### Task 4: `astro_db_audit` schema parser
**Files:** `src/tools/astro-db-parser.ts` (NEW — schema extraction only), `tests/tools/astro-db-parser.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: in `tests/tools/astro-db-parser.test.ts`, build a tmpdir fixture with `db/config.ts` containing `defineTable({ columns: { id: column.number({ primaryKey:true }), authorId: column.text({ references: () => Author.columns.id }) } })` for two tables (Comment + Author). Call `parseAstroDbSchema(content)`. Assert: returns `{ tables: TableDef[] }` where `tables.length === 2`, each table has `name`, `columns: ColumnDef[]`, each column has `name`, `type`, `primaryKey?`, `references?`, `index?`, `optional?`. Empty `db/config.ts` → `tables: []`. Malformed input → `{ tables: [], issues: [{ code: 'DB00' }] }`, no throw.
- [ ] GREEN: `parseAstroDbSchema(content: string): { tables: TableDef[]; issues: Issue[] }`. Tree-sitter parse, walk for `defineTable(...)` calls, extract `columns` object via `getProperty` (Task 1 helper), extract `column.<type>({ ... })` arg property values via `classifyZodField`-style helper. Use `safeReadFile` (CQ8). File target ≤180 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-db-parser.test.ts && wc -l src/tools/astro-db-parser.ts | awk '{ exit ($1 <= 200) ? 0 : 1 }'`
  Expected: tests pass; parser file ≤200 LOC.
- [ ] Acceptance Proof:
  - G4 (parser portion) / C2: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-db-parser.test.ts -t "tables|columns|references|malformed"`. Expected: 4+ tests pass; result contains structurally typed `tables` array with column metadata. Artifact: `.zuvo/proofs/task-4-G4.txt`.
  - C2: file size. Proof: `wc -l src/tools/astro-db-parser.ts | awk '{ exit ($1 <= 200) ? 0 : 1 }'`. Expected: exit 0. Artifact: `.zuvo/proofs/task-4-C2.txt`.
- [ ] Commit: `add astro-db-parser — defineTable schema extraction (parser only)`

---

### Task 4b: `astro_db_audit` detectors (N+1 + missing index + handler)
**Files:** `src/tools/astro-db-audit.ts` (NEW — orchestrates parser + detectors + handler), `tests/tools/astro-db-audit.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 4
**Execution routing:** deep

- [ ] RED: in `tests/tools/astro-db-audit.test.ts`, fixture with: `db/config.ts` (Author + Comment with FK), source files containing (a) `for (const post of posts) { db.select().from(Author).where(...) }` (N+1 pattern), (b) FK column without explicit index. Call `auditDbFromIndex(index)`. Assert: `tables.length === 2` (delegates to parser), `n_plus_one[0].file` and `n_plus_one[0].line` set + `code === 'DB02'`, `missing_indexes` includes the FK column with `code === 'DB03'`, `issues` aggregated. Add: project with no `db.select` calls → `n_plus_one: []`. Malformed parser output (cycle) → handled, no infinite loop, `issues[0].code === 'DB04'`.
- [ ] GREEN: `auditDbFromIndex(index)` calls `parseAstroDbSchema` (Task 4) for schema, then walks source via `walkDirectory({maxFiles:5000})` (CQ6). For each `.ts/.tsx/.astro` file: regex+AST find `db.select|db.insert|db.update|db.delete` call sites; check enclosing function body for `for|while|forEach` ancestor → flag DB02. Cross-tabulate FK columns from schema vs explicit `index: true` flags → DB03. Single visited-set pass for cycle safety → DB04 if cycle detected. Issue codes: DB02 (N+1), DB03 (missing index), DB04 (cycle in references). File target ≤220 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-db-audit.test.ts && wc -l src/tools/astro-db-audit.ts | awk '{ exit ($1 <= 250) ? 0 : 1 }'`
  Expected: tests pass; orchestrator file ≤250 LOC.
- [ ] Acceptance Proof:
  - G4 (detectors portion): Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-db-audit.test.ts -t "n_plus_one|missing_indexes|cycle"`. Expected: 3+ tests pass with `DB02`, `DB03`, `DB04` codes asserted. Artifact: `.zuvo/proofs/task-4b-G4.txt`.
  - C4: file cap. Proof: `grep -n "maxFiles" src/tools/astro-db-audit.ts`. Expected: matches `maxFiles: 5000`. Artifact: `.zuvo/proofs/task-4b-C4.txt`.
- [ ] Commit: `add astro_db_audit detectors — N+1 pattern, missing index, cycle safety`

---

### Task 5: `astro_env_validator` tool
**Files:** `src/tools/astro-env-validator.ts` (NEW), `tests/tools/astro-env-validator.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 1
**Execution routing:** deep

- [ ] RED: tmpdir fixture with `astro.config.mjs` declaring `env: { schema: { API_URL: envField.string({ context: 'server', access: 'secret' }), PUBLIC_KEY: envField.string({ context: 'client', access: 'public' }) } }`. Source files import from `astro:env/server` (API_URL) and use `import.meta.env.PUBLIC_KEY`. Plus a page that uses `import.meta.env.MISSING_VAR`. Assert `auditEnvFromIndex(index)`: `declared_vars.length === 2`, `used_vars` includes both correct refs, `missing` includes `MISSING_VAR` (code EV01), `unused` empty, `type_errors` empty. Add: client-only var used in server context → EV02.
- [ ] GREEN: `auditEnvFromIndex(index)` does an INDEPENDENT tree-sitter parse of `astro.config.{mjs,ts,cjs,js}` — does NOT extend `extractAstroConventions` (avoids cross-task coupling). Walk the parsed AST for `defineConfig({ env: { schema: { ... } } })` argument; for each property in `schema`, extract its `envField.<type>(...)` call and read `context`/`access`/`default` props using `getProperty` + `classifyZodField` (Task 1 helpers). Then walk source files (`walkDirectory({maxFiles:5000})`, CQ6): regex-scan for `import.meta.env.<NAME>` + imports from `astro:env/client` / `astro:env/server`. Cross-tabulate declared vs used. Codes: EV01 (used not declared), EV02 (wrong context — client var in server-only file or vice versa), EV03 (declared not used), EV04 (type mismatch). File ≤200 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-env-validator.test.ts`
  Expected: tests pass.
- [ ] Acceptance Proof:
  - G5: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-env-validator.test.ts -t "missing|unused|context"`. Expected: 3+ tests pass with EV codes asserted. Artifact: `.zuvo/proofs/task-5-G5.txt`.
- [ ] Commit: `add astro_env_validator tool — astro:env schema vs import.meta.env usage`

---

### Task 6: `astro_image_audit` tool
**Files:** `src/tools/astro-image-audit.ts` (NEW), `tests/tools/astro-image-audit.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: tmpdir with `.astro` files containing: (a) `<img src="/a.png">` (no alt), (b) `<Image src={...} alt="hi">`, (c) `<img src="/b.png" alt="">` (empty alt), (d) `<script>const html = '<img>';</script>` (must NOT match — pathological). Assert `auditImagesFromIndex(index)`: `raw_img_count === 2` (a + c, NOT script string), `missing_alt: [{file: a.astro, line: N}]`, `empty_alt: [{file: c.astro, ...}]`, `image_component_count === 1`, `getImage_calls === []`. Add: project with no images → all empty + pass.
- [ ] GREEN: `auditImagesFromIndex(index)` walks `.astro`/`.tsx`/`.jsx` via `walkDirectory({maxFiles:5000})`. For `.astro`, call `parseAstroTemplate(source)` (reuse) — its template section already strips `<script>` blocks. Iterate parsed nodes for `tag === 'img'` (raw) vs `tag === 'Image' | 'Picture'`. Regex scan source for `getImage(`. Codes: IM01 (raw img recommended Image), IM02 (missing alt), IM03 (empty alt), IM04 (no astro:assets import). File ≤170 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-image-audit.test.ts`
  Expected: pass; pathological case (img inside script) does NOT increment `raw_img_count`.
- [ ] Acceptance Proof:
  - G6: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-image-audit.test.ts -t "raw_img|missing_alt|pathological"`. Expected: 3+ tests pass; pathological img-in-script test asserts `raw_img_count === 2` (not 3). Artifact: `.zuvo/proofs/task-6-G6.txt`.
- [ ] Commit: `add astro_image_audit tool — raw img detection, alt validation, getImage tracking`

---

### Task 7: `astro_svg_components` tool
**Files:** `src/tools/astro-svg-components.ts` (NEW), `tests/tools/astro-svg-components.test.ts` (NEW)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: tmpdir with `import Logo from './logo.svg?component'` in a `.astro` page that uses `<Logo class="hero" />`. Plus an unused `import Unused from './u.svg?component'`. Assert `auditSvgFromIndex(index)`: `imports.length === 2`, `imports[0].used === true`, `imports[1].used === false`, `unused: ['Unused']`, `issues[]` includes SV01 for unused. Add: no SVG imports → empty result. Add: native Astro 5 SVG component import (`import Logo from '~/icons/logo.svg'` without `?component`) → flagged with SV02 if Astro 5 detected.
- [ ] GREEN: `auditSvgFromIndex(index)` walks files for `import X from '<path>.svg?component'` regex and tracks usage by scanning each file for `<X` JSX-style references. Flag unused. Detect Astro 5 mode via `package.json` astro version ≥5 (use existing `framework-detect`). Codes: SV01 (unused import), SV02 (legacy ?component while Astro 5 supports native), SV03 (SVG used without import). File ≤120 LOC.
- [ ] Verify: `npx vitest run tests/tools/astro-svg-components.test.ts`
  Expected: pass.
- [ ] Acceptance Proof:
  - G7: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-svg-components.test.ts -t "imports|unused|native"`. Expected: 3+ tests pass with SV codes asserted. Artifact: `.zuvo/proofs/task-7-G7.txt`.
- [ ] Commit: `add astro_svg_components tool — *.svg?component detection, Astro 5 native SVG check`

---

### Task 8: AM11–AM14 in `astro-migration.ts`
**Files:** `src/tools/astro-migration.ts` (modify), `tests/tools/astro-migration.test.ts` (extend)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: extend existing test file. Add fixture cases triggering: AM11 (Vite 6 removed `vite:serverModuleExtensions` hook in code), AM12 (Rollup 5 removed plugin pattern), AM13 (deprecated `vite.optimizeDeps.entries` glob shape), AM14 (Astro `defineConfig({ vite: { ssr: { external: ... } } })` pattern that needs migration). Assert each detector returns the expected code with `severity` and `file` set.
- [ ] GREEN: add 4 detectors to existing detector array in `astro-migration.ts`. Follow existing AM01–AM10 pattern (regex on source + AST sometimes). Ensure each has: `code`, `severity`, `description`, `estimate_hours`, line detection. Reuse helpers already present.
- [ ] Verify: `npx vitest run tests/tools/astro-migration.test.ts`
  Expected: all pre-existing tests pass + 4 new tests pass.
- [ ] Acceptance Proof:
  - G8: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-migration.test.ts -t "AM11|AM12|AM13|AM14"`. Expected: 4 tests pass. Artifact: `.zuvo/proofs/task-8-G8.txt`.
- [ ] Commit: `extend astro-migration with AM11-AM14 (Vite 6, Rollup 5 breaking changes)`

---

### Task 9: Extend `AstroAuditResult` with 6 new gates + sections
**Files:** `src/tools/astro-audit.ts` (modify type only — gates record + sections; do NOT yet wire sub-tools or change scoring), `tests/tools/astro-audit.test.ts` (extend baseline expectations)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Tasks 2–7, 4b
**Execution routing:** default

- [ ] RED: add test asserting `astro_audit({})` result `gates` has keys `middleware`, `sessions`, `db`, `env`, `image`, `svg` (each defaulting to `'skipped'` until wired in Task 10), and `sections` includes corresponding entries. Pre-existing audit tests must continue to pass with the same scores.
- [ ] GREEN: add 6 new keys to `AstroAuditResult.gates` and 6 corresponding `sections` entries with `count: 0, issues: []` defaults and `status: 'skipped'`. Do not yet call sub-tools.
- [ ] Verify: `npx vitest run tests/tools/astro-audit.test.ts`
  Expected: all tests pass with new keys present + skipped status.
- [ ] Acceptance Proof:
  - G9: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-audit.test.ts -t "gates|sections"`. Expected: assertion `expect(result.gates).toHaveProperty('middleware')` (×6) all pass. Artifact: `.zuvo/proofs/task-9-G9.txt`.
- [ ] Commit: `extend AstroAuditResult with 6 new gates (middleware/sessions/db/env/image/svg)`

---

### Task 10: Wire 6 sub-tools into `astroAudit()` orchestration
**Files:** `src/tools/astro-audit.ts` (modify), `tests/tools/astro-audit.test.ts` (extend)
**Surface:** backend-logic
**Complexity:** complex
**Dependencies:** Task 9
**Execution routing:** deep

- [ ] RED: in `tests/tools/astro-audit.test.ts`, write a wiring-focused unit test using stubbed sub-tool returns (vitest `vi.mock` for each `astro-{middleware,sessions,db-audit,env-validator,image-audit,svg-components}` module). Assert: (a) when each stub returns `{ issues: [], skipped: false }`, the corresponding gate flips from `'skipped'` to `'pass'`; (b) when a sub-tool throws, the gate stays `'skipped'` (graceful) and other gates are unaffected; (c) all 6 imports use the parallel `tryImportOptionalTool` pattern. Do NOT build a full multi-feature fixture here — that lives in Task 14.
- [ ] GREEN: in `astroAudit()`, add 6 parallel `tryImportOptionalTool` calls importing the new audits, mapping each to its gate. Each invocation must be wrapped so a thrown error keeps the gate at `'skipped'` (no audit-wide failure cascade). No fixture changes, no scoring changes.
- [ ] Verify: `npx vitest run tests/tools/astro-audit.test.ts -t "wiring|skip-on-throw"`
  Expected: stub-based wiring tests pass; all 6 new gates flip to `'pass'` under successful stubs and stay `'skipped'` under throwing stubs.
- [ ] Acceptance Proof:
  - G10: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-audit.test.ts -t "wiring|skip-on-throw"`. Expected: 2+ wiring tests pass; gate-flip and skip-on-throw both asserted. Artifact: `.zuvo/proofs/task-10-G10.txt`.
- [ ] Commit: `wire 6 new astro sub-tools into astro_audit orchestration`

---

### Task 11: Rebalance `deriveOverallScore` for 13 gates
**Files:** `src/tools/astro-audit.ts` (modify scoring), `tests/tools/astro-audit.test.ts` (extend)
**Surface:** backend-logic
**Complexity:** standard
**Dependencies:** Task 10
**Execution routing:** default

- [ ] RED: add scoring boundary tests: (a) 0 fails / 0 warns → `score === 'A'`; (b) 0 fails / 2 warns → `'B'`; (c) 0 fails / 5 warns → `'C'` (was 3 with 7 gates; scale to ~5/13≈40% with 13 gates); (d) 1 fail / 0 warns → `'C'`; (e) 2+ fails → `'D'`. Pre-existing snapshots must be updated to reflect new thresholds explicitly.
- [ ] GREEN: change `deriveOverallScore` to scale by `gates.length` (e.g., warn-D threshold = `Math.ceil(gates.length * 0.5)`, warn-C = `Math.ceil(gates.length * 0.3)`) OR set explicit constants for 13 gates. Document the new thresholds in a JSDoc comment above the function (this is a non-obvious WHY — one short line).
- [ ] Verify: `npx vitest run tests/tools/astro-audit.test.ts -t "score"`
  Expected: all boundary tests pass.
- [ ] Acceptance Proof:
  - G11: Surface=backend-logic. Proof: `npx vitest run tests/tools/astro-audit.test.ts -t "score|threshold"`. Expected: 5 boundary tests pass. Artifact: `.zuvo/proofs/task-11-G11.txt`.
- [ ] Commit: `rebalance astro_audit deriveOverallScore for 13 gates`

---

### Task 12: Register 6 new tools in `register-tools.ts` (TOOL_DEFINITIONS, NOT CORE)
**Files:** `src/register-tools.ts` (modify imports + TOOL_DEFINITIONS), `tests/registration/astro-tool-registration.test.ts` (NEW)
**Surface:** integration
**Complexity:** complex
**Dependencies:** Tasks 2–7, 4b
**Execution routing:** deep

- [ ] RED: in new `tests/registration/astro-tool-registration.test.ts`, import the registry, assert each of `astro_middleware`, `astro_sessions`, `astro_db_audit`, `astro_env_validator`, `astro_image_audit`, `astro_svg_components` is present in `TOOL_DEFINITIONS`. Assert NONE are in `CORE_TOOL_NAMES`. Assert each schema has a Zod input with required field discoverability (e.g., `repo` optional, `severity` enum). Assert `describe_tools(['astro_middleware'])` resolves.
- [ ] GREEN: add 6 imports at top of `register-tools.ts` (handlers from each tool file). Add 6 entries to `TOOL_DEFINITIONS` array following the existing astro-tool entry shape. Each entry includes: name, description, inputSchema (Zod), handler, category: "analysis", searchHint. Do NOT add to `CORE_TOOL_NAMES`. Do NOT modify FRAMEWORK_TOOL_GROUPS yet (Task 13).
- [ ] Verify: `npx vitest run tests/registration/astro-tool-registration.test.ts && npx tsc --noEmit`
  Expected: registration tests pass; TypeScript compiles with no errors.
- [ ] Acceptance Proof:
  - G12 / C7: Surface=integration. Proof: `npx vitest run tests/registration/astro-tool-registration.test.ts -t "registered|not in CORE"`. Expected: 6 tools present in TOOL_DEFINITIONS, 0 in CORE_TOOL_NAMES (excluding astro_audit which is already there). Artifact: `.zuvo/proofs/task-12-G12.txt`.
  - C6: Zod schemas. Proof: `npx vitest run tests/registration/astro-tool-registration.test.ts -t "Zod|inputSchema"`. Expected: each tool def has a parseable Zod schema. Artifact: `.zuvo/proofs/task-12-C6.txt`.
- [ ] Commit: `register 6 new astro tools in TOOL_DEFINITIONS (hidden, discoverable)`

---

### Task 13: Add `astro.config.*` to `FRAMEWORK_TOOL_GROUPS`
**Files:** `src/register-tools.ts` (modify FRAMEWORK_TOOL_GROUPS), `tests/registration/framework-auto-load.test.ts` (NEW)
**Surface:** config
**Complexity:** standard
**Dependencies:** Task 12
**Execution routing:** default

- [ ] RED: in test, simulate CWD with `astro.config.mjs` present (tmpdir). Call `detectAutoLoadTools(cwd)`. Assert returned tool list includes: `astro_audit`, `astro_route_map`, `astro_config_analyze`, `astro_content_collections`, `astro_analyze_islands`, `astro_actions_audit`, `astro_migration_check`, `astro_middleware`, `astro_sessions`, `astro_db_audit`, `astro_env_validator`, `astro_image_audit`, `astro_svg_components`. Repeat with `astro.config.ts`, `astro.config.cjs`, `astro.config.js`. Negative case: empty CWD → none of the astro tools returned.
- [ ] GREEN: add `astro.config.mjs`, `astro.config.ts`, `astro.config.cjs`, `astro.config.js` keys to `FRAMEWORK_TOOL_GROUPS` mapping each to the 13-tool list (7 existing + 6 new). Keep alphabetical or grouped per existing convention.
- [ ] Verify: `npx vitest run tests/registration/framework-auto-load.test.ts`
  Expected: all four config-file variants enable the full 13-tool list; empty CWD enables none.
- [ ] Acceptance Proof:
  - G1: Surface=config. Proof: `npx vitest run tests/registration/framework-auto-load.test.ts -t "astro.config"`. Expected: 4 config-name variants × 13 expected tools all assert true. Artifact: `.zuvo/proofs/task-13-G1.txt`.
- [ ] Commit: `auto-load astro tools on astro.config.* detection (FRAMEWORK_TOOL_GROUPS)`

---

### Task 14: `astro_audit` end-to-end integration test (13 gates populated)
**Files:** `tests/integration/astro-audit-13gates.test.ts` (NEW), `tests/fixtures/astro-full/` (NEW realistic fixture)
**Surface:** integration
**Complexity:** standard
**Dependencies:** Tasks 10, 11, 13
**Execution routing:** default

- [ ] RED: build `tests/fixtures/astro-full/` — a realistic Astro 5 mini-project: `astro.config.mjs` (with adapter, env schema, integrations), `src/pages/index.astro` (raw img + Image), `src/middleware.ts` (with sequence), `src/db/config.ts` (defineTable with FK), `src/content/blog/post.md` + `src/content.config.ts` (Content Layer), an `astro:env` import, an `*.svg?component` import. Assert `astro_audit({ project_root })` returns `gates` with all 13 keys not 'skipped', `score` derived correctly, `sections` populated, total runtime <5s.
- [ ] GREEN: assemble the fixture, run audit, assert structurally. Update snapshot if used.
- [ ] Verify: `npx vitest run tests/integration/astro-audit-13gates.test.ts`
  Expected: pass within 5s.
- [ ] Acceptance Proof:
  - G14: Surface=integration. Proof: `npx vitest run tests/integration/astro-audit-13gates.test.ts`. Expected: 13 gates populated, score computed, sections array length 13. Artifact: `.zuvo/proofs/task-14-G14.txt`.
- [ ] Commit: `add astro_audit 13-gate integration test against full fixture`

---

### Task 15: Smoke fixture — full Astro 5 project end-to-end
**Files:** `tests/integration/astro-smoke.test.ts` (NEW or extend existing astro-pipeline.test.ts), `tests/fixtures/astro-full/` (reuse from Task 14)
**Surface:** integration
**Complexity:** standard
**Dependencies:** Task 14
**Execution routing:** default

- [ ] RED: smoke test that exercises full pipeline: index the fixture via `index_folder`, then call `astro_audit`, then verify `analyze_project` returns `status: 'complete'` with Astro detected, then verify framework auto-load triggered correctly. Assert output schema invariants: every issue has `code`, `severity`, `file`, `line` (or null); every gate has `status` ∈ {pass, warn, fail, skipped}; `score` ∈ {A, B, C, D}.
- [ ] GREEN: write integration script. May reuse helpers from existing `astro-pipeline.test.ts` and `astro-fixture.smoke.test.ts`.
- [ ] Verify: `npx vitest run tests/integration/astro-smoke.test.ts`
  Expected: pass.
- [ ] Acceptance Proof:
  - G15: Surface=integration. Proof: `npx vitest run tests/integration/astro-smoke.test.ts -t "full pipeline"`. Expected: index → audit → analyze chain completes; all schema invariants hold. Artifact: `.zuvo/proofs/task-15-G15.txt`.
- [ ] Commit: `add full Astro 5 smoke pipeline integration test`

---

## Whole-feature Smoke Proofs

- **SMOKE1 — Astro 5 full project audit**
  - Preconditions: fixture dir `tests/fixtures/astro-full/` (built in Task 14) with: middleware, db/config, env schema, Sessions usage, content collection, raw `<img>`, `*.svg?component` import, Astro 5 adapter.
  - Proof: `npx vitest run tests/integration/astro-smoke.test.ts -t "full pipeline"`
  - Expected: `astro_audit` returns 13 gates each with non-skipped status (matches fixture content); `analyze_project` reports `framework: 'astro'`, `status: 'complete'`; total runtime <5s; no thrown errors; every issue has populated required fields.
  - Artifact: `.zuvo/proofs/smoke-astro-full-pipeline.txt`

- **SMOKE2 — Auto-load activation**
  - Preconditions: empty tmpdir + `astro.config.mjs` (single file).
  - Proof: `npx vitest run tests/registration/framework-auto-load.test.ts -t "astro.config"`
  - Expected: `detectAutoLoadTools(tmpdir)` returns exactly the 13-tool Astro list; no other framework tools enabled (Hono/Next.js/NestJS lists empty).
  - Artifact: `.zuvo/proofs/smoke-astro-auto-load.txt`

- **SMOKE3 — Clean-room compilation**
  - Preconditions: clean checkout after Tasks 1–15 merged (feature-complete).
  - Proof: `npx tsc --noEmit && npm run build`
  - Expected: TypeScript compiles, build succeeds, `dist/` artifacts produced.
  - Artifact: `.zuvo/proofs/smoke-build.txt`
