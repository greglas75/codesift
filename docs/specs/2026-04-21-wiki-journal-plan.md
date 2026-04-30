# Implementation Plan: Wiki Journal

**Spec:** `docs/specs/2026-04-21-wiki-journal-spec.md`
**spec_id:** 2026-04-21-wiki-journal-0418
**planning_mode:** spec-driven
**source_of_truth:** approved spec
**plan_revision:** 4
**status:** Approved
**approved_at:** 2026-04-21T05:10:00Z
**approved_by:** interactive user approval
**Created:** 2026-04-21
**Tasks:** 21
**Estimated complexity:** 13 standard + 8 complex

## Architecture Summary

The wiki journal lives at `.codesift/wiki/journal/` and consists of 3 content tiers: `overview.md` (auto TOC), `rollup.md` (one-liner per day, SQLite-changes style), and `phases/<slug>.md` (per-phase 4-beat narrative). Content is author-aware via two sentinel prefixes: `auto:begin/end` (LLM-owned, SHA-256 hash-checked) and `manual:begin/end` (human-owned, not hash-checked, preserved verbatim by the generator).

Data flow: 3 entry points (CLI `journal *`, MCP `generate_wiki(journal_mode)`, MCP `journal_append`) converge on `src/tools/journal-generator.ts` (the orchestrator hub). The generator depends on 6 sub-modules: `journal-sentinel.ts` (state-machine parser + SHA-256), `journal-llm-client.ts` (provider interface + Anthropic/OpenAI/scaffold implementations), `journal-phase-detector.ts` (git-log heuristics + YAML override), `journal-templates.ts` (4-beat grammar validator), `journal-migrator.ts` (prototype history.md → phase files), `journal-git-client.ts` (isolated `child_process` git shell-out).

The modified-files blast radius is 7 existing files. The highest-risk change is the stale-page cleanup loop in `src/tools/wiki-tools.ts:512-525` — a mis-typed path guard would silently delete all journal files on every wiki-generate run. This is gated by a mandatory two-path integration test (D1) and by extracting `pruneStaleWikiFiles()` into a standalone helper before patching.

## Technical Decisions

- **Patterns.** `journal-generator.ts` follows the orchestrator-with-I/O pattern (lockfile, atomic writes, checkpointing). Sub-modules are pure where possible. `journal-sentinel.ts` uses an explicit line-by-line state machine (states: `OUTSIDE` / `INSIDE_AUTO` / `INSIDE_MANUAL`) — not regex, not tree-sitter — because safety-critical code benefits from discrete branches mapping 1:1 to test cases. `journal-llm-client.ts` uses an interface + implementations pattern (`JournalLlmProvider`, `AnthropicJournalProvider`, `OpenAiJournalProvider`, `ScaffoldFallbackProvider`) so credential routing and cost accounting are per-provider and mockable.
- **File layout.** Source files are flat under `src/tools/journal-*.ts` (matches `hono-*.ts` / `nestjs-*.ts` / `kotlin-*.ts` conventions). Test files live in a `tests/tools/journal/` subdirectory (per spec E9; subdirectory scopes the 7+ test files vs the 70+ flat files already in `tests/tools/`).
- **Libraries.** Reuse: `zod` (MCP schemas), `node:crypto` (SHA-256), `node:fs/promises`, `node:child_process` (new usage via `execFileSync` in an isolated `journal-git-client.ts`). Optional new deps: `@anthropic-ai/sdk` + `yaml` under `optionalDependencies`. `openai` already present as optional. All LLM providers load via dynamic `import()` with runtime guard so absence does not crash.
- **Checkpoint format.** JSON with `schema_version: "1"` for `.init-checkpoint.json` and `.migrate-state.json`. JSON chosen over YAML-style markdown because both files are machine-written/read (`.zuvo/context/*.md` YAML convention is for human-authored decision records).
- **Atomic writes.** Every file write: `writeFile(tmp)` → `rename(tmp, target)`. Mirrors `src/tools/wiki-tools.ts:528-532`.
- **Lockfile.** `.init-lock` using `writeFile(lockPath, pid, { flag: "wx" })` + `try/finally unlink()`. Mirrors `src/tools/wiki-tools.ts:144-148`.
- **Extract before patch.** `src/tools/wiki-tools.ts` is a 425L function at 5× the 50L CQ11 cap. Before patching the cleanup loop, extract `pruneStaleWikiFiles(outputDir, newFiles, journalDirs)` as an exported helper so the guard can be unit-tested in isolation.
- **Git shell portability.** Pin `git log --pretty=format:` string as a module-level constant in `journal-git-client.ts` for cross-version reproducibility. All git calls via `execFileSync` (never `exec`) with explicit timeout.

## Quality Strategy

**Unit tests** for pure modules (`sentinel`, `phase-detector`, `templates`, and the `git-client` as a thin parser wrapper). **Integration tests** with temp directories and `vi.mock("node:fs/promises", ...)` for side-effectful modules (`generator`, `migrator`, `llm-client`). **End-to-end test** on a 30-commit fixture repo cycling init → lint → append → regenerate.

Environment variable discipline is critical (`CODESIFT_JOURNAL_ENABLED`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODESIFT_JOURNAL_MODEL`, `CODESIFT_JOURNAL_MAX_USD`) — every test must use `vi.stubEnv` with `afterEach(() => vi.unstubAllEnvs())` to avoid leaking state between tests (Q18/Q19).

**Activated CQ gates**: CQ3 (boundary validation on MCP/CLI inputs), CQ5 (no PII — strip author emails from git log), CQ6 (bounded file size 60KB), CQ8 (LLM 30s timeout + git timeouts + awaited I/O), CQ11 (generator ≤ 300L, helpers ≤ 100L), CQ12 (named constants: `LLM_TIMEOUT_MS`, `DEFAULT_MAX_COST_USD`, `JOURNAL_MAX_FILE_BYTES`), CQ14 (sentinel hash lives only in `journal-sentinel.ts`; `resolveCredentialsForModel` is the only credential gating site), CQ15 (await discipline on every LLM / fs / git call), CQ21 (TOCTOU lockfile + pre/post hash re-read), CQ28 (timeout hierarchy: LLM < per-phase < overall-init).

**Risks not catchable by tests** (documented for post-merge validation): LLM narrative non-determinism (mitigated by S1 retrieval benchmark), git log format portability across versions, `journal migrate` destructive-once nature (mitigated by SHA guard + `.bak` + dry-run prerequisite), fixture drift between spec approval and merge (mitigated by `scripts/verify-prototype-fixture.sh` in CI).

## Coverage Matrix

| Row ID | Authority item | Type | Primary task(s) | Notes |
|--------|----------------|------|-----------------|-------|
| Ship-1 | Test suite green | ship AC | Task 1, 3, 6-12, 21 | All journal unit + integration tests pass |
| Ship-2 | D1 cleanup guard two-path test | ship AC | Task 1 | Protects prototype from silent deletion |
| Ship-3 | `tsc --noEmit` passes | ship AC | Task 4, all tasks transitively | Manifest type union must be exhaustive |
| Ship-4a | `journal lint` exit 0 on valid, exit 1 on broken sentinel, warn on hash mismatch | ship AC | Task 13, 2 | Lint uses sentinel parser |
| Ship-4b | `journal regenerate` exit 2 on hash mismatch without `--force`, exit 0 with `--force` | ship AC | Task 10, 12 | Asymmetric to lint; must abort before write |
| Ship-5 | Kill switch `CODESIFT_JOURNAL_ENABLED=false` | ship AC | Task 12 | Dedicated kill-switch test |
| Ship-6 | Scaffold fallback when API key absent | ship AC | Task 8 | `ScaffoldFallbackProvider` in llm-client |
| Ship-7 | Migration preserves prototype content (7 phase files + migrated-overview block) | ship AC | Task 11, 3 | Snapshot test against byte-copy fixture |
| Ship-8 | Manifest schema bump 2.1.0 + `manifest_schema_version` field | ship AC | Task 4 | Type + schema JSON mirror |
| Ship-9 | V1 rollback preserved (`CODESIFT_WIKI_V1=1` does not touch journal) | ship AC | Task 18 | Coexistence integration test |
| Ship-10 | Cost cap enforcement (`CODESIFT_JOURNAL_MAX_USD`) | ship AC | Task 8, 10 | llm-client post-call accounting + generator abort |
| S1 | Agent retrieval mean ≤ 2 tool calls on 20-query cold-session benchmark | success | Task 19 | Script callable pre-merge; measured post-merge |
| S2 | `journal init` ≤ 5 min + ≤ $2.00 on 709 commits with Sonnet | success | Task 19 (metrics) | Measured post-merge via `journal stats` |
| S3 | 30-day cadence: ≥ 4 append runs or ≥ 2 manual notes commits | success | Task 20 | Post-release telemetry only (Open Q3) |
| S4 | Citation gate ≥ 95% grounded literals against `citation-golden.md` fixture | success | Task 17 | Script + fixture pre-merge testable |
| S5 | Readability budgets: rollup ≤ 12KB, overview ≤ 6KB, phase mean 3-8KB | success | Task 10 | Generator asserts byte limits |
| IC-1 | wiki-lint orphan rule exempts `journal/**` | contract | Task 13 | Regression: non-journal orphans still flagged |
| IC-2 | Chunker indexes `.codesift/wiki/journal/**/*.md`, 60KB ceiling | contract | Task 14 | Regression: user `/journal/` folders unaffected |
| IC-3 | `generate_wiki` MCP schema gains 3 optional params | contract | Task 15 | Additive — pre-2.1 callers unaffected |
| E1 | Citation footer inside entry sentinel (not free-floating) | edge | Task 1 | Sentinel parser validates presence + SHA format |
| E2 | Hash-check on sentinel blocks (abort without `--force`) | edge | Task 10, 1 | Generator TOCTOU pre+post re-read |
| E3 | Sentinel integrity validation (kind/nesting/EOF) | edge | Task 1 | State machine raises SentinelIntegrityError |
| E4 | Phase boundary YAML override wins over auto-detect | edge | Task 7 | phase-detector merger |
| E5 | Phase file split + `parent_slug` for weekly sub-files | edge | Task 4, 10 | Manifest field + generator split logic |
| E8 | `journal init` guard on non-empty `phases/` unless all TODO-placeholder | edge | Task 10, 12 | `--bulk-fill` flag is documented post-migrate path |
| E9 | Migrator heading hierarchy (a-e) rules including multi-day entries | edge | Task 11 | Rules verified against pinned fixture |
| E11 | Concurrent edit TOCTOU during 30s LLM call | edge | Task 10 | pre-hash + post-hash re-read before rename |
| E12 | LLM malformed output retry + scaffold fallback | edge | Task 9 | Templates grammar validator triggers retry |
| FM-A | LLM provider failure modes (timeout, rate limit, malformed, cost cap) | failure | Task 8 | 4 scenarios with retry + scaffold + checkpoint |
| FM-B | Sentinel integrity failure modes (missing end, unknown kind, hash mismatch) | failure | Task 1 | 3 scenarios per spec |
| FM-C | Phase detector failure modes (YAML override conflict, day-straddles-boundary, unclassified) | failure | Task 7 | 3 scenarios |
| FM-D | Wiki cleanup integration (guard mis-type, manual delete, V1 coexistence) | failure | Task 1, 18 | D1 test + V1 coexist test |
| FM-Migrator | source drift, .bak fail, partial crash, zero-phase, slug collision | failure | Task 11 | 5 scenarios |
| FM-Checkpoint | corruption, version mismatch, staleness, concurrency | failure | Task 10 | 4 scenarios |
| Deliverable | `@anthropic-ai/sdk` + `yaml` in optionalDependencies | deliverable | Task 5 | package.json |
| Deliverable | H15 hint in CODESIFT_INSTRUCTIONS | deliverable | Task 16 | instructions.ts |

## Review Trail

| Round | Reviewer | Model | Date | Verdict | Issues |
|-------|----------|-------|------|---------|--------|
| 1 | plan-reviewer agent | claude-sonnet-4-6 | 2026-04-21 | ISSUES FOUND | 5 FAIL + 1 RISK (all fixed in revision 2: .gitignore auto-append added to Task 11, Task 13 deps extended to include Task 4, Task 12 Verify count fixed to 16, Task 16 Verify count fixed to 11, Task 17 Verify command includes --threshold 70, Task 10 pre-decides helpers extraction) |
| 2 | plan-reviewer agent | claude-sonnet-4-6 | 2026-04-21 | ISSUES FOUND | 1 FAIL (`journal lint --strict` wiring) + 3 RISKs. FAIL fixed in revision 3 (Task 13 RED case (e) + GREEN `--strict` dispatch; Task 17 exports `runCitationCheck`). RISKs noted below and in affected tasks — they do not change execution semantics. |
| 3 | plan-reviewer agent | claude-sonnet-4-6 | 2026-04-21 | **APPROVED** | 0 FAILs; RISKs A and B carried from iteration 2 as accepted; 1 informational C8 note (Task 13 deps missing Task 17) fixed in this revision by adding Task 17 to dependencies. |
| 4 | adversarial review (cross-model) | codex-5.3 + gemini + cursor-agent | 2026-04-21 | findings fixed | 3 CRITICAL + 3 WARNING + 3 INFO. All 3 CRITICALs fixed in revision 4: (C1) Task 9 deps on Task 7 for `PhasePlan`; (C2) Task 1 Path B glob-vs-prefix mismatch aligned to plain prefix strings; (C3) Task 13↔17 numerical ordering documented in Execution Notes as DAG-not-sequential. 3 WARNINGs fixed: Task 15 adds wiki-tools.ts to Files list with explicit `generateWiki` dispatch logic; Task 6 delimiter changed from `|` to `%x1F` (Unit Separator) to prevent pipe-in-commit-subject corruption; Task 11 dependencies now include Task 1 so cleanup guard is in place before migrator writes. 2 other WARNINGs addressed: Task 4 IC-3 ownership moved to Task 15 (single source of truth); Task 4 Verify uses ephemeral fixture `tests/fixtures/wiki-manifest-v2.1-example.json` for strict ajv validation. 3 INFOs accepted (scaffold prose style, commit-message intent-vs-files, Task 16 Verify escape hatch) — documented as executor guidance below. |

**Accepted risks from iteration 2 review** (WARNINGs not changing execution semantics; documented for executor awareness):

- **RISK A (file limits on pure function utilities)**: Tasks 2, 7, 9 estimate ≤170L / ≤160L / ≤130L. `file-limits.md` measures body lines only (excluding imports, blank lines, types, comments). Total-file estimates are likely over but body-only counts are likely within 100L for utilities. If `journal-sentinel.ts` body-only exceeds 100L, executor extracts hash computation into `journal-sentinel-hash.ts` (≤30L) during Task 2 GREEN without requiring a plan amendment. Alternatively, files with a single public export (phase-detector, templates) may be classified as "service, 1 method, ≤300L" rather than "utility, ≤100L" — classification chosen at implementation time.
- **RISK B (CLI handler function size)**: Task 12 GREEN targets ≤30L per handler; function-limit rule is ≤25L for controller handlers. 5-line overage is acceptable because CLI handlers follow a 4-step pattern (kill-switch check, flag parsing, lazy import, dispatch) that occasionally needs one extra line for error formatting. Executor may tighten to 25L if trivial to do so; hard 25L enforcement is not a ship gate.
- **RISK C (Task 12 Verify scope)**: Task 12 Verify only runs the two new journal CLI test files. Existing `tests/cli/` tests (including any for `commands.ts` COMMAND_MAP) must still pass after the modification — mitigated by running full `npm test` before commit (standard pre-commit discipline). Explicit re-run of existing commands tests after COMMAND_MAP modification is recommended but not plan-mandated.

**Accepted INFO items from adversarial round 4** (documentation-only, no task changes):

- **Task 10 size bundling**: Task 10 integrates 12 test scenarios in one task. Adversarial suggested splitting into "helpers + pure behaviours" then "orchestrator + I/O". Accepted as informational — the pre-decided `journal-generator-helpers.ts` / `journal-generator.ts` split partially addresses this; full task splitting rejected because the 12 cases all drive a single orchestrator's surface and splitting would require duplicated fixture setup.
- **Task 1 scaffold over-specification**: GREEN step states exact loop semantics ("iterate readdir, continue if..."). Revision 4 GREEN now states the invariant first ("skip any entry f where...") and explicitly permits alternative Node.js APIs (`dirent.isDirectory()`, functional style). Executor has implementation flexibility within the invariant contract.
- **Commit message intent vs. structural files**: Tasks 1, 4, 11 commit messages describe structural changes. Revision 4 leaves them as-is — they adequately describe behavioural intent at the commit-scope level. Executors may rephrase during implementation if a more intent-focused wording emerges naturally.
- **Task 16 Verify escape hatch for pre-existing H12/H13/H14 failures**: Accepted as-is. The H12/H13/H14 assertions failing in the existing test are an unrelated pre-existing issue (H12 missing from CODESIFT_INSTRUCTIONS) that is out of scope for the H15 hint task. A separate follow-up issue should track fixing those; this plan does not block on it.

## Task Breakdown

### Task 1: Cleanup guard + extract pruneStaleWikiFiles + D1 test (SAFETY FIRST)

**Files:**
- `src/tools/wiki-tools.ts` (modify: extract helper + add journal guard)
- `tests/integration/wiki-cleanup-journal-guard.test.ts` (create)

**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/integration/wiki-cleanup-journal-guard.test.ts` with two-path assertions. **Path A (non-recursive real readdir):** `beforeEach` creates tmpdir; creates `.codesift/wiki/journal/phases/test.md` with arbitrary content; calls real `generateWiki(opts)` with `outputDir` set to tmpdir; asserts file exists afterwards. **Path B (recursive-stub readdir):** mocks `node:fs/promises.readdir` with `vi.fn().mockResolvedValueOnce(["journal/phases/test.md", "index.md"])` to simulate a future recursive change; invokes the extracted `pruneStaleWikiFiles(outputDir, newFiles, ["journal"])` directly (plain prefix strings, NOT globs — no `**` suffix — matching the GREEN contract); asserts `unlink` never called for the journal path. Both tests must fail before implementation (pruneStaleWikiFiles does not exist yet).
- [ ] GREEN: In `src/tools/wiki-tools.ts`, extract the cleanup loop at lines 512-525 into `export async function pruneStaleWikiFiles(outputDir: string, knownFiles: Set<string>, protectedPrefixes: string[]): Promise<string[]>` returning an array of deleted file paths. **The `protectedPrefixes` array contains plain path-prefix strings (e.g., `"journal"`), not globs — the function does not interpret `*` or `**`.** Expected invariant: skip any entry `f` where `f === p` OR `f.startsWith(p + "/")` for any `p ∈ protectedPrefixes`. The implementation may use any idiomatic Node.js API (e.g., `readdir({ withFileTypes: true })` + `dirent.isDirectory()`, or plain string comparisons) as long as this invariant holds. Update `generateWiki` to call the helper with `protectedPrefixes: ["journal"]` by default.
- [ ] Verify: `npx vitest run tests/integration/wiki-cleanup-journal-guard.test.ts`
  Expected: `Tests: 2 passed` and exit code 0.
- [ ] Acceptance: Ship-1, Ship-2, FM-D (wiki cleanup guard mis-type scenario)
- [ ] Commit: `extract pruneStaleWikiFiles helper with two-path journal guard`

### Task 2: Journal sentinel state-machine parser + hash + integrity error

**Files:**
- `src/tools/journal-sentinel.ts` (create)
- `tests/tools/journal/sentinel.test.ts` (create)

**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/journal/sentinel.test.ts` covering: (a) parse `auto:begin meta` → `auto:end meta` returns a block with matching kind and content; (b) parse `manual:begin migrated-overview` → `manual:end migrated-overview` returns a `manual`-prefixed block; (c) SHA-256 of known content matches a frozen expected hash after LF normalisation + trailing-whitespace strip; (d) unclosed `auto:begin meta` (EOF without end) throws `SentinelIntegrityError` with line number; (e) nested `auto:begin X` → `auto:begin Y` throws; (f) mismatched kind (`auto:begin meta` → `auto:end phase-summary`) throws; (g) `entry:2026-04-11` kind accepted, `entry:2026-13-99` (invalid ISO date) rejected; (h) `source_commits` comment line required as last line inside `entry:` blocks, missing it raises; (i) `auto:begin unknown-kind` treated as prose (parser ignores, lint-level check elsewhere).
- [ ] GREEN: Create `src/tools/journal-sentinel.ts` exporting: `parseSentinelBlocks(content: string): Array<{ prefix: "auto" | "manual"; kind: string; content: string; startLine: number; endLine: number; hash: string }>`, `computeBlockHash(blockContent: string): string` (SHA-256 of UTF-8 bytes after LF normalisation), `SentinelIntegrityError` class with `line: number` property. Implement as a line-by-line state machine with states `OUTSIDE | INSIDE_AUTO | INSIDE_MANUAL`. Valid `auto:` kinds: `meta | phase-summary | entry:YYYY-MM-DD`. Valid `manual:` kinds: `migrated-overview`. Validate `entry:` suffix via ISO date regex `^\d{4}-\d{2}-\d{2}$`. File ≤ 170L (see Tech Lead estimate).
- [ ] Verify: `npx vitest run tests/tools/journal/sentinel.test.ts`
  Expected: `Tests: 9+ passed` and exit code 0.
- [ ] Acceptance: Ship-1, Ship-4a, E1, E3, E12 (malformed output validator reuse), FM-B (all 3 sentinel failure scenarios)
- [ ] Commit: `add journal-sentinel state machine with SHA-256 block hashing`

### Task 3: Prototype fixture byte-copy + verification script

**Files:**
- `tests/fixtures/journal/prototype-history.md` (create — byte copy of `.codesift/wiki/history.md`)
- `scripts/verify-prototype-fixture.sh` (create)

**Complexity:** standard
**Dependencies:** none

- [ ] RED: Script-level smoke: add `tests/scripts/verify-prototype-fixture.test.ts` that runs `bash scripts/verify-prototype-fixture.sh` and asserts exit code 0 when fixture matches current prototype, exit code 1 when a trailing modification is made to a copy.
- [ ] GREEN: `scripts/verify-prototype-fixture.sh` computes SHA-256 of `.codesift/wiki/history.md` and `tests/fixtures/journal/prototype-history.md`; exits 0 if equal, exits 1 with a message otherwise. Copy current prototype to the fixture path at creation time. Add the script to CI as a non-blocking check (documentation failure, not release gate).
- [ ] Verify: `bash scripts/verify-prototype-fixture.sh` → exit 0; `echo x >> tests/fixtures/journal/prototype-history.md && bash scripts/verify-prototype-fixture.sh` → exit 1 (then revert the edit).
- [ ] Acceptance: Ship-7 (migration fixture prerequisite), Open Q2 (fixture drift mitigation)
- [ ] Commit: `add prototype fixture byte-copy with drift verification script`

### Task 4: Manifest v2.1 type union + JSON schema mirror

**Files:**
- `src/tools/wiki-manifest.ts` (modify)
- `schemas/wiki-manifest-v2.schema.json` (modify)
- `tests/tools/wiki-manifest.test.ts` (modify: add JournalPageEntry round-trip)

**Complexity:** complex
**Dependencies:** none
**Execution routing:** deep implementation tier

- [ ] RED: Extend `tests/tools/wiki-manifest.test.ts` with: (a) `buildWikiManifest` accepts a `journalPages: JournalPageEntry[]` parameter and emits them alongside existing `pages`; (b) emitted manifest has `manifest_schema_version: "2.1.0"` as a top-level field; (c) a `JournalPageEntry` with `type: "journal-phase"`, `source: "ai-authored"`, `journal_content_hashes: { "phase-summary": "<sha>" }` round-trips through `buildWikiManifest` unchanged; (d) optional `parent_slug` field present on weekly split entries; (e) AJV validation passes against updated `schemas/wiki-manifest-v2.schema.json`. Test must reference typed imports, not `any`.
- [ ] GREEN: In `src/tools/wiki-manifest.ts` add `export type JournalPageKind = "journal-overview" | "journal-rollup" | "journal-phase"`; `export interface JournalPageEntry { slug: string; title: string; type: JournalPageKind; file: string; outbound_links: string[]; source: "generated" | "ai-authored" | "hand-written"; journal_content_hashes?: Record<string, string>; parent_slug?: string; }`. Change `WikiManifest.pages` to `Array<PageInfo["type"] extends... | JournalPageEntry>` — discriminated union preserving exhaustive switch. Add top-level `manifest_schema_version: "2.1.0"` field. Widen `buildWikiManifest` to accept `journalPages?: JournalPageEntry[]`. In `schemas/wiki-manifest-v2.schema.json`, extend `PageEntry.type` enum with 3 new literals; add optional `source`, `journal_content_hashes`, `parent_slug` properties; add mandatory top-level `manifest_schema_version` string field.
- [ ] Verify: `npx tsc --noEmit && npx vitest run tests/tools/wiki-manifest.test.ts && npx ajv validate -s schemas/wiki-manifest-v2.schema.json -d tests/fixtures/wiki-manifest-v2.1-example.json`
  Expected: tsc exit 0, vitest `Tests: N+5 passed`, ajv prints `valid`. The fixture `tests/fixtures/wiki-manifest-v2.1-example.json` is a new ephemeral test artifact (created in this task) containing a hand-crafted minimal manifest conforming to v2.1 — NOT the on-disk repo manifest (which legitimately lacks `manifest_schema_version` until Task 10 writes it). Strict validation on a controlled fixture eliminates ajv tolerance.
- [ ] Acceptance: Ship-1, Ship-3, Ship-8, E5 (parent_slug) — **IC-3 moved to Task 15 exclusively** (IC-3 concerns MCP `generate_wiki` schema extension, owned by Task 15; this task owns only the manifest type/schema surface)
- [ ] Commit: `extend WikiManifest with JournalPageEntry discriminated union and schema_version 2.1.0`

### Task 5: Optional dependencies `@anthropic-ai/sdk` + `yaml`

**Files:**
- `package.json` (modify)

**Complexity:** standard
**Dependencies:** none

- [ ] RED: Docs-only — no test required per CQ13 exception for config changes. Instead add a one-line assertion in `tests/tools/journal/llm-client.test.ts` (deferred until Task 8) that the dynamic import pattern works; for this task, confirm dependencies resolve via `npm install --dry-run`.
- [ ] GREEN: In `package.json` `optionalDependencies`, add `"@anthropic-ai/sdk": "^0.70.0"` (latest stable compatible with Node 20+) and `"yaml": "^2.7.0"`. Do not add to direct `dependencies`. Run `npm install --ignore-scripts` to update lockfile.
- [ ] Verify: `npm install --ignore-scripts --dry-run 2>&1 | grep -E "@anthropic-ai/sdk|^yaml" | head -5`
  Expected: output contains both package names marked as optional.
- [ ] Acceptance: Deliverable (optional deps)
- [ ] Commit: `add optional deps @anthropic-ai/sdk and yaml for journal LLM + config parsing`

### Task 6: Journal git-client (isolated child_process wrapper)

**Files:**
- `src/tools/journal-git-client.ts` (create)
- `tests/tools/journal/git-client.test.ts` (create)

**Complexity:** standard
**Dependencies:** none

- [ ] RED: Create `tests/tools/journal/git-client.test.ts` mocking `node:child_process.execFileSync` and asserting: (a) `gitLog({ since, maxCount })` invokes `git log --pretty=format:<pinned-format> --all` with correct args; (b) parses output into typed `GitCommit[]` with `sha`, `date`, `authorName` (NOT email — CQ5 privacy), `subject`, `parentShas`, `refs`; (c) handles empty log (exit 0 with no output) returning `[]`; (d) handles git exit 128 (repo with zero commits) by returning `[]` without throwing; (e) 10-second timeout enforced via `execFileSync({ timeout: 10000 })`; (f) `git log --pretty=format:` string is exported as a named constant `GIT_LOG_FORMAT`.
- [ ] GREEN: Create `src/tools/journal-git-client.ts` with pinned format **using the ASCII Unit Separator (`%x1F`, byte 0x1F) as the field delimiter**, NOT the pipe character — commit subjects commonly contain `|` (e.g., `"fix: handle edge case | refactor API"`) which would corrupt pipe-split parsing. Format string: `GIT_LOG_FORMAT = "%H%x1F%aI%x1F%an%x1F%s%x1F%P%x1F%D"` stored as an exported module-level constant. Export `gitLog(opts: GitLogOptions): GitCommit[]` using `execFileSync("git", [...args], { encoding: "utf-8", timeout: GIT_TIMEOUT_MS })` — never `exec()` to avoid shell injection. Parse by splitting each output line on `"\x1F"` (unit separator). Do not emit or log `%ae` (author email, CQ5). File ≤ 90L.
- [ ] Verify: `npx vitest run tests/tools/journal/git-client.test.ts`
  Expected: `Tests: 6 passed`.
- [ ] Acceptance: Ship-1, CQ5 (no PII), CQ8 (timeout)
- [ ] Commit: `add journal-git-client with pinned log format and privacy-safe fields`

### Task 7: Phase detector + YAML override merger

**Files:**
- `src/tools/journal-phase-detector.ts` (create)
- `tests/tools/journal/phase-detector.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 6

- [ ] RED: Create `tests/tools/journal/phase-detector.test.ts` covering: (a) tag-based boundary: two commits flanking a `v1.0.0` ref produce two phases; (b) merge-based boundary: merge commit with 2+ parent refs creates boundary; (c) gap-based: commits separated by >2 days split into distinct phases; (d) YAML override wins: `journal-phase-boundaries.yaml` entry for `2026-04-11` produces a phase named as in YAML, auto-detection ignored for that date; (e) multi-day commit straddling boundary attached to later phase (deterministic tiebreaker); (f) unclassified commit → phase slug `unclassified`; (g) slug-collision on two weeks with identical slugified titles detected and flagged; (h) YAML parse error produces typed error with line number.
- [ ] GREEN: Create `src/tools/journal-phase-detector.ts`. Export `detectPhases(commits: GitCommit[], overrides?: PhaseOverride[]): PhasePlan[]`. Implement heuristics in this order: merge refs → tags → 2-day gaps → theme keywords (from commit subjects). Merge YAML overrides on top (manual wins). Emit `PhasePlan { slug, title, startDate, endDate, commits: GitCommit[], source: "auto" | "manual" }`. YAML parsed via dynamic `import('yaml')` with fallback to minimal inline parser if optional dep absent (matches Tech Lead's decision). File ≤ 160L.
- [ ] Verify: `npx vitest run tests/tools/journal/phase-detector.test.ts`
  Expected: `Tests: 8 passed`.
- [ ] Acceptance: Ship-1, E4 (YAML override), FM-C (3 phase-detector failure modes)
- [ ] Commit: `add journal-phase-detector with auto heuristics and YAML override merger`

### Task 8: LLM client with provider interface + scaffold fallback + cost accounting

**Files:**
- `src/tools/journal-llm-client.ts` (create)
- `tests/tools/journal/llm-client.test.ts` (create)

**Complexity:** complex
**Dependencies:** Task 5
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/journal/llm-client.test.ts` with `vi.stubEnv` / `vi.unstubAllEnvs` in `beforeEach`/`afterEach`. Cover: (a) `resolveCredentialsForModel("claude-sonnet-4-6")` returns `"ANTHROPIC_API_KEY"`, `"gpt-4o-mini"` returns `"OPENAI_API_KEY"`, unknown returns `null`; (b) `AnthropicJournalProvider` with mocked `@anthropic-ai/sdk` constructor returns structured `LlmResult { content, tokensInput, tokensOutput, costUsd }`; (c) 30s timeout enforced — mock hanging call, assert timeout error after `LLM_TIMEOUT_MS`; (d) 503 retry: 2 retries with exponential backoff, then `ScaffoldFallbackProvider` invoked; (e) 429 rate-limit: immediate fallback with checkpoint-friendly error; (f) cost accounting post-call: tokens × per-model pricing stored in returned result; (g) `CODESIFT_JOURNAL_MODEL=claude-haiku-4-5` with `ANTHROPIC_API_KEY` unset → `ScaffoldFallbackProvider` used, result carries `provider: "scaffold"`; (h) `CODESIFT_JOURNAL_MAX_USD=1.00` respected — when running total would exceed, provider raises `CostCapExceededError` before next call; (i) malformed JSON from LLM triggers one retry then scaffold.
- [ ] GREEN: Create `src/tools/journal-llm-client.ts`. Named constants: `LLM_TIMEOUT_MS = 30_000`, `LLM_MAX_RETRIES = 2`, `DEFAULT_MAX_COST_USD = 2.00`, `MODEL_PRICING: Record<string, { input: number; output: number }>` (per-million-token USD from published Anthropic/OpenAI catalogs). Interface `JournalLlmProvider { generate(prompt, options): Promise<LlmResult> }`. Three implementations: `AnthropicJournalProvider` (dynamic `import('@anthropic-ai/sdk')`), `OpenAiJournalProvider` (dynamic `import('openai')`), `ScaffoldFallbackProvider` (returns `LlmResult` with empty AI sections + TODO placeholders). `resolveCredentialsForModel(modelId)` exported as the ONLY credential gating site (CQ14). `selectProvider(options)` composes: resolve model → resolve credential → if credential present attempt real provider with retries → on total failure return scaffold. File ≤ 200L.
- [ ] Verify: `npx vitest run tests/tools/journal/llm-client.test.ts`
  Expected: `Tests: 9 passed`.
- [ ] Acceptance: Ship-1, Ship-6, Ship-10, FM-A (4 LLM provider failure modes), CQ3 (boundary validation), CQ8 (timeouts), CQ14 (single gating site), CQ28 (timeout hierarchy)
- [ ] Commit: `add journal-llm-client with provider interface, scaffold fallback, and cost cap`

### Task 9: Journal templates + 4-beat grammar validator

**Files:**
- `src/tools/journal-templates.ts` (create)
- `tests/tools/journal/templates.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 7 (for `PhasePlan` type from phase-detector)

- [ ] RED: Create `tests/tools/journal/templates.test.ts` covering: (a) `renderPhaseSummaryPrompt(phase: PhasePlan)` returns a string containing commit SHAs, commit subjects, date range, and the 4-beat instruction block; (b) `renderEntryPrompt(date, commits)` similar for per-day; (c) `validateLlmResponse(text)` accepts output with `## Intent`, `## Reality`, `## Significance`, `## Lessons` in that order; (d) validator rejects response missing any of the 4 H2 anchors; (e) validator rejects response with anchors out of order; (f) `buildScaffoldResponse(phase)` produces 4-beat markdown with `<!-- TODO: journal provider not configured -->` placeholders under each H2; (g) prompts include `source_commits` guidance so LLM emits the mandatory footer line per E1.
- [ ] GREEN: Create `src/tools/journal-templates.ts`. Export `renderPhaseSummaryPrompt`, `renderEntryPrompt`, `validateLlmResponse`, `buildScaffoldResponse`. Pure functions — no I/O. 4-beat anchor regex: `/^## Intent$\n[\s\S]*?^## Reality$\n[\s\S]*?^## Significance$\n[\s\S]*?^## Lessons$/m`. File ≤ 130L.
- [ ] Verify: `npx vitest run tests/tools/journal/templates.test.ts`
  Expected: `Tests: 7 passed`.
- [ ] Acceptance: Ship-1, E12 (malformed output handling)
- [ ] Commit: `add journal-templates with 4-beat grammar validator and scaffold builder`

### Task 10: Journal generator orchestrator (TOCTOU + lockfile + cost cap + checkpoint)

**Files:**
- `src/tools/journal-generator.ts` (create — public entry points only)
- `src/tools/journal-generator-helpers.ts` (create — pure helper functions extracted from the start)
- `tests/tools/journal/generator.test.ts` (create)

**Pre-decided file split** (no runtime decision): `journal-generator.ts` exports only `runJournalInit`, `runJournalAppend`, `runJournalRegenerate`, `refreshOverviewAndRollup`, and the private `processPhase(phase, context)` injection seam. `journal-generator-helpers.ts` exports pure helper functions: `assertBlockUnchanged(fileContent, blockKind, preHash)`, `acquireLock(lockPath)`, `releaseLock(lockPath)`, `readCheckpoint(path)`, `writeCheckpoint(path, state)`, `enforceBudgets(files)`. All helpers are pure (no module-level state) and exercised via `generator.test.ts` mock seams, so no dedicated helpers.test.ts is needed.

**Complexity:** complex
**Dependencies:** Task 1, 2, 4, 6, 7, 8, 9
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/journal/generator.test.ts`. Use `vi.mock` for `journal-sentinel`, `journal-llm-client`, `journal-phase-detector`, `journal-templates`, `journal-git-client`, and `node:fs/promises`. Cover: (a) happy path: phase file written with correct sentinel blocks, hash recorded in manifest; (b) TOCTOU guard: pre-hash and post-hash match → writes; mismatch → exits code 2, writes nothing, calls `rename` zero times; (c) `--force` on mismatch → writes with WARN stderr message `WARN journal: forced overwrite`; (d) cost cap: mock llm-client to report high tokens; after N phases exceed `CODESIFT_JOURNAL_MAX_USD`, generator aborts with checkpoint written; (e) resume: re-run with existing checkpoint → phases in `completed[]` skipped; (f) lockfile: second concurrent invocation returns `"journal operation already in progress"`; (g) `--dry-run`: returns plan, writes nothing, no LLM calls; (h) `--bulk-fill` mode: non-empty `phases/` dir with TODO placeholders does NOT trigger abort; (i) readability budgets: generator asserts `rollup.md` ≤ 12000 bytes and `overview.md` ≤ 6000 bytes before write; (j) `manual:begin migrated-overview` block in `overview.md` preserved across regeneration (not overwritten, not hash-checked); (k) E8 guard: non-empty `phases/` without TODO placeholders and no `--bulk-fill` → abort with instruction to use `journal append`; (l) per-phase processing extracted into `processPhase(phase, context)` for injection-seam testability.
- [ ] GREEN: Create `src/tools/journal-generator.ts` exporting ONLY the 4 public orchestrator functions + private `processPhase`. Create `src/tools/journal-generator-helpers.ts` with all 6 pure helpers per the pre-decided split above — no conditional extraction, no wait-and-see. Use `Promise.allSettled` pattern from `wiki-tools.ts` for analyses that can parallelise; sequential LLM calls for cost accounting. Lockfile at `.codesift/wiki/journal/.init-lock` via `writeFile(lockPath, String(process.pid), { flag: "wx" })` + `try/finally releaseLock`. Atomic write: `writeFile(tmp)` → `rename(tmp, target)`. TOCTOU: re-read file + `computeBlockHash` after LLM call, compare to `preHash`; on mismatch without `--force` throw `BlockChangedError` and skip rename entirely. Target sizes: generator ≤ 200L body (service 4 methods), helpers ≤ 100L body (utility). Both within CQ11 limits with the pre-decided split.
- [ ] Verify: `npx vitest run tests/tools/journal/generator.test.ts && npx tsc --noEmit`
  Expected: `Tests: 12 passed`, tsc exit 0.
- [ ] Acceptance: Ship-1, Ship-4b, Ship-10, S5 (readability budgets), E2, E5 (split + parent_slug), E8, E11, FM-Checkpoint (4 scenarios), CQ15, CQ21 (TOCTOU)
- [ ] Commit: `add journal-generator orchestrator with TOCTOU guard, lockfile, cost cap, and checkpointing`

### Task 11: Journal migrator (prototype history.md → phase files, 2-step dry-run)

**Files:**
- `src/tools/journal-migrator.ts` (create)
- `tests/tools/journal/migrate.test.ts` (create)

**Complexity:** complex
**Dependencies:** Task 1 (cleanup guard must protect `journal/` before migrator writes files into it), Task 2, 3, 4
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/journal/migrate.test.ts`. Use `vi.mock("node:fs/promises")` for call-order verification (Q3). Cover: (a) `--dry-run`: reads source, computes SHA-256, writes `.migrate-state.json` with `{source_sha256, planned_phase_slugs, schema_version: "1"}`, creates `.codesift/wiki/journal/` directory via `mkdir -p` semantics; **after first `--dry-run` invocation, the migrator auto-appends `.codesift/wiki/journal/.migrate-state.json` to the repo's `.gitignore` file (Open Question #1 decision (a)) — failure to write `.gitignore` emits a warning but does not abort**; (b) live run without prior dry-run → exits code 1 with exact message `"No migration plan found. Run 'codesift journal migrate --dry-run' first to generate a migration plan, then run without --dry-run to execute."`; (c) live run with source SHA mismatch → exits code 1 with `"source file changed since dry-run (sha <new> ≠ <recorded>), aborting"`; (d) happy path against `tests/fixtures/journal/prototype-history.md` produces exactly 7 phase files with slugs derived from `### Week N —` headings (e.g., `2026-04-framework-wave.md`); (e) `### Week N` heading line preserved verbatim as first line of `My notes` block (E9 rule e); (f) multi-day entry `#### 2026-03-21 – 2026-03-23` keyed as `entry:2026-03-21` with full range in title (E9 rule d); (g) non-Week `##` sections (`At a glance`, `Themes across the project`, `Competitive context`, `Sources`) migrated into `<!-- manual:begin migrated-overview -->` block in `overview.md`; (h) `## Timeline` container heading produces no output (consumed, not migrated); (i) `.bak` file written BEFORE any phase-file write — verify via `vi.fn()` call order tracking; (j) snapshot assertion: normalised concatenation (LF, strip trailing, collapse blank lines) of (all 7 phase files' `My notes`) ∪ (migrated-overview block) ≡ prototype content minus `## Timeline` line; (k) zero-phase parse (source with no `### Week` headings) → abort with error; (l) slug collision (two weeks with identical slugified titles) → abort with actionable message; (m) `.gitignore` auto-append: if `.gitignore` already contains the exact line, no duplicate is written (idempotent); if the file does not exist, it is created with the journal path as the only entry; if write permission denied, a warning `WARN journal: could not update .gitignore` is emitted to stderr and the dry-run proceeds successfully.
- [ ] GREEN: Create `src/tools/journal-migrator.ts`. Export `runMigrate(opts: { source: string; dryRun: boolean })`. Parsing: line-based scan for `^## `, `^### Week `, `^#### \d{4}-\d{2}-\d{2}` patterns. Slug derivation: strip `Week N — ` prefix, lowercase, replace non-alphanumeric with `-`, prepend start-date month prefix (e.g., `2026-04-`). `.bak` written via `copyFile(source, source + ".bak")` before any phase file created. Dry-run state file at `.codesift/wiki/journal/.migrate-state.json`. Live-run validation: read state, recompute source SHA, compare. Atomic writes per Tech Lead pattern. **`.gitignore` auto-append helper:** `ensureGitignoreEntry(repoRoot, entry)` reads `.gitignore`, checks for exact line match, appends if absent (creates file if missing), catches write errors and logs `WARN journal: could not update .gitignore (<reason>); add `.codesift/wiki/journal/.migrate-state.json` manually.` Called once per dry-run invocation. File ≤ 200L.
- [ ] Verify: `npx vitest run tests/tools/journal/migrate.test.ts`
  Expected: `Tests: 13 passed`.
- [ ] Acceptance: Ship-1, Ship-7, E9 (all 5 rules including multi-day entries), FM-Migrator (5 scenarios), Open Question #1 (.gitignore auto-append)
- [ ] Commit: `add journal-migrator with dry-run+live two-step workflow and content preservation`

### Task 12: CLI handlers + kill switch test (7 commands)

**Files:**
- `src/cli/journal-commands.ts` (create)
- `tests/cli/journal-commands.test.ts` (create)
- `tests/cli/journal-kill-switch.test.ts` (create)
- `src/cli/commands.ts` (modify: register 7 new commands in COMMAND_MAP)

**Complexity:** complex
**Dependencies:** Task 10, 11
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/cli/journal-kill-switch.test.ts` asserting `CODESIFT_JOURNAL_ENABLED=false` causes every journal handler to exit with message `"journal disabled by CODESIFT_JOURNAL_ENABLED=false; set to 1 to enable"` and exit code 1, without invoking any generator/migrator mock. Create `tests/cli/journal-commands.test.ts` with mocks on `journal-generator` and `journal-migrator`. Cover: (a) `handleJournalInit` with `--dry-run` calls `runJournalInit({ dryRun: true })`; (b) `handleJournalAppend` requires `--since` — missing flag → exit 1 with clear message; (c) `handleJournalRefreshOverview` calls no LLM; (d) `handleJournalRegenerate` requires `--entry` XOR `--phase` — both or neither → exit 1; (e) `handleJournalLint` runs sentinel integrity check; (f) `handleJournalMigrate` with `--dry-run` writes state; without `--dry-run` checks state file exists; (g) `handleJournalStats` prints token/cost summary from checkpoint; (h) `--force` flag propagates from CLI to handler to generator for regenerate; (i) `CI=true` env defaults ambiguous invocation to `append` not `init`.
- [ ] GREEN: Create `src/cli/journal-commands.ts` with 7 exported `handle*` functions following `src/cli/wiki-commands.ts` pattern. Each handler: (1) read `CODESIFT_JOURNAL_ENABLED` first and short-circuit if false; (2) parse flags via existing `getFlag`/`getBoolFlag` from `src/cli/args.ts`; (3) lazy-import generator/migrator via `await import(...)`; (4) dispatch. Each handler ≤ 30L. Total file ≤ 180L. In `src/cli/commands.ts` `COMMAND_MAP`, register `"journal init"`, `"journal append"`, `"journal refresh-overview"`, `"journal regenerate"`, `"journal lint"`, `"journal migrate"`, `"journal stats"`.
- [ ] Verify: `npx vitest run tests/cli/journal-commands.test.ts tests/cli/journal-kill-switch.test.ts`
  Expected: `Tests: 16 passed` (9 command tests a-i + 7 kill-switch assertions, one per handler).
- [ ] Acceptance: Ship-1, Ship-4b (regenerate exit 2), Ship-5 (kill switch), E8 (CI=true default), CQ3 (CLI arg validation), CQ25 (handle* pattern)
- [ ] Commit: `add 7 journal CLI handlers with kill switch and --force propagation`

### Task 13: Wiki-lint journal exemption + sentinel integrity check + regression test

**Files:**
- `src/tools/wiki-lint.ts` (modify)
- `tests/tools/wiki-lint-orphan-nonjournal.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 2, Task 4, Task 17 (for `runCitationCheck` import in `--strict` dispatch)

- [ ] RED: Create `tests/tools/wiki-lint-orphan-nonjournal.test.ts`. Cover: (a) non-journal orphan `.md` (e.g., `stray.md` not in manifest) → lint emits orphan-page error with severity `"error"` and exit code 1 (regression: current behaviour preserved); (b) journal file registered in manifest at `journal/phases/foo.md` → no orphan error; (c) sentinel integrity check: if a phase file has `auto:begin meta` without `auto:end meta`, lint emits `sentinel-integrity` error with line number; (d) hash-mismatch warning: phase file edited since last manifest hash → lint emits `WARN journal:` warning with exit code 0 (non-blocking); (e) **`--strict` flag wires citation check**: `lintWiki(outputDir, { strict: true })` invokes `runCitationCheck(phaseFile)` from the citation-check module (imported from `scripts/journal-citation-check.ts`, exposed as `export function runCitationCheck(phaseFile, threshold)` — spec Integration Point 4, S4). A phase file with fabricated SHAs produces a `citation-ungrounded` lint warning; same file without `--strict` produces no such warning. Verified by mocking `runCitationCheck` and asserting it is called exactly once per journal phase entry in strict mode and zero times otherwise.
- [ ] GREEN: In `src/tools/wiki-lint.ts`, augment the orphan scan (lines 70-81) with an explicit `f === "journal" || f.startsWith("journal/")` guard and an explanatory comment cross-referencing the cleanup loop in `wiki-tools.ts`. Add a new `checkJournalSentinels(manifest, wikiDir)` function that, for every page with `type: "journal-*"`, reads the file, calls `parseSentinelBlocks` from `journal-sentinel.ts`, emits `SentinelIntegrityError` as a lint issue, and compares block hashes to `manifest.pages[i].journal_content_hashes`. **Add `--strict` dispatch**: when the `strict` option is set (passed through from `handleJournalLint` CLI `--strict` flag), import `runCitationCheck` from `scripts/journal-citation-check.ts` (expose as a module export from that script) and invoke it for every `type: "journal-phase"` entry; surface each ungrounded citation as a `LintIssue { type: "citation-ungrounded", severity: "warning", file, line, message }`. Task 17 exposes `runCitationCheck` as an exported function (not just a script entry point) to enable this import.
- [ ] Verify: `npx vitest run tests/tools/wiki-lint-orphan-nonjournal.test.ts tests/tools/wiki-lint.test.ts`
  Expected: existing wiki-lint tests still pass (regression) AND new tests `Tests: 5 passed`.
- [ ] Acceptance: Ship-1, Ship-4a, IC-1 (orphan exemption regression), E3 (sentinel integrity via lint), **S4 (citation gate CLI path)**
- [ ] Commit: `add wiki-lint journal exemption and sentinel integrity check`

### Task 14: Chunker journal path override + non-journal regression test

**Files:**
- `src/search/chunker.ts` (modify)
- `tests/search/chunker-nonjournal-skip.test.ts` (create)

**Complexity:** standard
**Dependencies:** none

- [ ] RED: Create `tests/search/chunker-nonjournal-skip.test.ts`. Cover: (a) `shouldSkipChunking("src/journal/api.ts", content)` — user folder named "journal" NOT in wiki path — returns normal behaviour (non-.md → chunked, .md → skipped); (b) `shouldSkipChunking("backend/journal/notes.md", content)` — any other path with `/journal/` NOT anchored to `.codesift/wiki/journal/` — still skipped per `.md` rule; (c) `shouldSkipChunking(".codesift/wiki/journal/phases/foo.md", content < 60KB)` → returns false (chunkable); (d) `shouldSkipChunking(".codesift/wiki/journal/phases/foo.md", content > 60KB)` → returns true; (e) regression: `shouldSkipChunking("README.md", content)` still returns true.
- [ ] GREEN: In `src/search/chunker.ts`, add module-level constant `const JOURNAL_MAX_FILE_BYTES = 60_000`. In `shouldSkipChunking`, prepend a precise path check: `if (file.includes("/.codesift/wiki/journal/")) { return content.length > JOURNAL_MAX_FILE_BYTES; }`. This must run BEFORE the existing `SKIP_EXTENSIONS.has(ext)` check.
- [ ] Verify: `npx vitest run tests/search/chunker-nonjournal-skip.test.ts tests/search/chunker.test.ts`
  Expected: existing chunker tests still pass (regression) AND `Tests: 5 passed` new.
- [ ] Acceptance: Ship-1, IC-2 (chunker regression)
- [ ] Commit: `chunker indexes journal files under precise .codesift/wiki/journal/ anchor at 60KB ceiling`

### Task 15: Register `journal_append` MCP tool + extend `generate_wiki` schema + dispatch logic

**Files:**
- `src/register-tools.ts` (modify — schema + new tool)
- `src/tools/wiki-tools.ts` (modify — `generateWiki` dispatch on `journal_mode`)
- `tests/tools/register-tools-journal.test.ts` (create)

**Complexity:** complex
**Dependencies:** Task 4, 10
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/tools/register-tools-journal.test.ts` asserting: (a) `journal_append` appears in registered tool list with required `since: string` and optional `max_cost_usd: number`, `dry_run: boolean` in input schema; (b) `journal_append` without `since` is rejected by zod with clear error; (c) `generate_wiki` input schema gains 3 optional parameters `journal_mode` (enum with default `"skip"`), `journal_since_ref`, `journal_bulk_fill`; (d) `generate_wiki(journal_mode: "append")` without `journal_since_ref` returns error `"journal_since_ref required when journal_mode='append'"`; (e) `generate_wiki(journal_mode: "full")` without credential dispatches to generator which writes scaffold + `degraded_reasons: ["journal: no <provider> API key, wrote scaffold"]`.
- [ ] GREEN: In `src/register-tools.ts` (around line 1915 `generate_wiki` definition), extend input zod schema with the 3 optional params. Add new tool `journal_append` definition near related MCP tools with schema `{ since: z.string(), max_cost_usd: z.number().optional().default(2.0), dry_run: z.boolean().optional().default(false) }`. Handler dispatches to `runJournalAppend` from journal-generator. Validate CQ3 boundary (all inputs zod-checked). **In `src/tools/wiki-tools.ts`, modify `generateWiki` to inspect the `journal_mode` option after the existing analysis fan-out**: when `"skip"` (default) → behave as before (no journal work); when `"refresh-overview"` → delegate to `refreshOverviewAndRollup()` from journal-generator; when `"append"` → delegate to `runJournalAppend({ since: opts.journal_since_ref, ... })`; when `"full"` → delegate to `runJournalInit({ bulkFill: opts.journal_bulk_fill ?? false, ... })`. On missing `journal_since_ref` for `"append"`: return result with `degraded_reasons: ["journal_since_ref required when journal_mode=append"]` (MCP-level validation should also catch this before reaching here, but defence-in-depth). The dispatch is a single delegation block ≤ 15L to avoid inflating `generateWiki` body length (CQ11).
- [ ] Verify: `npx vitest run tests/tools/register-tools-journal.test.ts && npx tsc --noEmit`
  Expected: `Tests: 5 passed`, tsc exit 0.
- [ ] Acceptance: Ship-1, Ship-3, IC-3, CQ3
- [ ] Commit: `register journal_append MCP tool and extend generate_wiki schema with journal_mode/since_ref/bulk_fill`

### Task 16: Instructions H15 hint

**Files:**
- `src/instructions.ts` (modify)
- `tests/instructions.test.ts` (modify — file is at `tests/` root, not `tests/tools/`)

**Complexity:** standard
**Dependencies:** none

- [ ] RED: Add a new `it("includes H15 journal hint", ...)` test block in `tests/instructions.test.ts` asserting `CODESIFT_INSTRUCTIONS` contains both `"H15"` and `".codesift/wiki/journal/"`. Baseline test count in this file is 10 (verified via `npx vitest run tests/instructions.test.ts --reporter=basic`); after this task it becomes 11.
- [ ] GREEN: Append to `CODESIFT_INSTRUCTIONS` in `src/instructions.ts` the H15 hint text: `"H15 — journal fetch: use search_text(query=<term>, glob='.codesift/wiki/journal/**') rather than reading whole phase files; phase files can be 30KB+."`.
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: `Tests: 11 passed` (or, if pre-existing H12/H13/H14 assertions are currently failing due to unrelated bug, `Tests: N passed, 1+ failed` where N matches current-baseline-passing-count + 1 for H15; resolving unrelated H12/H13/H14 assertions is out of scope for this task).
- [ ] Acceptance: Deliverable (H15 hint)
- [ ] Commit: `add H15 instruction hint for journal retrieval pattern`

### Task 17: Citation-check script + golden fixture

**Files:**
- `scripts/journal-citation-check.ts` (create)
- `tests/fixtures/journal/citation-golden.md` (create)
- `tests/scripts/journal-citation-check.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 6

- [ ] RED: Create `tests/scripts/journal-citation-check.test.ts`. Cover: (a) run script against `tests/fixtures/journal/citation-golden.md` (hand-crafted with exactly 20 literals: 15 grounded in the project's real git log, 5 fabricated SHAs/dates/versions) → script reports 75% grounded (15/20), exits 0; (b) run against a file with <80% grounded → exits 1; (c) literal extraction grammar regex test: `/[a-f0-9]{7,40}/g` for SHAs, `/\d{4}-\d{2}-\d{2}/g` for dates, `/^v\d+\.\d+\.\d+/gm` for version tags inside backticks.
- [ ] GREEN: Create `scripts/journal-citation-check.ts` with deterministic grammar extraction (no NLP). Cross-check every SHA against `git log --all --format=%H`, every date against real commit dates, every version tag against `git tag -l`. Report: total literals, grounded count, percentage, list of ungrounded with location. **Dual-mode export**: alongside the CLI entry (`main` block invoked by `npx tsx scripts/journal-citation-check.ts ...`), export a reusable `export function runCitationCheck(phaseFile: string, threshold: number): CitationResult` function so `wiki-lint.ts` can import it for the `--strict` dispatch (Task 13). File ≤ 140L. Create `tests/fixtures/journal/citation-golden.md` as a plain markdown file with 15 real SHAs (from current repo HEAD~0..HEAD~30) and 5 fabricated literals (e.g., `abcdef1234567`, `9999-12-31`, `` `v99.99.99` ``).
- [ ] Verify: `npx tsx scripts/journal-citation-check.ts tests/fixtures/journal/citation-golden.md --threshold 70`
  Expected: stdout contains `Grounded: 15/20 (75.0%)`, exit code 0 (75% ≥ 70 threshold passes; production use defaults to 95%).
- [ ] Acceptance: Ship-1, S4
- [ ] Commit: `add journal-citation-check script with deterministic literal extraction grammar`

### Task 18: V1 rollback coexistence integration test

**Files:**
- `tests/integration/wiki-v1-journal-coexist.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 1, 13, 15

- [ ] RED: Create `tests/integration/wiki-v1-journal-coexist.test.ts`. Setup: tmpdir with `.codesift/wiki/journal/phases/foo.md` (valid sentinel structure) and `.codesift/wiki/wiki-manifest.json` at schema v2.0 (pre-journal). Set `CODESIFT_WIKI_V1=1`. Cover: (a) `generateWiki(outputDir)` runs without throwing, does NOT touch `journal/` directory; (b) `lintWiki(outputDir)` exits 0, no orphan-page errors for journal files; (c) after the run, `journal/phases/foo.md` still exists with original content (byte-equal to initial).
- [ ] GREEN: Implementation-only task — if tests fail, trace back to Tasks 1, 13, or 15 and fix. Most likely source of failure: the journal-path guard in `pruneStaleWikiFiles` depends on `outputDir` containing literal `"journal"` subdirectory name, which holds regardless of V1 mode; the wiki-lint exemption is unconditional; the chunker override is unconditional. Expected: no code changes needed; this task is primarily verification.
- [ ] Verify: `CODESIFT_WIKI_V1=1 npx vitest run tests/integration/wiki-v1-journal-coexist.test.ts`
  Expected: `Tests: 3 passed`.
- [ ] Acceptance: Ship-1, Ship-9
- [ ] Commit: `add V1 rollback integration test asserting journal files coexist unmolested`

### Task 19: Retrieval benchmark script + canonical query set

**Files:**
- `scripts/journal-retrieval-benchmark.ts` (create)
- `benchmarks/journal-queries.yaml` (create)
- `tests/scripts/journal-retrieval-benchmark.test.ts` (create — dry-run smoke only)

**Complexity:** standard
**Dependencies:** Task 12

- [ ] RED: Create `tests/scripts/journal-retrieval-benchmark.test.ts` covering: (a) script with `--dry-run` flag loads `benchmarks/journal-queries.yaml`, prints parsed query plan to stdout, invokes NO agents, exits 0; (b) YAML contains exactly 20 entries each with `query`, `expected_phase_slug`, `expected_commit_shas[]`, `forbidden_claims[]`; (c) script respects `CLAUDE_BENCH_MODEL` env override and prints the effective model to stdout.
- [ ] GREEN: Create `benchmarks/journal-queries.yaml` with 20 canonical queries (drafted from spec S1 examples: "when did scan_secrets land and why?", "what happened in the framework wave?", "why did we change from MIT to BSL-1.1?", …). Each entry carries deterministic adjudication rubric. Create `scripts/journal-retrieval-benchmark.ts` with `--dry-run` support and a runner that (in live mode, not exercised here) would shell out to Claude Code cold sessions and compute pass/fail per rubric. Pin model via `CLAUDE_BENCH_MODEL=claude-sonnet-4-6` default, temperature 0, seed. Output: JSON with per-query result + mean tool-call count. File ≤ 150L.
- [ ] Verify: `npx tsx scripts/journal-retrieval-benchmark.ts --dry-run`
  Expected: stdout contains `20 queries loaded`, exit 0; `npx vitest run tests/scripts/journal-retrieval-benchmark.test.ts` passes.
- [ ] Acceptance: S1 (pre-merge dry-run; live run deferred to post-merge validation window)
- [ ] Commit: `add retrieval benchmark script with 20-query canonical set and deterministic adjudication rubric`

### Task 20: Cadence report script

**Files:**
- `scripts/journal-cadence-report.ts` (create)
- `tests/scripts/journal-cadence-report.test.ts` (create)

**Complexity:** standard
**Dependencies:** Task 6

- [ ] RED: Create `tests/scripts/journal-cadence-report.test.ts` mocking `child_process.execFileSync` for git log output. Cover: (a) counts `journal append` commits in `.codesift/wiki/journal/` path over last 30 days; (b) counts `My notes` edits; (c) output JSON shape `{ since_days: 30, appends: N, notes_edits: M, passes_threshold: boolean }` with threshold 4-or-2 per spec S3.
- [ ] GREEN: Create `scripts/journal-cadence-report.ts` using `journal-git-client.ts` helpers. Script arg: `--since <days>` (default 30). Output: JSON to stdout. File ≤ 60L.
- [ ] Verify: `npx vitest run tests/scripts/journal-cadence-report.test.ts`
  Expected: `Tests: 3 passed`.
- [ ] Acceptance: S3 (post-release telemetry)
- [ ] Commit: `add journal-cadence-report script for 30-day maintenance gate`

### Task 21: End-to-end integration test

**Files:**
- `tests/integration/journal-e2e.test.ts` (create)
- `tests/fixtures/journal/e2e-30-commit-repo/` (create fixture directory via setup script)

**Complexity:** complex
**Dependencies:** Task 10, 11, 12, 13, 14, 15, 18
**Execution routing:** deep implementation tier

- [ ] RED: Create `tests/integration/journal-e2e.test.ts`. Setup: `beforeAll` initialises a 30-commit git fixture repo in tmpdir via shell (`git init`, series of `git commit --allow-empty -m ...` with varying dates spanning 3 phases). Mock `journal-llm-client` to return deterministic `ScaffoldFallbackProvider`-like output (structured, not real LLM). Cover full cycle: (a) `runJournalInit({ source: tmpdir, dryRun: false })` produces `phases/*.md` + `overview.md` + `rollup.md` + valid manifest with `manifest_schema_version: "2.1.0"`; (b) `lintWiki(tmpdir)` exits 0 after init; (c) append 3 new commits → `runJournalAppend({ since: HEAD~3 })` adds exactly 3 new daily entries; (d) `runJournalRegenerate({ entry: <date>, force: true })` overwrites a single entry; (e) manifest `journal_content_hashes` updated after regenerate; (f) `CODESIFT_WIKI_V1=1 runWiki(tmpdir)` (non-journal wiki generate) does not touch `journal/`; (g) kill switch mid-sequence aborts cleanly.
- [ ] GREEN: Implementation-only — no new production code expected. If tests fail, trace to earlier tasks. Fixture repo creation as setup helper in the test file itself (self-contained).
- [ ] Verify: `npx vitest run tests/integration/journal-e2e.test.ts`
  Expected: `Tests: 7 passed`.
- [ ] Acceptance: Ship-1, Ship-7, Ship-8, Ship-9, all Ship criteria end-to-end validated
- [ ] Commit: `add end-to-end journal integration test on 30-commit fixture`

---

## Execution Notes

- **This plan is a DAG, not a linear sequence.** The task numbers are stable identifiers, not execution order. Executors MUST follow the `Dependencies:` field of each task — running a task before any of its listed dependencies is undefined behaviour. One cross-link breaks the numerical-ordering convention: **Task 13 depends on Task 17** (citation-check must exist before wiki-lint's `--strict` dispatch imports it). Run Task 17 before Task 13 regardless of number ordering.
- **Tasks 1-4 can proceed in parallel** (no inter-deps). In practice, run Task 1 FIRST to protect the prototype immediately from bulk deletion.
- **Tasks 17-20 are scripts** that don't block Ship criteria directly but provide S1/S3/S4 validation machinery.
- **Task 21 is the final integration gate** — its failure signals a bug in one of the 1-20 tasks, to be diagnosed and fixed there.
- **Per-merge CI gates** (from spec Validation Methodology): `npm test` + `tsc --noEmit` + `ajv validate` + Task 1 (D1) + Task 3 (fixture verify) + Task 11 (migrate snapshot) + Task 12 (kill switch) + Task 17 (citation golden).
- **Post-merge dry-run** (manual): follow spec Validation Methodology steps 1-10 on real prototype.
- **Post-release validation windows** (7-day S1/S4 full-corpus, 30-day S3): run Tasks 19 and 20 scripts on schedule.
