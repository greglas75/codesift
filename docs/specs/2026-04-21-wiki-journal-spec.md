# Wiki Journal — Design Specification

> **spec_id:** 2026-04-21-wiki-journal-0418
> **topic:** Wiki Journal (dual-audience project history pages)
> **status:** Approved
> **created_at:** 2026-04-21T04:18:19Z
> **reviewed_at:** 2026-04-21T04:35:00Z
> **approved_at:** 2026-04-21T04:50:00Z
> **approval_mode:** interactive
> **adversarial_review:** warnings
> **author:** zuvo:brainstorm

## Problem Statement

The CodeSift wiki today consists only of auto-generated structural pages (`index`, `community-<slug>`, `hubs`, `surprises`, `hotspots`, `framework`). None of them capture *why* the project moved the way it did: what the author was trying to do on a given day, what surprised him, what he learned, what he pivoted on. That information lives in three places today, and none of them are usable for agent or human retrieval at the right granularity:

- **Git log** — 709 commits across 34 active days. High fidelity on *what* changed, near-zero signal on *why* and *what was learned*.
- **Memory files** (`memory/*.md`) — decision records and competitive analyses, but indexed by topic, not by time.
- **A prototype `.codesift/wiki/history.md`** (~18 KB) written in a prior session as a proof-of-concept. It is already at risk: the wiki generator at `src/tools/wiki-tools.ts:522-525` deletes every `.md` file that is not in its `newFiles` set, so the prototype will be silently removed on the next `codesift wiki-generate` run.

Without a first-class project-history surface, agents that need historical context ("when did `scan_secrets` land and why?", "what was the framework wave?") fall back to expensive `git log` scans that produce raw commit messages without narrative or rationale. Humans reading the repo for the first time have no curated entry point to understand the project's trajectory, only release notes and commit subjects.

This spec defines a **long-term journal system** living under `.codesift/wiki/journal/` with three content tiers (overview, rollup, per-phase narrative), written primarily by an LLM grounded in `git log` data, with opt-in human overlay sections that survive regeneration. Metadata and structure are English; prose is author's choice (expected Polish mix for this repo).

If we do nothing: the prototype is deleted, agents keep spending 4-8 tool calls per historical query, and the project's build-in-public trajectory stays buried in commit subjects. The two-week implementation window pays back on the first cold-session retrieval that would otherwise have burned context budget scanning git log.

## Design Decisions

The four decision points surfaced in Phase 2 dialogue, each with the chosen option and rationale:

**DD1 — Scope: long-term system (not one-shot dump).**
Chosen: B (long-term system with ongoing updates, split files, append workflow, lint gates, migration tooling).
Why: a one-shot dump calcifies on day one; by day 30 it is already stale and the author has no reflex to touch it. A long-term system with `journal append` workflow matches how the author actually ships work.

**DD2 — File granularity: 3-tier hybrid (G3).**
Chosen: `overview.md` (auto TOC) + `rollup.md` (one-liner per day, SQLite-changes style) + `phases/<slug>.md` (per-phase narrative).
Why: different consumers have different needs. Cold-session agent lookup uses rollup (fast scan). Deep-context agent + human reader uses phase narrative. New contributor / onboarding uses overview as entry point. 2025 RAG best practice (contextual chunk enrichment) confirms this exact pattern.

**DD3 — Language: L2 (EN metadata, author-choice prose).**
Chosen: frontmatter keys, sentinel markers, date headers, tags, commit SHA, file paths, slug names — always English. Prose within narrative sections — author's choice (expected Polish for this author).
Why: BM25 tokenizer in `src/search/bm25.ts:37-50` is language-agnostic (no stemming). English metadata preserves retrieval quality. Author voice in prose preserves authenticity. Multi-contributor readability remains acceptable because all structural anchors are English.

**DD4 — Content source: S3 (LLM writes, human optional overlay).**
Chosen: AI generates 4-beat narrative (Intent/Reality/Significance/Lesson) from commit data. Human may optionally add `My notes` sections outside sentinel-marked AI blocks. AI never overwrites human content.
Why: the author's stated feedback (`feedback-auto-execute.md`) is to minimise friction. Pure manual (S1) abandons after 30 days by default. Pure AI (S3 without overlay) loses the author's real "why" and hallucinates rationale. S3 + overlay lets AI carry the scaffold + grounded facts while the human adds sentences only where it matters — the overlay lives in append-only sibling blocks that survive every regeneration.

**DD5 — Sentinel protocol for human/AI coexistence.**
Chosen: `<!-- auto:begin <kind> -->` / `<!-- auto:end <kind> -->` blocks delimit AI-written content. Everything outside is human-owned. Content-hash stored in manifest per block; mismatch aborts regeneration with diff output. Kinds: `meta`, `phase-summary`, `entry:YYYY-MM-DD`.
Why: Docusaurus/MkDocs pattern for mixed auto+manual content. Hash check makes the human-edit-inside-auto-block case fail loud instead of silent overwrite.

**DD6 — LLM provider: Anthropic Claude default, overridable, provider-aware credential gating.**
Chosen: default `claude-sonnet-4-6`. Env override `CODESIFT_JOURNAL_MODEL` accepts `claude-haiku-4-5` / `claude-opus-4-7` / OpenAI IDs (e.g., `gpt-4o-mini`). **Credential gating is provider-aware**: when `CODESIFT_JOURNAL_MODEL` is unset or starts with `claude-` the runtime checks `ANTHROPIC_API_KEY`; when it starts with `gpt-` the runtime checks `OPENAI_API_KEY`. Missing the correct credential for the selected model → graceful S2 scaffold fallback (agent-block from git, empty AI sections with TODO placeholders). `journal-llm-client.ts` owns this mapping; it exposes a single `resolveCredentialsForModel(modelId)` helper so every gating site (CLI handlers + MCP tool schema) uses the same logic.
Why: project is already in Claude API ecosystem (Claude Code + Agent SDK). Cost/quality sweet spot is Sonnet. Haiku 4.5 is cheap-path fallback. Hard fallback without the CORRECT API key means the feature still ships a functional scaffold on a fresh clone without silently treating an OpenAI-selected model as unavailable because of a missing Anthropic key.

**DD7 — Phase boundary detection: auto + YAML override.**
Chosen: heuristic auto-detection (branch merge + release tag + >2-day gap + commit theme shift). User override file `.codesift/wiki/journal/journal-phase-boundaries.yaml`. Manual entries always win; auto fills gaps only.
Why: heuristics are wrong ~5-10% of the time. YAML override is a cheap escape hatch that keeps the author as final authority on project structure without blocking the common case.

**DD8 — Cost cap default: $2.00 per invocation.**
Chosen: `CODESIFT_JOURNAL_MAX_USD=2.00` default. Cost computed post-call from LLM-reported tokens × per-model pricing table. Cap exceeded → checkpoint + abort.
Why: `journal init` on this repo's 709-commit history runs ~7-12 phase files with Sonnet pricing forecast $1–2 per full init; success criterion S2 targets ≤ $2.00. A $2.00 default cap accommodates the default-config happy path for the canonical init case. Appends are 1-2 LLM calls (cheap). Cap is a runaway-loop / retry-storm guard, not a normal-path constraint. User can lower with `CODESIFT_JOURNAL_MAX_USD=0.50` for Haiku-only workflows.

## Solution Overview

```
.codesift/wiki/journal/
├── overview.md                      ← auto, regenerated every run, legenda + TOC
├── rollup.md                        ← auto, regenerated every run, one-liner per day
├── journal-phase-boundaries.yaml    ← user-editable, overrides auto-detection
├── .init-checkpoint.json            ← resumable state for init/append
├── .migrate-state.json              ← migrator dry-run hash + checkpoint; gitignored
└── phases/
    ├── 2026-03-foundation.md
    ├── 2026-03-language-support.md
    ├── 2026-03-lsp-dashboard-convsearch.md
    ├── 2026-04-token-opt-sessions.md
    ├── 2026-04-framework-wave.md
    ├── 2026-04-wiki-lens.md
    └── 2026-04-ecosystem-polish.md
```

**Phase file template:**

```markdown
# Phase: Framework Wave (2026-04-11 – 2026-04-12)

<!-- auto:begin meta -->
phase_slug: framework-wave
date_range: 2026-04-11..2026-04-12
commits: 362
themes: [hono, kotlin, nestjs, sql, python, framework-intelligence]
key_releases: [v0.4.0, v0.5.0]
key_files: [src/tools/hono/**, src/tools/kotlin/**]
source_commits: [8e41b96, 98df7a7, ...]
<!-- auto:end meta -->

<!-- auto:begin phase-summary -->
## Intent
(AI-generated from commit messages + branch names)

## Reality
(AI-generated from diff stats + merge graph)

## Significance
(AI-generated grounded in repo state change)

## Lessons
(AI-generated from revert commits + follow-up fixes)
<!-- auto:end phase-summary -->

## My notes
(human free-form, survives regeneration, optional)

## Daily entries

### 2026-04-11 — The mega day

<!-- auto:begin entry:2026-04-11 -->
meta block + 4-beat AI narrative
<!-- auto:end entry:2026-04-11 -->

#### Additional context
(human optional per-day note)
```

**CLI workflow:**

```
codesift journal init                        # one-shot bulk generation from full git log
codesift journal append --since=<ref>        # idempotent append of new days/phases
codesift journal refresh-overview            # overview+rollup only, no LLM
codesift journal regenerate --entry=<date>   # force single entry
codesift journal regenerate --phase=<slug>   # force whole phase
codesift journal lint                        # sentinel integrity + hallucination check + drift
codesift journal migrate                     # one-shot migrate prototype history.md → phases/
codesift journal stats                       # tokens + cost + file sizes
```

**Control flow for `journal init`:**

1. Read `git log --all --pretty=format:<fields>` → commit dataset.
2. Detect phase boundaries (branch merges, release tags, gaps, theme shifts). Merge with `journal-phase-boundaries.yaml` overrides.
3. For each phase: check checkpoint, skip if already done. Else:
   a. Build prompt (commits + diff summary + branch graph).
   b. Read target phase file (if exists) → compute `pre_hash` of each sentinel block.
   c. Call LLM with cost accounting.
   d. Parse response into 4-beat structure; validate sentinel structure.
   e. **Re-read target file, recompute `post_hash` of each sentinel block** (TOCTOU guard: detects any concurrent edit during the 10-30s LLM call window).
   f. If `post_hash ≠ pre_hash` for any block AND `--force` not passed → abort entry with `ERROR journal: block <kind> in <file> changed during LLM call, aborting to preserve edit. Re-run when editor is closed.` Exit code 2.
   g. Else: write to `.tmp` sibling → atomic rename.
   h. Store new block hashes in manifest `journal_content_hashes`.
   i. Append checkpoint.
4. Regenerate `overview.md` and `rollup.md`, **but preserve any `manual:begin migrated-overview` block** (and any other human-owned sentinel blocks in `overview.md`) via the same hash-check mechanism as phase files. Generator's regeneration only rewrites the TOC + legend + linkable page list; the migrated-overview block is read, hash-verified, and re-emitted unchanged unless `--force` is passed.
5. Update `wiki-manifest.json` with new `type: "journal-*"` entries and `page.journal_content_hashes`.

## Detailed Design

### Data Model

**New TypeScript types (in `src/tools/wiki-manifest.ts`):**

```ts
export type JournalPageKind = "journal-overview" | "journal-rollup" | "journal-phase";

export interface WikiManifestV21 extends Omit<WikiManifestV2, "pages"> {
  manifest_schema_version: "2.1.0";
  pages: Array<WikiManifestV2["pages"][number] | JournalPageEntry>;
}

export interface JournalPageEntry {
  slug: string;
  title: string;
  type: JournalPageKind;
  file: string;
  outbound_links: string[];
  source: "generated" | "ai-authored" | "hand-written";
  journal_content_hashes?: Record<string, string>;  // kind → sha256 of content between sentinels
  parent_slug?: string;  // set on weekly split sub-files (E5); e.g., "framework-wave-week-1" → parent_slug: "framework-wave"
}
```

**Manifest JSON Schema update (`schemas/wiki-manifest-v2.schema.json`):**

- `PageEntry.type` enum extended with `"journal-overview" | "journal-rollup" | "journal-phase"`.
- New optional property `source` on `PageEntry`.
- New optional property `journal_content_hashes` (object, string values) on `PageEntry`.
- Top-level `manifest_schema_version` property added, defaults to `"2.1.0"`.

**Sentinel block contract:**

- Opening: exact string `<!-- auto:begin <kind> -->` on own line.
- Closing: exact string `<!-- auto:end <kind> -->` on own line. `<kind>` must match.
- Two sentinel prefixes exist: **`auto:begin` / `auto:end`** (AI-authored content, hash-checked, regen-overwritable with `--force`) and **`manual:begin` / `manual:end`** (human-authored content, NOT hash-checked, preserved verbatim by generator, never overwritten even with `--force`). Use `auto:` for LLM output and `manual:` for any content migrated from a human source.
- Valid `auto:` kinds: `meta`, `phase-summary`, `entry:YYYY-MM-DD` (last segment must match ISO date pattern).
- Valid `manual:` kinds: `migrated-overview` (overview.md only; holds content migrated from prototype `##` non-Week sections — human-owned, user can edit freely, generator re-emits unchanged).
- Content between `auto:` sentinels is hashed with SHA-256 (UTF-8 bytes, LF-normalised line endings). Hash stored in manifest. Mismatch on regen = abort unless `--force`.
- `manual:` blocks are NOT hash-checked — user edits are welcome and survive every generator run. They appear in the manifest with `source: "hand-written"` but carry no hash entry.
- Blocks may not nest. Parser errors on nested `auto:begin`/`manual:begin` or unmatched markers. `auto:` and `manual:` sentinels do not interleave.
- The distinction: `auto:` blocks exist to let the LLM write content safely (hash-check prevents silent stomping of user edits). `manual:` blocks exist to let humans write content safely (no hash gate means no "--force required" UX wart).

**Phase boundaries YAML:**

```yaml
phases:
  - slug: foundation
    title: "Foundation"
    start: 2026-03-13
    end: 2026-03-17
    themes: [bootstrap, cli, benchmarks, public-repo]
  - slug: framework-wave
    title: "Framework Wave"
    start: 2026-04-11
    end: 2026-04-12
    themes: [hono, kotlin, nestjs]
    split_threshold_commits: 200  # optional, triggers sub-file split if commits exceed
```

### API Surface

**New CLI commands (`src/cli/journal-commands.ts`):**

Each command follows the existing `handle*` pattern. Shared `--dry-run` flag across all commands returns the plan without side effects.

- `handleJournalInit(args)` — flags: `--dry-run`, `--max-cost=<USD>`, `--model=<id>`, `--since=<ref>` (default: project start), `--force` (bypasses TOCTOU sentinel hash check — required when re-running over an existing phase file that a user edited; logs `WARN journal: forced overwrite of edited block <kind> in <file>` to stderr), `--bulk-fill` (operates on phase files that already exist but have `<!-- TODO: … -->` placeholders in AI sections — fills them via LLM without aborting on "phases/ non-empty"; this is the documented path to move from scaffold-only state into LLM-filled state, and is also how `journal init` is invoked immediately after `journal migrate` in the post-merge workflow).
- `handleJournalAppend(args)` — flags: `--since=<ref>` (required), `--dry-run`, `--max-cost=<USD>`, `--force` (same semantics as above).
- `handleJournalRefreshOverview(args)` — no LLM; rebuilds overview + rollup from manifest.
- `handleJournalRegenerate(args)` — flags: `--entry=<date>` XOR `--phase=<slug>`, `--force` (bypasses hash check), `--prompt-override=<file>`.
- `handleJournalLint(args)` — flags: `--strict` (enables hallucination gate), `--fix` (auto-repairs broken sentinels where unambiguous).
- `handleJournalMigrate(args)` — flags: `--source=<path>` (default: `.codesift/wiki/history.md`), `--dry-run`. **IMPORTANT — migrate is the ONE command whose `--dry-run` has a documented side effect** (all other commands' `--dry-run` are pure plans). `journal migrate --dry-run` writes `.codesift/wiki/journal/.migrate-state.json` containing `{source_sha256: <sha>, planned_phase_slugs: [...], schema_version: "1"}`; it creates `.codesift/wiki/journal/` (recursively, `mkdir -p` semantics) if absent; nothing else is written. Live run (without `--dry-run`) reads this file and aborts if either (a) the file is missing — exit code 1, message: `"No migration plan found. Run 'codesift journal migrate --dry-run' first to generate a migration plan, then run without --dry-run to execute."` — or (b) `source_sha256` recomputed from current source ≠ recorded hash (source drift guard — see Migrator Failure Modes). This asymmetry is intentional: migration is destructive enough to warrant an explicit two-step confirmation. `--help` text for `journal migrate` documents the two-step workflow and the one-file side effect prominently so first-time users and automation policies are not surprised. Any tool enforcing a "dry-run = no side effects" global policy must either exempt `journal migrate` or use `journal migrate --plan-only` (alias identical to `--dry-run` but documented as a state-writing planner).
- `handleJournalStats(args)` — prints per-file token counts, cumulative LLM cost from checkpoint, sizes vs thresholds.

**MCP tool extension (`generate_wiki`):**

Adds optional parameters:
```ts
journal_mode: z.enum(["skip", "refresh-overview", "append", "full"]).default("skip"),
journal_since_ref: z.string().optional(),  // required when journal_mode === "append"; ignored otherwise
journal_bulk_fill: z.boolean().optional().default(false)  // when true with mode "full", fills TODO placeholders in existing scaffold phase files (matches CLI `journal init --bulk-fill`)
```
When `journal_mode === "append"` and `journal_since_ref` is missing → tool returns error `"journal_since_ref required when journal_mode='append'"` (no default ref because MCP callers are typically agents; an implicit default could silently reprocess the entire history).
Default `"skip"` preserves backward compatibility with pre-2.1 callers. When `"append"` or `"full"`: behaviour matches CLI exactly — if the provider-selected credential (per DD6) is missing, tool automatically writes scaffold output (not a failure) and includes `degraded_reasons: ["journal: no <provider> API key, wrote scaffold"]`. This eliminates CLI-vs-MCP behavioural divergence: an agent calling `generate_wiki(journal_mode: "full")` without a key gets the same scaffold files a CLI user would get. When `CODESIFT_JOURNAL_ENABLED=false` the tool short-circuits with `degraded_reasons: ["journal: disabled by CODESIFT_JOURNAL_ENABLED=false"]` and writes nothing.

**New standalone MCP tool `journal_append`:**

```ts
{
  name: "journal_append",
  description: "Append new journal entries for commits since a git ref.",
  inputSchema: {
    since: z.string().describe("Git ref (SHA, tag, HEAD~N). Required."),
    max_cost_usd: z.number().optional().default(2.0),  // matches DD8 default
    dry_run: z.boolean().optional().default(false),
  }
}
```

### Integration Points

Files modified in existing codebase:

1. **`src/tools/wiki-tools.ts:512-525`** — stale-page cleanup loop. Add guard:
   ```ts
   for (const f of existingFiles) {
     if (f === "journal" || f.startsWith("journal/")) continue;  // defence-in-depth: journal directory is guarded
     if (f.endsWith(".md") && !newFiles.has(f)) await unlink(...);
   }
   ```
   Guard rationale (important — future-maintainer trap): with `readdir(outputDir)` called non-recursively (as it is today), the entry for the `journal/` subdirectory appears as the bare string `"journal"`. The existing `f.endsWith(".md")` check already skips it since a directory name does not end with `.md`. The explicit `f === "journal"` guard is therefore **redundant today but defensive** — it is validated by the mandatory D1 integration test (`tests/integration/wiki-cleanup-journal-guard.test.ts`) and marks the intent so a maintainer does not later break it. The `f.startsWith("journal/")` clause is **inactive under non-recursive `readdir`** (entries like `"journal/phases/foo.md"` never appear); it correctly guards the recursive case if the loop is ever refactored. Do not remove either clause without updating the D1 test to match.

2. **`src/tools/wiki-manifest.ts:15`** — extend `type` union to include journal kinds. Add `source` and `journal_content_hashes` fields to `PageEntry`. Add top-level `manifest_schema_version: "2.1.0"`.

3. **`schemas/wiki-manifest-v2.schema.json:201`** — mirror enum extension + new fields.

4. **`src/tools/wiki-lint.ts:71-78`** — orphan-page rule exempts files under `journal/`. New sentinel-integrity check iterates every journal file and validates sentinel pairs + hashes. New hallucination check (only when `--strict`) shells out to `scripts/journal-citation-check.ts`.

5. **`src/search/chunker.ts:17-27`** — override `SKIP_EXTENSIONS` and `MAX_FILE_BYTES` for journal paths **using a precise anchor**, not a bare `journal` substring (see Interaction Contract change 2 for rationale). The per-journal `MAX_FILE_BYTES` ceiling is **60KB** (20KB headroom above E5's 40KB split threshold) — NOT 200KB. 200KB was excessive given the split-at-40KB generator rule; a 60KB cap still covers the `rollup.md` edge case (capped at 12KB by S5) and any transient over-shoot while a split is in flight. Function becomes:
   ```ts
   const JOURNAL_MAX_FILE_BYTES = 60_000;  // 20KB headroom above E5 split threshold (40KB)
   function shouldSkipChunking(file: string, content: string): boolean {
     // Precise anchor: must match the CodeSift wiki journal output path,
     // not any folder named "journal" in user source code.
     const isJournal = file.includes("/.codesift/wiki/journal/");
     if (isJournal) {
       if (content.length > JOURNAL_MAX_FILE_BYTES) return true;
       return false;  // bypass .md skip
     }
     // existing logic (50KB default ceiling, .md skip)
   }
   ```

6. **`src/instructions.ts`** — add hint code H15: "Journal fetch: use `search_text query=<term> glob=.codesift/wiki/journal/**` not full-file reads; phase files can be 30KB+."

7. **`src/register-tools.ts`** — register `journal_append` MCP tool. Extend `generate_wiki` schema.

**New files:**

- `src/tools/journal-generator.ts` — orchestrator (init, append, regenerate).
- `src/tools/journal-llm-client.ts` — provider abstraction (Anthropic + OpenAI + none-fallback). Token accounting. Cost table per model.
- `src/tools/journal-sentinel.ts` — sentinel parser, hash computer, block-level diff. Critical correctness code; dedicated test file.
- `src/tools/journal-phase-detector.ts` — commit → phase heuristic + YAML override merger.
- `src/tools/journal-templates.ts` — LLM prompt templates + output grammar spec.
- `src/tools/journal-migrator.ts` — migration from prototype `history.md` → phase files.
- `src/cli/journal-commands.ts` — 7 CLI handlers.
- `tests/tools/journal/sentinel.test.ts` — exhaustive parser tests.
- `tests/tools/journal/phase-detector.test.ts` — boundary heuristic tests.
- `tests/tools/journal/migrate.test.ts` — snapshot test against fixture `history.md`.
- `tests/cli/journal-commands.test.ts` — CLI handler tests.
- `tests/cli/journal-kill-switch.test.ts` — env-var disable tests.
- `tests/integration/wiki-cleanup-journal-guard.test.ts` — **mandatory D1 test**.
- `tests/integration/journal-e2e.test.ts` — init → lint → append → regenerate cycle on 30-commit fixture.
- `tests/fixtures/journal/prototype-history.md` — fixture copy of current prototype for migration test.
- `scripts/journal-retrieval-benchmark.ts` — 20-query cold-session benchmark runner.
- `scripts/journal-citation-check.ts` — claim extraction + git-log verification.
- `scripts/journal-cadence-report.ts` — 30-day maintenance counter.
- `benchmarks/journal-queries.yaml` — canonical 20-query set.

### Interaction Contract

This feature introduces two additive cross-cutting behavioural changes that existing workflows must be aware of:

**Contract change 1 — `wiki-lint` orphan rule exempts `journal/**`.** Target surface: `src/tools/wiki-lint.ts` orphan-page check. Protected surface: lint behavior on all non-journal `.md` files (unchanged). Override order: journal exemption is hardcoded path prefix, evaluated before the orphan check. Validation signal: regression test `tests/tools/wiki-lint-orphan-nonjournal.test.ts` asserts non-journal orphan detection still fires correctly. Rollback boundary: removing the exemption restores pre-feature behaviour; journal files would then orphan-error (intended breakage — signals rollback is active).

**Contract change 2 — `chunker` indexes journal files and raises `MAX_FILE_BYTES` to 200KB for journal paths only.** Target surface: `src/search/chunker.ts:shouldSkipChunking`. Protected surface: chunking/skip behavior for every non-journal file (unchanged — `.md` still skipped elsewhere, 50KB ceiling still applies). **Path matching rule (precise, not substring):** the journal-path test is `file.includes("/.codesift/wiki/journal/")` — anchored to the CodeSift wiki output directory, not the bare `journal` substring. This prevents false positives when a repo contains a user directory named `journal/`, `backend/journal/`, or clones into a path containing `/journal/`. Override order: journal-path check runs first and returns before the generic skip logic. Validation signal: regression test `tests/search/chunker-nonjournal-skip.test.ts` asserts `src/journal/api.ts` and similar user paths are still subject to the standard chunker rules; only files genuinely under `.codesift/wiki/journal/` get the 200KB ceiling and `.md` bypass. Rollback boundary: removing the exemption means journal files disappear from semantic search (scaffold/BM25-only mode — acceptable degradation during rollback).

**Contract change 3 — `generate_wiki` MCP tool schema gains one optional parameter `journal_mode`.** Target surface: `generate_wiki` input schema in `src/register-tools.ts`. Protected surface: all other MCP tool schemas (unchanged). Additivity: `journal_mode` is optional with default `"skip"`, so pre-2.1 MCP clients omitting the parameter observe identical pre-feature behaviour. Strict-schema clients that reject unknown parameters are **unaffected** (they wouldn't see `journal_mode` if they're not sending it) but clients that reject unknown fields in the response are also unaffected (response shape gains nothing mandatory). Tolerant clients naturally pass through. Validation signal: integration test runs pre-2.1-style call (no `journal_mode`) and asserts response matches pre-feature snapshot. Rollback boundary: removing the parameter from schema returns to pre-feature behaviour; callers that were passing it get a standard Zod validation error.

No other cross-cutting contracts are introduced. Agent output formats, tool discovery, and hook behaviour for non-journal surfaces are unchanged.

### Edge Cases

| # | Scenario | Handling |
|---|----------|----------|
| E1 | AI hallucinates fact in narrative | (a) Prompt grounds strictly in provided commit data — no outside context. (b) **Every `entry:YYYY-MM-DD` sentinel block payload ends with a mandatory `<!-- source_commits: [SHA...] -->` line as its last inside-sentinel line** (NOT a footer outside the sentinel — outside-sentinel footers would be unvalidated). The sentinel parser validates presence and SHA format of this line and includes its hash in the block hash. Absence or malformed list → `SentinelIntegrityError`. (c) `My notes` section is positioned immediately after `phase-summary` giving human corrections visual primacy. (d) `journal lint --strict` runs `scripts/journal-citation-check.ts` which extracts the `source_commits` list from each entry plus any SHA/date literals that appear in the prose, cross-references against `git log` (the commit must exist and have a matching date), and reports unsupported claims. This is a deterministic extract-grammar check, not free-text NLP. |
| E2 | User edits inside a sentinel block | Generator computes SHA-256 of content between sentinels on every run. Stored hash in `manifest.pages[*].journal_content_hashes[kind]`. Mismatch on next regen → abort with diff printed to stdout and advisory "move edits outside sentinel or run with `--force`." Safe-by-default, no silent overwrite. |
| E3 | Sentinel structurally broken (missing `auto:end`, nested blocks, kind mismatch) | `journal-sentinel.ts` parser raises `SentinelIntegrityError` with line number. Regen and lint both abort. User fixes markers manually, re-runs. `journal lint --fix` attempts auto-repair only for unambiguous cases (missing end-of-file `auto:end`). |
| E4 | Auto phase boundary disagrees with user intent | `journal-phase-boundaries.yaml` is user-authoritative. Manual entries win always; auto-detection only fills gaps. Lint emits info-level diff when they disagree so user can reconcile. |
| E5 | Phase file > 50KB triggers chunker size skip | Journal paths raise `MAX_FILE_BYTES` ceiling to 60KB (see Integration #5 — 20KB headroom above split threshold). When `commits_count > 150 || estimated_bytes > 40000`, generator splits phase into weekly sub-files. **Split-slug scheme:** sub-file slug is `<parent-slug>-week-<N>` where N starts at 1 (e.g., `framework-wave-week-1.md`, `framework-wave-week-2.md`). Each sub-file is a distinct `JournalPageEntry` with its own unique `slug` and its own `journal_content_hashes` — no manifest collision. Rollup aggregates across splits by matching `slug.startsWith(parent-slug + "-week-")`. Manifest `page.type` remains `"journal-phase"` for sub-files; optional `page.parent_slug` field distinguishes them from standalone phases. |
| E6 | Commit SHA referenced in meta no longer exists (rebase/squash) | `journal lint` cross-checks `source_commits` against `git log`. Missing SHAs → warning "commit X rebased, entry may be stale." Non-blocking. User regenerates or accepts. |
| E7 | Language policy violation (prose in unexpected language) | Zero enforcement by design (DD3 allows author choice). Template comment suggests Polish prose, but lint does not check. |
| E8 | CI runs `journal init` on every merge → cost explosion | `journal init` has guard: if `journal/phases/` contains files AND none of them contain `<!-- TODO: ` placeholders (i.e., they are LLM-filled, not scaffolds) → abort with "journal already initialised; use `journal append` for new commits." The scaffold-vs-filled distinction is how `journal init --bulk-fill` immediately after `journal migrate` succeeds: migrate produces scaffold phase files with TODO placeholders, and `init --bulk-fill` is the documented path to LLM-fill them. `journal append --since=HEAD~1` is idempotent and cheap and is the only operation CI should trigger on merge. CLI detects `CI=true` env and defaults to `append` rather than `init` when invoked ambiguously. |
| E9 | Migrating existing prototype `.codesift/wiki/history.md` | `codesift journal migrate` parses prototype using its **actual heading hierarchy verified at spec-authoring time (2026-04-21)**: **(a) `## <section>` — top-level sections**: `## Timeline` is a pure container (the migrator walks through it to reach its `### Week` children; the `## Timeline` heading itself produces no output); all other `##` sections (`## At a glance`, `## Themes across the project`, `## Competitive context`, `## Sources`, plus any future non-Week `##` section) are migrated verbatim into a single `<!-- manual:begin migrated-overview -->` block in `journal/overview.md` (nothing is dropped). **(b) `### Week N — <name> (<date range>)`** — week-level groupings become phase files, one per week. Phase `slug` is derived from the week title: strip leading `Week N — `, slugify the remainder, prepend the month of the start date. E.g., `### Week 5 — The framework wave (Apr 11 – Apr 12)` → `phases/2026-04-framework-wave.md`. **(c) `#### YYYY-MM-DD — <title> (<N> commits)`** — single-day daily entries become `auto:begin entry:YYYY-MM-DD` blocks. **(d) `#### YYYY-MM-DD – YYYY-MM-DD — <title> (…)`** — multi-day entries (e.g., line 50 of the prototype: `#### 2026-03-21 – 2026-03-23 — Quiet hardening (7 commits over 3 days)`): sentinel key uses the **start date** (`entry:2026-03-21`); the full date-range string is preserved in the entry's H3/H4 title for human readability; one entry is emitted, not three. **(e) `####` heading-line preservation rule** (applies to all daily entries, single-day and multi-day): the literal `####` heading line is preserved **verbatim as a Markdown heading inside the phase file's `My notes` block** — it is NOT consumed as metadata. This preserves byte-level equivalence for the Ship 7 snapshot assertion without any heading-escape gymnastics. The sentinel key (e.g., `entry:2026-04-11`) is a separate piece of metadata written into the `auto:begin entry:<date>` marker for LLM-authored content; the `My notes` section above that marker retains the original `####` line exactly as the human wrote it. Migrator places existing prototype prose paragraphs into `My notes` of each phase file (content preservation — every paragraph under a `### Week` heading, including `####` entry prose, is preserved verbatim), then invokes LLM for `phase-summary` and per-day `entry:` blocks. Backs up original to `.codesift/wiki/history.md.bak`. Idempotent — no-op if source absent. |
| E10 | `CODESIFT_WIKI_V1=1` with journal files present | V1 code path never enters journal generation. V1 lint path exempts `journal/**` (symmetric with V2 lint). Files survive V1 runs intact. |
| E11 | Concurrent edit + regenerate race | Generator writes to `.tmp` sibling, then `rename()` atomically. Hash check on read prevents stomping on unsaved editor buffers once those buffers are saved to disk. Editor-held unsaved changes cannot be protected by filesystem guarantees — documented. |
| E12 | LLM returns valid markdown but wrong structure (missing `Intent` heading) | Output grammar validator in `journal-templates.ts` checks for 4 required H2 anchors (`## Intent`, `## Reality`, `## Significance`, `## Lessons`). Missing → one retry with stricter prompt → scaffold fallback with `<!-- TODO: LLM output malformed, fill manually -->`. |

### Failure Modes

#### LLM provider

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Anthropic API 503 / network timeout (30s) | HTTP status + client-side timeout | current phase regen | "LLM unavailable — entry saved as S2 scaffold with TODO placeholders" | auto-retry 2× exponential backoff, then scaffold fallback | scaffold file written with valid sentinels and empty AI sections; nothing partial | immediate |
| Rate limit (429) mid-init | status 429 | remaining phases in batch | "Rate limit hit after N/M phases. Resume with `journal append --since=<last-ok-phase>`." | resumable checkpoint in `.init-checkpoint.json` written after each successful phase | partial state safe — each phase is atomic | immediate |
| Malformed LLM output (broken sentinel string or non-markdown) | sentinel parser raises on generated output | single entry | "AI response rejected (malformed structure), retrying with stricter prompt" | 1 retry with reinforced prompt; failure → scaffold fallback | nothing written if parser fails on both attempts | immediate |
| Cost cap exceeded (`CODESIFT_JOURNAL_MAX_USD`) | post-call token accounting | all pending operations in invocation | "Cost cap $1.00 exceeded after N calls. Raise with `CODESIFT_JOURNAL_MAX_USD=2.0` or commit checkpoint and resume later." | checkpoint preserved; user adjusts cap or waits | safe — cap checked between calls, never mid-call | immediate |

**Cost-benefit:** Frequency occasional (~2-5%, network + rate limits) × Severity medium (UX degrade, no data loss) → Mitigation trivial (retry + checkpoint + scaffold already planned). **Decision: Mitigate all four.**

#### Sentinel parser / content preservation

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Missing `auto:end` marker | parser reaches EOF without close | single phase file | `SentinelIntegrityError at line N: unclosed auto:begin for kind=<k>` | user manually adds marker OR `journal lint --fix` repairs if unambiguous | file untouched by generator | immediate (first regen/lint) |
| Unexpected `auto:begin` in hand-written prose | parser finds opener for unregistered kind | file scope | lint info warning "unknown sentinel kind `<k>` at line N, treated as prose" | parser ignores unknown kinds (tolerant) | safe — content preserved as prose | lint time |
| Content hash mismatch (user edited inside block) | stored hash ≠ recomputed hash on next regen | entry regen | "auto-block `<kind>` in `<file>` changed since last run, will not overwrite. Move edits outside sentinel or run `journal regenerate --entry=<date> --force`." | user decides: move edits out, force overwrite, or accept stale | safe — nothing overwritten without explicit `--force` | immediate |

**Cost-benefit:** Frequency rare (<0.1%, requires conscious user action) × Severity high (data loss without guard) × Mitigation trivial → **Decision: Mitigate via parser + hash check + dedicated tests.**

#### Phase boundary detector

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Auto-detect disagrees with manual YAML override | diff computed on each run | phase file names and contents | lint info warning "manual boundary for 2026-04-11 differs from auto-detect suggesting 2026-04-12." | YAML wins always; user informed | deterministic — manual always wins | lint time |
| Two commits on same day cross a phase boundary | consecutive commit timestamps span boundary | rollup attribution | commits may appear ambiguously attributed | tiebreaker: commit attached to later phase (deterministic) | single attribution per commit | generation time |
| Commit without tag, branch signal, or theme keyword | heuristic returns null phase | one commit | commit lands in `phases/unclassified.md` | user edits YAML to classify, regenerates | visible orphan file — user-actionable | generation time |

**Cost-benefit:** Frequency occasional (5-10%, heuristics imperfect) × Severity low (cosmetic, YAML-recoverable) × Mitigation trivial → **Decision: Mitigate via YAML override + unclassified fallback.**

#### Wiki cleanup integration (highest-risk component)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Path exception mis-typed (guard fails to match actual entries) | **mandatory integration test** `tests/integration/wiki-cleanup-journal-guard.test.ts` asserts journal files exist after `wiki-generate` | all journal files | catastrophic bulk deletion if guard breaks in production | **prevented by test gate** — broken guard cannot merge | catastrophic if test missed; impossible with test | compile/CI time |
| User manually deletes phase file outside `journal/phases/`, then runs regen | generator checks manifest vs disk delta | that phase | file missing → regen recreates via LLM (re-incurs cost) | intended behaviour; cost warning emitted | file restored, checkpoint updated | immediate |
| V1 mode enabled with journal files present | V1 writer sees extended page types | V1 manifest | V1 manifest cannot represent journal types → V1 lint would orphan them | V1 lint exempts `journal/**` explicitly (mirrored from V2) | journal survives V1 runs untouched | regen/lint time |

**Cost-benefit:** D1 is the single highest-severity scenario in the entire spec (bulk deletion). Mitigation cost is trivial (one integration test). **Decision: Mitigate D1 via mandatory test gate. D2-D3: mitigate via documentation and V1 lint exception.**

#### Migrator (`journal-migrator.ts`)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Source `history.md` changes between `--dry-run` plan and live run (user edits, another process writes, file truncated mid-read) | `--dry-run` writes `{source_sha256, planned_phase_slugs[], schema_version}` to `.codesift/wiki/journal/.migrate-state.json` (this is the ONE documented side-effect of `--dry-run` — updated in API Surface docstring of `handleJournalMigrate`); live run reads this file, recomputes `source_sha256`, compares | entire migration | "source file changed since dry-run (sha <new> ≠ <recorded>), aborting to avoid inconsistent migration" | user re-runs `--dry-run` against current state, inspects, runs live | source untouched, no phase files written, `.migrate-state.json` updated | immediate |
| `.bak` write fails (disk full, permission error) before phase files are created | `fs.copyFile` error caught | migration aborts | "backup write failed: <error>, aborting to preserve original" | user frees space / fixes perms, re-runs | source untouched, nothing written | immediate (before any destructive step) |
| Mid-migration crash (process killed, SIGKILL, disk full) after some phase files written | `.init-checkpoint.json` exists under `.codesift/wiki/journal/` with migrator state | partial `phases/` directory | re-run detects checkpoint and resumes at next unwritten phase | idempotent: each phase file is atomic write, re-run either finds existing valid file (skip) or writes from scratch | possible partial phase set on disk, but checkpoint marks which completed; re-run converges | immediate on re-run |
| Parser finds zero week-level `###` headings (prototype structure changed after spec authoring, or file is not the expected prototype) | migration plan reports 0 phases | entire migration | "parser found 0 week-level headings; prototype may have been restructured. Abort." | user manually updates migrator regex or the prototype; no silent migration | source untouched | immediate (dry-run reveals before live run) |
| Week heading slug collision (two weeks with identical titles, or title slugifies to same string) | slug-set check during plan | affected phase files | "phase slug collision: `<slug>` produced by Week N and Week M. Disambiguate titles or pass `--slug-overrides=<yaml>`" | user resolves via override YAML | no files written | immediate |

**Cost-benefit:** Frequency rare (migration is one-shot) × Severity high (destructive, content loss risk) × Mitigation cost trivial (hash check + checkpoint already planned). **Decision: Mitigate all — hash-gate between dry-run and live, `.bak` pre-write, checkpoint for resumability, explicit zero-phase abort.**

#### Checkpoint (`.init-checkpoint.json`)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Checkpoint corrupted (malformed JSON from crash mid-write, concurrent process) | JSON parse error on load | resume logic | "checkpoint unreadable: <error>. Start fresh with `--no-resume` or manually delete `.init-checkpoint.json`." | user decides: fresh run (re-incurs cost) or manual edit | checkpoint treated as absent only when user confirms; never silently discarded | immediate (next run) |
| Checkpoint version mismatch after spec/tool upgrade | `checkpoint.schema_version` field compared to current | resume logic | "checkpoint written by older codesift version (<v>), not resumable by <current>. Delete `.init-checkpoint.json` and re-run with `--no-resume` to start fresh." | v1 ships `--no-resume` flag on `journal init` and `journal append`; deletion-plus-`--no-resume` is the only v1-supported recovery (no `journal migrate-checkpoint` tool exists in v1). `journal migrate-checkpoint` is deferred to v2 only if pain proven in practice. | checkpoint preserved for user inspection before manual deletion | immediate |
| Checkpoint stale (refers to phase slug that no longer exists after YAML override change) | phase-detector run produces plan, compared to checkpoint entries | resume logic | "checkpoint references phase `<slug>` not in current plan; stale entries will be ignored" | automatic: stale entries skipped, non-stale entries still honoured | partial reuse preserved, no data corruption | immediate |
| Concurrent `journal init` / `journal append` invocations | lockfile `.init-lock` (like existing wiki lockfile at `src/tools/wiki-tools.ts:144-148`) | both invocations | second invocation exits with "journal operation already in progress, PID <n>" | first completes or is killed | lockfile is exclusive-create; atomic | immediate |

**Cost-benefit:** Frequency rare × Severity medium (cost re-incurred if checkpoint unusable) × Mitigation cost trivial. **Decision: Mitigate corruption and concurrency; defer schema migration tool to v2 unless needed.**

## Acceptance Criteria

**Ship criteria** (must pass for release — deterministic, fact-checkable):

1. **Test suite passes.** `tests/tools/journal/*.test.ts` + `tests/integration/journal-e2e.test.ts` + `tests/cli/journal-commands.test.ts` + `tests/cli/journal-kill-switch.test.ts` all green. Unit coverage of sentinel parser (matched / unmatched / nested / hash-check), phase-boundary detector (tag-based / merge-based / gap-based / unclassified), LLM client (success / retry / scaffold fallback).
2. **Cleanup guard integration test (D1) — two-path assertion.** `tests/integration/wiki-cleanup-journal-guard.test.ts` has TWO assertion modes so it actually exercises the deletion logic (a naive single-assertion test would false-pass under non-recursive readdir because `journal/phases/test.md` is never visited by the cleanup loop). Path A: **non-recursive stub** — creates `.codesift/wiki/journal/phases/test.md`, runs `generateWiki` against the real non-recursive code path, asserts file still exists. Path B: **future-recursive stub** — injects a mocked recursive `readdir` that DOES return `"journal/phases/test.md"` as a string, runs the cleanup loop, asserts file still exists (the `f.startsWith("journal/")` guard is the only thing that can prevent deletion here). Both paths must pass; removing either guard (the `f === "journal"` clause OR the `f.startsWith("journal/")` clause) fails at least one path. Blocks merge.
3. **TypeScript compile.** `tsc --noEmit` passes after manifest type union extension + JSON Schema update + `PageEntry` new fields.
4a. **`journal lint` exit contract.** Exit 0 when journal registered and sentinels valid. Exit 1 when sentinel structurally broken (missing `auto:end`, mismatched kinds, nested blocks). Exit 0 with stdout warning on hash mismatch (non-blocking — lint informs the user that a sentinel block has been edited and may be overwritten on next regen). Warning message uses prefix `WARN journal:` for machine parsing.

4b. **`journal regenerate` exit contract on hash mismatch.** Exit **non-zero (2)** and **abort before writing** when hash mismatch is detected without `--force`. Prints to stdout: block location (file:line range of sentinel markers), current hash, recorded hash, and a `git diff -- <file>` excerpt showing what changed relative to the last committed version (the last committed state is the nearest source of the previous content — no text cache is needed since `.codesift/wiki/journal/` is under version control). Example message: `ERROR journal: block phase-summary in phases/2026-04-framework-wave.md has been edited since last regen. Current hash <abc>, recorded <xyz>. Run 'git diff -- phases/2026-04-framework-wave.md' to see changes. Re-run with --force to overwrite.` Exit 0 only when hashes match OR `--force` is passed (force overwrites and logs `WARN journal: forced overwrite of edited block <kind> in <file>` to stderr). This asymmetry with lint is intentional: lint tolerates edits (they may be deliberate), regen must never silently destroy them. When the journal directory is uncommitted (e.g., pre-first-commit), the diff section is replaced with `(no previous committed version to diff against)`.
5. **Kill switch.** `CODESIFT_JOURNAL_ENABLED=false` disables every journal CLI handler and the `journal_mode` branch in `generate_wiki`. No files created, no LLM calls. Verified by `tests/cli/journal-kill-switch.test.ts`.
6. **Scaffold fallback without API key.** `ANTHROPIC_API_KEY` unset + `CODESIFT_JOURNAL_MODEL` unset + `journal init` → phase files created with valid sentinels, AI sections containing `<!-- TODO: journal provider not configured -->`, lint exits 0, manifest valid.
7. **Migration preserves prototype content.** `journal migrate` on the current `.codesift/wiki/history.md` (~18KB — heading structure verified at spec-authoring time: `## Timeline` as container plus other `##` sections, `###` for 7 Week groupings, `####` for daily entries including one multi-day entry `#### 2026-03-21 – 2026-03-23`) produces exactly **7 phase files** in `journal/phases/` (one per `### Week N` heading), where the `My notes` section of each phase file contains verbatim every paragraph and sub-section (`#### <daily entry>` prose) originally under the matching `### Week N` heading in the prototype. Multi-day `####` entries are keyed on their start date per E9 rule (d). All non-Week `##` sections (`## At a glance`, `## Themes across the project`, `## Competitive context`, `## Sources`) are migrated verbatim into `journal/overview.md` inside an `<!-- manual:begin migrated-overview -->` block; `## Timeline` itself is a container and produces no output (its children are the Week phases). Snapshot test asserts **normalised-equivalence** (not byte-level): concatenation of (all 7 phase files' `My notes` sections — which begin verbatim with the `### Week N — <name>` heading from the prototype, preserved as the first line of the `My notes` block so heading content is not lost) ∪ (migrated-overview block in overview.md) ≡ the original prototype's content under `## Timeline` + all non-Week `##` sections, after the following explicit normalisation function: (1) line endings normalised to LF, (2) trailing whitespace on each line stripped, (3) consecutive blank lines collapsed to single blank line, (4) nothing else. The `## Timeline` heading itself is the only content intentionally dropped (it's a pure container) and is accounted for explicitly in the equivalence formula as `(expected) = prototype_content_minus(`## Timeline` line)`. Test fixture is this exact normalisation applied to `tests/fixtures/journal/prototype-history.md`; comparison is byte-level after normalisation. `history.md.bak` file created. Fixture `tests/fixtures/journal/prototype-history.md` is an exact byte-copy of the prototype as it exists on 2026-04-21 and must be regenerated if the prototype changes before merge.
8. **Manifest schema bump to 2.1.0.** `manifest_schema_version: "2.1.0"` present in written JSON. Schema file at `schemas/wiki-manifest-v2.schema.json` validates new fields. Backward-compat path: pre-2.1 readers fail-fast with "upgrade codesift-mcp" message rather than silent misparse.
9. **V1 rollback preserved.** `CODESIFT_WIKI_V1=1` + `journal/` directory populated → `wiki-generate` runs to completion without touching journal, `wiki-lint` does not orphan journal files. Integration test.
10. **Cost cap enforcement.** Mock LLM client reports high tokens on each call; test asserts abort before Nth call with checkpoint written. `CODESIFT_JOURNAL_MAX_USD` respected.

**Success criteria** (must pass for value validation — measurable quality/efficiency):

S1. **Agent retrieval quality — cold session benchmark.** `scripts/journal-retrieval-benchmark.ts` runs canonical 20-query set (`benchmarks/journal-queries.yaml`) in cold Claude Code sessions. Target: **mean tool-call count to correct answer ≤ 2** (baseline without journal: 4-8 or failure). Each query entry in `benchmarks/journal-queries.yaml` carries a deterministic adjudication rubric: `expected_phase_slug` (the phase whose content must be retrieved), `expected_commit_shas` (commits that must appear in the agent's response, any subset), and `forbidden_claims` (explicit strings the agent must NOT emit). A query passes when the retrieved context contains the expected phase slug AND at least one expected commit SHA AND zero forbidden claims. The benchmark script automates this check — no human "looks right" adjudication. **Reproducibility controls:** the script pins agent model via `CLAUDE_BENCH_MODEL=claude-sonnet-4-6` (required env var, default specified), temperature 0, max-tokens 2000, seeded prompt order. Runs are reported with the exact model ID and benchmark script git SHA so regressions are traceable across releases.

S2. **Generation cost and time.** Full `journal init` on this repo (709 commits) completes in **≤ 5 min wall clock + ≤ $2.00 USD** using default `claude-sonnet-4-6`. Haiku-4-5 alternative target: ≤ $0.30. Measured via `journal stats` and CI timing.

S3. **Cadence sustainability (30-day window).** 30 days post-merge: minimum **4 `journal append` runs or 2 manual `My notes` commits** on `.codesift/wiki/journal/`. Script: `scripts/journal-cadence-report.ts` counts git log matches.

S4. **Citation gate — NOT a hallucination detector.** `scripts/journal-citation-check.ts` verifies CITATIONS (syntactic SHA/date/version literals), not factual claims. Extraction grammar (**deterministic, not NLP**): (1) every SHA literal (hex, 7-40 chars) in prose, (2) every ISO date literal in prose, (3) every string in backticks matching `/^v\d+\.\d+\.\d+/` (version tags). For each extracted literal: SHA must exist in `git log --all`; date must correspond to at least one commit date in the phase's source_commits range; version tag must match a real git tag. Report metric: **≥ 95% of extracted literals grounded**. **Explicit limitation:** this tool does NOT detect narrative hallucinations — an LLM can cite real SHAs while making completely wrong narrative claims about them, and the tool will still pass. The tool's purpose is to catch the specific class of errors where AI fabricates identifiers (made-up SHAs, non-existent dates) without inspecting the surrounding prose's truth value. Narrative truthfulness is defended by other mechanisms: prompt grounding (no outside context), `My notes` human correction precedence, and author review of 3 sample phase files in post-merge dry-run step 8. Golden fixture: `tests/fixtures/journal/citation-golden.md` contains a hand-crafted phase file with known-grounded and known-ungrounded literals; the script must score this fixture exactly 75% (15/20) in unit tests.

S5. **Readability budgets.** `rollup.md` ≤ 3000 tokens (≤ 12KB). `overview.md` ≤ 1500 tokens. Phase files mean 3-8KB, max 200KB (chunker ceiling). Measured via `journal stats`.

## Validation Methodology

**Pre-merge CI gates** (blocking, run on every PR):

1. `npm test` — full suite including new `tests/tools/journal/**` and integration tests.
2. `tsc --noEmit` — zero errors.
3. `ajv validate schemas/wiki-manifest-v2.schema.json` — schema self-consistency.
4. `tests/integration/wiki-cleanup-journal-guard.test.ts` — D1 mandatory guard.
5. Scaffold fallback test (Ship 6) — runs without network.
6. Kill switch test (Ship 5).
7. Migration snapshot test (Ship 7) — uses `tests/fixtures/journal/prototype-history.md`.

**Post-merge dry-run sequence** (manual, before first production `journal init`):

1. Backup prototype: `cp .codesift/wiki/history.md /tmp/history.md.pre-migrate.bak`.
2. `codesift journal migrate --dry-run` — inspect planned phase splits + placement.
3. `codesift journal migrate` for real — produces phase files + `.bak`.
4. Human review of 3 sample phase files (voice, factuality, sentinel integrity).
5. `codesift journal init --dry-run` — shows phase boundaries without LLM calls.
6. Edit `journal-phase-boundaries.yaml` if auto-detection disagrees with intent.
7. `codesift journal init` real run — ~5 min, ~$1-2.
8. Human reviews first 3 generated phase files.
9. `codesift journal lint --strict` — zero hallucination warnings.
10. Commit + push + update `index.md` link (automatic via next `wiki-generate`).

**7-day post-release validation window** (automated weekly):

- Full `scripts/journal-retrieval-benchmark.ts` run against canonical 20-query set. Metric S1 validated.
- Full `scripts/journal-citation-check.ts` on all phase files. Metric S4 validated.
- If S1 mean > 2 or S4 < 95%: trigger regen with stricter prompt template.

**30-day post-release validation** (automated monthly):

- `scripts/journal-cadence-report.ts` counts append runs + notes commits.
- If < 4 appends and < 2 notes → friction retrospective, input to v2 spec.

Every validation step maps to concrete file/command. No "review manually" entries — the human-review step in post-merge dry-run is explicit and bounded (3 files).

## Rollback Strategy

Layered rollback, softest first:

| Level | Mechanism | Effect | Data preservation |
|-------|-----------|--------|-------------------|
| L1 | `CODESIFT_JOURNAL_ENABLED=false` env OR `--no-journal` flag on `wiki-generate` | No generation; existing files untouched | full |
| L2 | `git checkout HEAD -- .codesift/wiki/journal/phases/<slug>.md` | Single file reverts to last committed state | git-based |
| L3 | `codesift journal regenerate --phase=<slug> --model=<alt> --prompt-override=<file>` | LLM rewrites with different parameters | previous version in git |
| L4 | `git rm -r .codesift/wiki/journal/` + set kill switch | Journal directory gone, wiki otherwise unaffected | git log retains content |
| L5 | Revert manifest-extension PR | Older readers work again. Journal files remain on disk; `wiki-lint` after revert no longer carries the `journal/**` exemption (exemption lives alongside the extension in the same PR), so journal files DO become orphan-page errors. Remedy during rollback: either also `git rm -r .codesift/wiki/journal/` as part of the revert, or set `CODESIFT_JOURNAL_ENABLED=false` and pass `--no-lint-journal` (new one-line compatibility flag shipped alongside this feature specifically for this rollback path) to `wiki-lint`. | files on disk, unregistered, lint-visible as orphans unless suppressed |

**Kill switch contract:** `CODESIFT_JOURNAL_ENABLED` read at every journal CLI entry point and at `generate_wiki` journal_mode dispatch. **Default: `true` unconditionally.** When true AND required provider credential is present (per DD6 provider-aware gating) → full LLM-backed generation. When true AND credential absent → automatic scaffold fallback (Ship 6 satisfied). When explicitly `false` → every journal CLI and MCP dispatch exits immediately with `"journal disabled by CODESIFT_JOURNAL_ENABLED=false; set to 1 to enable"`. The previous draft's "default false when no API key" was removed because it contradicted Ship 6 (scaffold-on-fresh-clone). There is no `--scaffold-only` flag because scaffold is an automatic fallback, not a user-selected mode — if the user wants scaffold-only behaviour, they unset their API key env var.

**What survives rollback:** git-committed journal files always survive `git revert` of the feature PR. Uncommitted files survive `--no-journal` but not `git clean -fd` — documented in `journal init` help text.

## Backward Compatibility

**Manifest schema extension (breaking for strict readers).** `PageEntry.type` enum gains 3 literals, plus 2 new optional fields. Zod-based or strict JSON-Schema readers on pre-2.1 CodeSift versions will reject parse **with their existing runtime validation errors** (e.g., Zod emits its standard `ZodError` unknown-enum-value message; JSON Schema validators emit their own enum-mismatch errors). We cannot retroactively modify already-released pre-2.1 reader code to print a friendlier "upgrade codesift-mcp" hint — the released binaries' error text is fixed. Mitigation is forward-looking only: the 2.1+ reader emits a clear upgrade hint when it loads an even-newer future manifest; the `CHANGELOG.md` entry under "Breaking changes for manifest consumers" tells pre-2.1 users what the existing runtime error actually means, so users seeing a confusing Zod message in their logs can look it up.

**Wiki V1 rollback (`CODESIFT_WIKI_V1=1`).** V1 code path never enters journal generation. V1 `wiki-lint` exempts `journal/**` (hardcoded path prefix check). Journal files on disk are invisible to V1 — neither error nor listed. Symmetric with V2 lint exemption.

**Prototype `history.md` (`.codesift/wiki/history.md`, ~18 KB).** Not deleted by spec implementation. `journal migrate` copies content into phase files + creates `.bak`. User explicitly `rm`s originals after verifying. If user never runs migrate, `history.md` remains at risk of being deleted on next `wiki-generate` unless the user keeps it registered manually — this is an existing risk, not one this spec introduces.

**`index.md` link `[[history]]`.** Currently linked in user-edited `index.md`. After journal lands: `generateIndexPage` auto-adds `[[journal/overview]]` entry. Stale `[[history]]` link becomes broken after `journal migrate` removes the target → `wiki-lint` flags it → user or auto-fix removes the dead link. Acceptable churn.

**Existing `wiki-generate` without journal.** Zero observable change when `--no-journal` flag used or `ANTHROPIC_API_KEY` unset. Journal directory simply not created. All existing wiki pages generate identically to pre-feature behaviour.

**MCP tool `generate_wiki`.** Optional `journal_mode` parameter defaults to `"skip"`. Pre-2.1 MCP clients omit the parameter entirely and get pre-feature behaviour. Claude Code, Codex, Cursor, Gemini, Antigravity all compatible.

## Out of Scope

### Deferred to v2

- **Year-rollup files** (`journal/by-year/2026.md`) — full G3 third tier. MVP ships overview + per-phase; year-rollup is nice-to-have and adds generator complexity for marginal gain.
- **Multi-contributor workflow** — explicit `author` field in entry meta, conflict resolution strategy, voice normalization. V1 assumes single author; v2 adds coauthor hooks.
- **`--ai-suggest` flag for bullet suggestions inside `My notes`** — LLM proposes bullets as HTML comments for human accept/reject. Cost/benefit marginal in v1; revisit if cadence sustainability fails.
- **Cross-model adversarial review of journal entries** — a second LLM reviews factual claims. Nice for hallucination but $$$ × 2. Deferred unless S4 gate fails repeatedly.
- **Dedicated vector store for journal** — if BM25 + chunker-allowlist proves insufficient (S1 benchmark < target), dedicate an embedding store. v2 trigger.
- **Auto slug_redirects on phase rename** — currently manual YAML edit + commit. v2 auto-detects rename intent and proposes redirect entry.

### Permanently out of scope

- **Automatic commit hook generating entries on every `git commit`** — violates cost cap and developer flow. Journal is discipline-driven, not event-driven.
- **Real-time collaborative editing (Google Docs style).**
- **Non-git sources of truth (Linear, Slack, Notion).** Journal bounds to `git log` + author's `My notes`. External systems can be linked from notes but are never parsed.
- **Full-project narrative retrospectives (quarterly/yearly essays).** Different content type; belongs in `docs/retrospectives/` if desired, not wiki journal.

## Open Questions

The following acknowledged points are resolved at spec-implementation time (not before):

1. **`.migrate-state.json` gitignore automation** — spec mandates the file is gitignored but does not automate adding it to `.gitignore`. The first-time user running `journal migrate --dry-run` must either (a) rely on `journal init`/`journal migrate` auto-appending `.codesift/wiki/journal/.migrate-state.json` to the repo's `.gitignore` on first run (preferred), or (b) accept manual addition. Implementation chooses (a); failure to write `.gitignore` is a non-blocking warning, not an abort.

2. **Fixture drift between spec authoring and merge** — Ship 7's fixture is pinned to `.codesift/wiki/history.md` as of 2026-04-21. If the prototype changes between spec approval and PR merge, the fixture must be regenerated and any heading-structure rule in E9 re-validated. Mitigation: a pre-merge check script `scripts/verify-prototype-fixture.sh` compares live prototype to fixture and fails if drift detected. Fixture refresh is a maintenance step, not a release gate.

3. **S3 cadence sustainability is post-release telemetry, not a pre-merge gate.** The 30-day window cannot be observed at merge time. S3 is measured and reported after the fact; if it fails, the retrospective feeds into a follow-up v2 spec on workflow friction. S3 does NOT block the initial release or PR merge. Pre-merge validation is Ships 1-10 + S1/S2/S4/S5.

4. **Model ID validity** — DD6 names specific model IDs (`claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7`, `gpt-4o-mini`). These reflect the Anthropic/OpenAI catalogs as of 2026-04-21. If a listed model is deprecated or renamed upstream, the default falls back to the next available model in the provider's current catalog via `journal-llm-client.ts`'s `resolveCurrentModel()` lookup, and a CI lint (`scripts/verify-model-ids.sh`) validates that default IDs match a runtime-queried SDK allowlist at release time. Implementation anchors model IDs to this registry, not to string literals scattered across files.

5. **Manifest schema version enforcement site** — AC 8 (manifest bump) requires pre-2.1 readers to get a clear error. The single enforcement point is the manifest-loader entry at the start of `generateWiki` in `src/tools/wiki-tools.ts`: it reads `manifest_schema_version`, and if missing OR lexicographically > the reader's supported range, emits the documented "upgrade codesift-mcp" message and exits. All other manifest-reading sites route through this one entry; there is no secondary parser to keep in sync.

## Adversarial Review

Three rounds of cross-provider adversarial review executed via `adversarial-review --json --mode spec` using providers **codex-5.3, gemini, cursor-agent** (the writer model — claude — auto-excluded from the panel). Total findings raised and resolved:

**Round 1 (49000 chars):** 14 findings — 7 CRITICAL, 6 WARNING, 1 INFO. All CRITICALs resolved in spec:
- Kill-switch default vs scaffold requirement (Ship 6) — codex + cursor — RESOLVED (kill switch now defaults true unconditionally).
- Provider-aware credential gating (Anthropic-only vs OpenAI support claim) — codex — RESOLVED (DD6 + `resolveCredentialsForModel`).
- `overview.md` regen wipes migrated sections — gemini — RESOLVED (control flow step 4 preserves migrated block).
- Ship 4b requires diff but only hash stored — gemini — RESOLVED (diff sourced from `git diff` since `.codesift/wiki/journal/` is version-controlled).
- TOCTOU race during 30s LLM call — gemini — RESOLVED (pre-hash + post-hash re-check before atomic rename).
- DD8 $1.00 cap vs S2 ≤$2.00 target — cursor — RESOLVED (default cap raised to $2.00).
- Ship 7 "byte-level AND whitespace-normalised" contradiction — cursor — RESOLVED (single normalisation function defined).

**Round 2 (49242 chars):** 11 findings — 4 CRITICAL, 7 WARNING. All CRITICALs resolved:
- `migrated-overview` sentinel kind not registered in contract — codex + gemini — RESOLVED (added to valid kinds, later split to `manual:` prefix).
- Global dry-run contract vs migrate's state-writing dry-run — codex — RESOLVED (migrate's exception explicitly documented with `--plan-only` alias).
- Interaction Contract claim "no MCP schema changes" vs `generate_wiki` journal_mode addition — codex — RESOLVED (contract change 3 added).
- Chunker path-match `file.includes("/journal/")` too broad — gemini — RESOLVED (anchored to `/.codesift/wiki/journal/`).
- Ship 7 equivalence mathematically impossible (Week headings consumed) — gemini — RESOLVED (Week headings preserved in My notes; `## Timeline` only dropped).
- E8 vs post-merge workflow (init blocked after migrate) — cursor — RESOLVED (`--bulk-fill` flag + scaffold-vs-filled distinction).

**Round 3 (after round 2 fixes):** 11 findings — 4 CRITICAL, 7 WARNING. All CRITICALs resolved:
- `generate_wiki` append missing `since` param — codex — RESOLVED (`journal_since_ref` added to schema, required when mode="append").
- D1 guard test false-pass under non-recursive readdir — gemini — RESOLVED (Ship 2 split into two paths: non-recursive real + recursive-stubbed future).
- "Hallucination check" tool name overstates what it verifies — gemini — RESOLVED (renamed to `citation-check`, S4 explicitly states limitation).
- Checkpoint recovery references v2-only `journal migrate-checkpoint` command — cursor — RESOLVED (v1 recovery is delete + `--no-resume`).
- `parent_slug` in E5 not in `JournalPageEntry` interface — cursor — RESOLVED (optional field added).

**Round 3 WARNINGs accepted with mitigation** (full resolution deferred to implementation or post-v1):
- **Migrated-overview hash-check UX** (gemini) — RESOLVED beyond warning via `manual:` sentinel prefix, no hash-check for human-owned content.
- **MCP agents trapped in scaffold state** (gemini) — RESOLVED via `journal_bulk_fill` MCP parameter.
- **Chunker 200KB vs E5 40KB split** — RESOLVED by lowering journal ceiling to 60KB.
- **Manifest fail-fast vs lenient parsing** (codex W, cursor W) — **ACCEPTED as warning.** Implementation pattern: `manifest_schema_version` is a mandatory string field in 2.1+. Pre-2.1 Zod-based readers will get their standard "unknown enum value" error for new `type` literals, which is sufficient signal; extending backward-compat beyond fail-fast would require dual-write dual-read across a release, rejected as out-of-scope (Out of Scope: "Full-project narrative retrospectives" scope line confirms breaking upgrades are acceptable for a single-author tool).
- **Migrate dry-run = mandatory prerequisite (hostile CLI)** (gemini W) — **ACCEPTED as design decision.** The two-step workflow is intentional friction for the most destructive command in the suite. Documented in `--help` text and Open Questions. Users can add a shell alias if they object.
- **Template vs E9(e) layout inconsistency** (cursor W) — **ACCEPTED as documentation polish.** Template in Solution Overview shows post-init steady state; E9(e) describes migration-time interleaving. Reconciled by note: "`My notes` accumulates verbatim prototype content during migrate; a steady-state post-init phase file preserves the same layout — `## My notes` block lives above `## Daily entries`."
- **Per-phase LLM prompt has no explicit token limit** (cursor W) — **ACCEPTED as implementation detail.** Mega-phases (e.g., Framework Wave with 322 commits) will be handled by pre-aggregating commit messages into a budget of ~8000 input tokens; this is routine LLM-client engineering and does not need spec-level token math.
- **Model ID validity** (cursor W) — RESOLVED in Open Questions #4 (runtime catalog lookup + CI verification).
- **S3 post-merge timing** (cursor W) — RESOLVED in Open Questions #3 (S3 is post-release telemetry, not pre-merge gate).

No remaining CRITICAL findings after three rounds. Remaining open-but-accepted warnings are all documented in Open Questions or as explicit design trade-offs. Adversarial review declared complete at round 3; further rounds would yield diminishing returns on polish rather than catching implementation-blocking issues.
