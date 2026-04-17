# Implementation Plan: Wiki & Lens

**Spec:** docs/specs/2026-04-15-wiki-lens-spec.md
**spec_id:** 2026-04-15-wiki-lens-1553
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 2
**status:** Approved
**Created:** 2026-04-15
**Tasks:** 14
**Estimated complexity:** 9 standard, 5 complex

## Architecture Summary

New files:

| New file | LOC | Role |
|----------|-----|------|
| `src/tools/wiki-surprise.ts` | ~120 | Surprise scoring algorithm (pure functions) |
| `src/tools/wiki-escape.ts` | ~20 | escMd() and escHtml() utilities |
| `src/tools/wiki-page-generators.ts` | ~200 | 6 page generators + summary generator (pure template functions) |
| `src/tools/wiki-links.ts` | ~80 | Two-pass [[slug]] resolution + backlink injection |
| `src/tools/wiki-manifest.ts` | ~100 | WikiManifest builder, file_to_community map, slug redirects |
| `src/tools/wiki-tools.ts` | ~280 | Orchestrator: generateWiki() with Promise.allSettled + withTimeout |
| `src/tools/wiki-lint.ts` | ~80 | Broken link, orphan page, stale hash detection |
| `src/tools/lens-tools.ts` | ~150 | Orchestrator: generateLens(), data assembly |
| `src/tools/lens-template.ts` | ~250 | HTML template builder: buildLensHtml(), section builders, escHtml |
| `src/cli/wiki-commands.ts` | ~120 | CLI handlers: handleWikiGenerate, handleWikiLint |

Modified files: `commands.ts` (+4), `help.ts` (+15), `hooks.ts` (+30), `register-tools.ts` (+15), `register-tool-loaders.ts` (+5), `instructions.ts` (+3).

Key data flow: `generateWiki()` → fan-out 5 analysis tools via `Promise.allSettled` + `withTimeout(15000)` → surprise scoring → page generators → resolveWikiLinks → writeFiles + manifest.json.

Dependencies: all read-only on existing tools. Zero new npm deps.

## Technical Decisions

- **Markdown/HTML:** template literals (matching report-tools.ts, generate-tools.ts). No remark/unified.
- **Parallel analysis:** `Promise.allSettled` + local `withTimeout` (matching architecture-tools.ts). Duplicated per convention.
- **File writes:** `writeFile` + path validation guard. Manifest uses atomic write (write .tmp + rename).
- **Hook inject:** Extend existing `handlePrecheckRead`. readFileSync for manifest. Repo root resolved from hook env, not file path. Summary files named `{slug}.summary.md`.
- **Token estimation:** `CHARS_PER_TOKEN = 4` constant (matches codebase convention in context-tools.ts).
- **Escaping:** Separate `escHtml()` (lens HTML) and `escMd()` (wiki markdown).
- **Lens data:** `generateLens()` accepts pre-computed wiki data from `generateWiki()` return value. Does NOT re-run analysis.

## Quality Strategy

- **Test framework:** Vitest with vi.mock
- **Pure functions first:** wiki-surprise.ts, wiki-page-generators.ts, wiki-links.ts, wiki-escape.ts — test without mocks
- **Mocking pattern:** getCodeIndex + 5 analysis tools + node:fs/promises (matching architecture-tools.test.ts)
- **CQ gates:** CQ3 (path validation), CQ6 (bounded output), CQ8 (timeout handling), CQ14 (controlled duplication), CQ19 (MCP API contract), CQ21 (lockfile)
- **Deferred to manual QA:** AC-S5 Playwright browser test (interactive D3 tabs). Unit tests verify HTML structure; browser verification is manual.
- **Deferred to v2:** `--fix` flag for `wiki-lint` (scan-only in v1)
- **Estimated new tests:** ~55-65

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| AC-S1 | Basic generation produces valid markdown | requirement | Task 7a, Task 3 | |
| AC-S2 | Unindexed repo exits 1 within 500ms | requirement | Task 7a | |
| AC-S3 | Small repo (<5 files) produces 1 page | requirement | Task 3 | Edge case in generators |
| AC-S4 | Large repo applies MAX_UNFOCUSED_FILES cap | requirement | Task 7a | Upstream cap |
| AC-S5 | Lens HTML opens without JS errors, tabs navigable | requirement | Task 9 | Unit: HTML structure. Browser: manual QA |
| AC-S6 | Hook inject adds <=50ms, always exits 0 | requirement | Task 11 | |
| AC-S7 | Token budget respected | requirement | Task 11 | |
| AC-S8 | Idempotent regeneration (non-community content) | requirement | Task 7a | |
| AC-S9 | Zero broken [[slug]] links on fresh wiki | requirement | Task 4, Task 8 | |
| AC-S10 | CLI --help, auto-resolve repo | requirement | Task 10 | |
| AC-V1 | Agent context quality (<=2 tool calls) | success | Task 11 | Manual validation |
| AC-V2 | Onboarding acceleration (5 min) | success | Task 9 | Manual validation |
| AC-V3 | Surprise utility (non-obvious connection) | success | Task 1 | Manual on test repos |
| AC-V4 | Freshness signal (stale wiki warning) | success | Task 11 | Staleness hash check |
| AC-V5 | Framework page coverage | success | Task 3 | |
| DD3 | Full interactive Lens from v1 | constraint | Task 9 | D3 chord + force + tabs |
| DD5 | Tool Composition (no intermediate model) | constraint | Task 7a | Direct tool consumption |
| DD6 | Hook merged into handlePrecheckRead | constraint | Task 11 | |
| DD7 | Pre-generated summaries | constraint | Task 3 | {slug}.summary.md |
| RISK-1 | Atomic write for manifest | constraint | Task 7b | write .tmp + rename |
| RISK-3 | output_dir path traversal guard | constraint | Task 7b, Task 10 | |
| RISK-4 | escMd/escHtml context separation | constraint | Task 2 | Prevents HTML entities in markdown |

## Review Trail

- Plan reviewer: revision 1 -> ISSUES FOUND (5 blockers: lens LOC violation, CHARS_PER_TOKEN mismatch, AC-V4 orphan, --fix flag missing, Playwright AC-S5 gap)
- Plan reviewer: revision 2 -> pending
- Cross-model validation: executed -> findings addressed (3 CRITICALs from gemini fixed: hook path resolution, summary filename, Task 11 dependency; 2 CRITICALs from cursor-agent fixed: Task 11 dep, AC8 idempotency)
- Status gate: Approved (auto-approved per user instruction — no approval gate wait)

## Task Breakdown

### Task 1: Surprise scoring algorithm
**Files:** `src/tools/wiki-surprise.ts`, `tests/tools/wiki-surprise.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Write 7 tests for `computeSurpriseScores()`. Assert: (1) structural score = actual/expected edges, (2) temporal score from jaccard, (3) combined = 0.6*structural + 0.4*temporal, (4) empty communities → [], (5) 0/0 → score 0 not NaN, (6) sorted by combined descending, (7) example_files from highest jaccard pair
- [ ] GREEN: Implement `computeSurpriseScores(communities, crossEdges, coChangePairs, globalDensity)`. Pure function, zero async. Export `SurpriseScore` interface.
- [ ] Verify: `npx vitest run tests/tools/wiki-surprise.test.ts`
  Expected: 7 tests pass, 0 fail
- [ ] Acceptance: AC-V3
- [ ] Commit: `feat: add surprise scoring algorithm for wiki`

### Task 2: Markdown and HTML escape utilities
**Files:** `src/tools/wiki-escape.ts`, `tests/tools/wiki-escape.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default implementation tier

- [ ] RED: Write 5 tests. Assert: (1) escMd escapes `[]()<>*_\``, (2) escHtml escapes `&<>"'`, (3) empty → empty, (4) escMd does NOT produce `&lt;`, (5) escHtml does NOT escape `[]`. Test with `"a < b [c](d)"`.
- [ ] GREEN: Implement `escMd()` and `escHtml()` in `src/tools/wiki-escape.ts`. ~20 LOC.
- [ ] Verify: `npx vitest run tests/tools/wiki-escape.test.ts`
  Expected: 5 tests pass, 0 fail
- [ ] Acceptance: RISK-4
- [ ] Commit: `feat: add markdown and HTML escape utilities for wiki/lens`

### Task 3: Wiki page generators + summaries
**Files:** `src/tools/wiki-page-generators.ts`, `tests/tools/wiki-page-generators.test.ts`
**Complexity:** complex
**Dependencies:** Task 1 (SurpriseScore type), Task 2 (escMd)
**Execution routing:** deep implementation tier

- [ ] RED: Write ~12 tests for 6 generators + summary generator. Assert: (1-6) each generator returns non-empty markdown with expected headings, (7) generateIndexPage with 3 communities → 3 links, (8) generateSurprisePage with empty surprises → "no surprises", (9) generateCommunityPage with 20 files → truncation note, (10) generateCommunitySummary returns <=1600 chars (CHARS_PER_TOKEN=4 × 400 token budget), (11) community name with special chars → escaped, (12) framework page conditional on stack detection
- [ ] GREEN: Implement 6 page generators + `generateCommunitySummary()`. Pure `(data) => string` functions. Import SurpriseScore, escMd.
- [ ] Verify: `npx vitest run tests/tools/wiki-page-generators.test.ts`
  Expected: 12 tests pass, 0 fail
- [ ] Acceptance: AC-S1, AC-S3, AC-V5, DD7
- [ ] Commit: `feat: add 6 wiki page generators with markdown templates`

### Task 4: Wiki link resolution + backlinks
**Files:** `src/tools/wiki-links.ts`, `tests/tools/wiki-links.test.ts`
**Complexity:** standard
**Dependencies:** Task 3 (uses same slug conventions)
**Execution routing:** default implementation tier

- [ ] RED: Write 6 tests. Assert: (1) extracts [[slug]] from pages, (2) inverts to backlink map, (3) appends ## Backlinks section, (4) unresolved [[slug]] flagged as broken, (5) empty pages → empty backlinks, (6) self-reference handled
- [ ] GREEN: Two-pass resolution: Pass 1 = regex extract → forward index. Pass 2 = invert + inject. Return `{ resolvedPages, brokenLinks }`.
- [ ] Verify: `npx vitest run tests/tools/wiki-links.test.ts`
  Expected: 6 tests pass, 0 fail
- [ ] Acceptance: AC-S9
- [ ] Commit: `feat: add two-pass wiki link resolution with backlinks`

### Task 5: Wiki manifest builder
**Files:** `src/tools/wiki-manifest.ts`, `tests/tools/wiki-manifest.test.ts`
**Complexity:** standard
**Dependencies:** Task 3 (page data for token_estimates)
**Execution routing:** default implementation tier

- [ ] RED: Write 6 tests. Assert: (1) manifest has all required fields, (2) file_to_community maps every community file to its slug, (3) slug_redirects merges old + new, (4) token_estimates populated per page, (5) degraded=true when analysis timed out, (6) degraded_reasons lists failures
- [ ] GREEN: Implement `buildWikiManifest()` and `buildFileToCommunityMap()`. Export `WikiManifest` interface. Pure functions.
- [ ] Verify: `npx vitest run tests/tools/wiki-manifest.test.ts`
  Expected: 6 tests pass, 0 fail
- [ ] Acceptance: DD6, RISK-1 (manifest structure)
- [ ] Commit: `feat: add wiki manifest builder with file-to-community map`

### Task 6: Wiki lint
**Files:** `src/tools/wiki-lint.ts`, `tests/tools/wiki-lint.test.ts`
**Complexity:** standard
**Dependencies:** Task 5 (WikiManifest type)
**Execution routing:** default implementation tier

- [ ] RED: Write 5 tests. Assert: (1) valid wiki → { issues: [] }, (2) broken [[slug]] → issue reported, (3) orphan pages → issue, (4) manifest missing → throws, (5) stale index hash → warning. Note: `--fix` flag deferred to v2.
- [ ] GREEN: Implement `lintWiki(wikiDir)`. Read manifest, scan .md files for [[slug]], cross-check.
- [ ] Verify: `npx vitest run tests/tools/wiki-lint.test.ts`
  Expected: 5 tests pass, 0 fail
- [ ] Acceptance: AC-S9
- [ ] Commit: `feat: add wiki lint for broken links and stale refs`

### Task 7a: Wiki orchestrator — core pipeline
**Files:** `src/tools/wiki-tools.ts`, `tests/tools/wiki-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 1, 2, 3, 4, 5
**Execution routing:** deep implementation tier

- [ ] RED: Write 6 tests mocking getCodeIndex + 5 analysis tools + fs/promises. Assert: (1) happy path — all resolve, writeFile called N+1 times, returns correct shape, (2) getCodeIndex null → throws "not found", (3) detectCommunities rejects → degraded wiki with notice, (4) detectCommunities never-resolves → withTimeout fires, degraded output, (5) each analysis individually rejected → partial, (6) output_dir defaults to `${index.root}/.codesift/wiki`
- [ ] GREEN: Implement `generateWiki(repo, options?)`. Fan-out via Promise.allSettled + withTimeout(15000). Call page generators, resolveWikiLinks, buildWikiManifest. Write pages + manifest.
- [ ] Verify: `npx vitest run tests/tools/wiki-tools.test.ts`
  Expected: 6 tests pass, 0 fail
- [ ] Acceptance: AC-S1, AC-S2, AC-S4, AC-S8, DD5
- [ ] Commit: `feat: add generateWiki orchestrator with graceful degradation`

### Task 7b: Wiki orchestrator — safety & storage
**Files:** modify `src/tools/wiki-tools.ts`, extend `tests/tools/wiki-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 7a
**Execution routing:** default implementation tier

- [ ] RED: Write 5 tests extending wiki-tools.test.ts. Assert: (1) output_dir outside index.root → throws path traversal error, (2) concurrent run lockfile — second call rejects with "already in progress", (3) stale page cleanup — second run with different communities removes old .md files, (4) atomic manifest write — writeFile called with .tmp path, rename called after, (5) lockfile removed after completion (including on error)
- [ ] GREEN: Add to wiki-tools.ts: path validation guard, lockfile via `open(path, 'wx')`, stale page sweep (read dir, diff against manifest, unlink orphans), atomic manifest write (write .tmp + rename).
- [ ] Verify: `npx vitest run tests/tools/wiki-tools.test.ts`
  Expected: 11 tests pass (6 from 7a + 5 new), 0 fail
- [ ] Acceptance: RISK-1, RISK-3
- [ ] Commit: `feat: add wiki safety guards — path validation, lockfile, atomic write`

### Task 8: Wiki lint CLI integration
**Files:** `src/tools/wiki-lint.ts` (if needed), `tests/tools/wiki-lint.test.ts` (extend)
**Complexity:** standard
**Dependencies:** Task 6
**Execution routing:** default implementation tier

Note: This task exists as a checkpoint — lint is already implemented in Task 6. This task validates the lint → link resolution pipeline end-to-end with realistic data.

- [ ] RED: Write 2 integration-style tests. Assert: (1) generate pages with Task 3 generators, resolve links with Task 4, lint → 0 issues, (2) generate pages, manually break one link, lint → 1 issue with correct slug and source page
- [ ] GREEN: Fix any integration issues between generators, link resolution, and lint.
- [ ] Verify: `npx vitest run tests/tools/wiki-lint.test.ts`
  Expected: 7 tests pass (5 from Task 6 + 2 new), 0 fail
- [ ] Acceptance: AC-S9 (end-to-end link integrity)
- [ ] Commit: `test: add wiki lint integration tests for link pipeline`

### Task 9: Lens HTML dashboard
**Files:** `src/tools/lens-tools.ts`, `src/tools/lens-template.ts`, `tests/tools/lens-tools.test.ts`
**Complexity:** complex
**Dependencies:** Task 2 (escHtml), Task 7a (generateWiki data shape)
**Execution routing:** deep implementation tier

- [ ] RED: Write 10 tests. Assert: (1) returns { path }, (2) HTML has `<!DOCTYPE html>` and `</html>`, (3) 5 tab buttons present, (4) `const DATA =` JSON inline, (5) D3 CDN script tag, (6) escHtml on repo name (test `<script>` in name), (7) communities >=2 → chord section, (8) communities <=1 → "low modularity" notice, (9) empty hotspots → "no hotspots", (10) integration test with tmpdir: write + readFile + verify HTML. `generateLens()` accepts pre-computed wiki data from `generateWiki()` return — does NOT re-run analysis.
- [ ] GREEN: Implement `generateLens(data, outputPath)` in lens-tools.ts (orchestrator, ~150 LOC). Implement `buildLensHtml(data)` in lens-template.ts (HTML builder, ~250 LOC). Inline CSS, D3+marked CDN refs, JSON data, tab nav JS.
- [ ] Verify: `npx vitest run tests/tools/lens-tools.test.ts`
  Expected: 10 tests pass, 0 fail
- [ ] Acceptance: AC-S5 (HTML structure verified; browser manual QA), AC-V2, DD3
- [ ] Commit: `feat: add Lens HTML dashboard with D3 chord diagram and tabs`

### Task 10: CLI commands (wiki-generate, wiki-lint)
**Files:** `src/cli/wiki-commands.ts`, `tests/cli/wiki-commands.test.ts`, modify `src/cli/commands.ts`, modify `src/cli/help.ts`
**Complexity:** standard
**Dependencies:** Task 7a (generateWiki), Task 6 (lintWiki), Task 9 (generateLens)
**Execution routing:** default implementation tier

- [ ] RED: Write 8 tests. Assert: (1) COMMAND_MAP["wiki-generate"] exists, (2) COMMAND_MAP["wiki-lint"] exists, (3) wiki-generate without repo → exit(1), (4) calls generateWiki with correct args, (5) --no-lens skips lens, (6) --trim passes trim option, (7) --focus and --output flags passed through, (8) wiki-lint calls lintWiki. Note: `--fix` deferred to v2.
- [ ] GREEN: Implement handlers in wiki-commands.ts. Add to COMMAND_MAP + COMMAND_HELP. Follow lazy-import pattern.
- [ ] Verify: `npx vitest run tests/cli/wiki-commands.test.ts`
  Expected: 8 tests pass, 0 fail
- [ ] Acceptance: AC-S10, RISK-3
- [ ] Commit: `feat: add wiki-generate and wiki-lint CLI commands`

### Task 11: Hook inject (extend handlePrecheckRead)
**Files:** modify `src/cli/hooks.ts`, extend `tests/cli/hooks.test.ts`
**Complexity:** complex
**Dependencies:** Task 5 (WikiManifest), Task 7a (generateWiki must have run to produce manifest)
**Execution routing:** deep implementation tier

- [ ] RED: Write 8 tests extending hooks.test.ts. Assert: (1) manifest exists + file in file_to_community → stdout has summary, (2) manifest missing → exits 0, no inject, (3) malformed JSON manifest → exits 0, (4) file not in map → exits 0, (5) stale index hash → stdout has staleness warning, (6) existing redirect behavior (exit 2) preserved — regression, (7) inject content <= budget chars, (8) manifest path resolved from repo root (env-based), not from file path. Summary files named `{communitySlug}.summary.md`.
- [ ] GREEN: Extend `handlePrecheckRead()`. After redirect check: try readFileSync(`${repoRoot}/.codesift/wiki/wiki-manifest.json`) → parse → lookup file_to_community → readFileSync `{slug}.summary.md` → write to stdout → exit 0. All in try/catch.
- [ ] Verify: `npx vitest run tests/cli/hooks.test.ts`
  Expected: all existing + 8 new tests pass, 0 fail
- [ ] Acceptance: AC-S6, AC-S7, AC-V1, AC-V4, DD6
- [ ] Commit: `feat: extend handlePrecheckRead with wiki context injection`

### Task 12: MCP tool registration
**Files:** modify `src/register-tools.ts`, modify `src/register-tool-loaders.ts`, extend `tests/tools/register-tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 7a (generateWiki), Task 9 (generateLens — for loadLensTools)
**Execution routing:** default implementation tier

- [ ] RED: Write 5 tests extending register-tools.test.ts. Assert: (1) "generate_wiki" in tool definitions, (2) category = "reporting", (3) schema has repo, focus, output_dir, include_lens, (4) handler is function, (5) handler return includes wiki_dir, pages, communities, hubs, surprises, stale fields
- [ ] GREEN: Add loadWikiTools + loadLensTools loaders in register-tool-loaders.ts. Register generate_wiki tool in register-tools.ts with Zod schema.
- [ ] Verify: `npx vitest run tests/tools/register-tools.test.ts`
  Expected: all existing + 5 new tests pass, 0 fail
- [ ] Acceptance: CQ19
- [ ] Commit: `feat: register generate_wiki MCP tool`

### Task 13: Instructions update + integration smoke test
**Files:** modify `src/instructions.ts`, `tests/integration/wiki-smoke.test.ts`
**Complexity:** standard
**Dependencies:** Task 7a, 9, 10, 11, 12
**Execution routing:** default implementation tier

- [ ] RED: Write smoke test using real tmpdir + CODESIFT_DATA_DIR. Assert: (1) index fixture repo, (2) generateWiki → files in .codesift/wiki/, (3) manifest.json valid with expected structure, (4) lintWiki → zero issues, (5) generateLens → HTML exists with markers, (6) instructions.ts contains "generate_wiki"
- [ ] GREEN: Add wiki tool mapping to CODESIFT_INSTRUCTIONS. Fix any integration issues.
- [ ] Verify: `npx vitest run tests/integration/wiki-smoke.test.ts && npx vitest run`
  Expected: smoke passes AND full suite passes (no regressions)
- [ ] Acceptance: AC-S1, AC-S5, AC-S9 (end-to-end)
- [ ] Commit: `feat: add wiki instructions mapping and integration smoke test`
