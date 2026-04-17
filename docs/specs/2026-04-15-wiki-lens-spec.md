# Wiki & Lens -- Design Specification

> **spec_id:** 2026-04-15-wiki-lens-1553
> **topic:** Auto-generated wiki pages + interactive HTML dashboard from code topology
> **status:** Approved
> **created_at:** 2026-04-15T15:53:00Z
> **reviewed_at:** 2026-04-15T16:15:00Z
> **approved_at:** 2026-04-15T16:20:00Z
> **approval_mode:** interactive
> **adversarial_review:** warnings
> **author:** zuvo:brainstorm

## Problem Statement

Developers onboarding to a codebase have no architectural documentation beyond what they can infer by reading code. AI agents working in the codebase make redundant tool calls to understand module boundaries, hub symbols, and cross-cutting connections -- context that could be pre-computed and injected.

**Who is affected:** Developers (need browsable architecture docs), AI agents (need pre-computed context to reduce tool calls), team leads (need architecture visibility for planning).

**What happens if we do nothing:** Developers spend 2-5x longer understanding codebase structure. Agents make 5+ tool calls per turn for architecture questions that could be answered instantly. Competitor Reporecall (25 stars, same tech stack) ships this capability and captures early adopters.

**Direct competitor:** `proofofwork-agency/reporecall` -- 25 stars, MIT, TypeScript, v0.6.2. Uses tree-sitter + graphology Louvain (same stack as CodeSift). Ships wiki pages in `.memory/`, self-contained HTML "Lens" with D3, 26 MCP tools with hook-based prompt injection. Our advantage: 146 tools, 17 language extractors, framework intelligence, LSP bridge, 2971 tests.

## Design Decisions

### DD1: Output location -- dual (repo + cache)
Wiki pages generated to `.codesift/wiki/` in the repo (commitiable, browsable in GitHub/IDE, readable by agents via `Read` tool). Metadata/hash cache lives alongside the index in `~/.codesift/` (consistent with `graph-store.ts` pattern). `.codesift/wiki/` added to `.gitignore` by default; user can commit intentionally.

**Why:** Wiki serves both humans (need files in repo) and agents (need files on disk for hook inject). Storing only in `~/.codesift/` hides wiki from GitHub; storing only in repo creates merge conflicts. Dual approach serves both audiences.

### DD2: Slug stability -- readable names + redirect map
Community page slugs derived from `nameCommunity()` output (kebab-cased). A `wiki-manifest.json` tracks slug history with old->new mapping. `wiki-lint` detects broken `[[slug]]` links.

**Why:** Louvain is non-deterministic -- community membership shifts between runs. Stable hashes (e.g., `community-a3f2b1`) are unreadable. Readable names + redirect map balances human usability with link integrity. Pinning community membership is over-engineering for v1.

### DD3: Lens HTML -- full interactive from v1
Self-contained HTML with D3 chord diagram, D3 force-directed community graph, tab navigation (Overview/Communities/Hubs/Surprises/Wiki), click-through navigation, inline wiki rendering via marked.js. D3 + marked loaded from CDN.

**Why:** Since D3 is already loaded for the chord diagram, adding a force-directed graph is incremental (~100 LOC). Building a minimal version first (tables only) and upgrading later means reworking the HTML template -- avoidable rework.

### DD4: Surprise scoring -- structural + temporal
Two scoring dimensions: (1) structural: `actual_edges / expected_edges` where `expected = size_A * size_B * global_density`, (2) temporal: jaccard score from `co_change_analysis` for cross-community file pairs. Both displayed in Surprises page/tab.

**Why:** Structural surprises catch import-graph anomalies. Temporal surprises catch files that co-change despite being in different communities (invisible to static analysis). Using both dimensions gives higher recall than either alone.

### DD5: Architecture -- Tool Composition (no intermediate data model)
`generateWiki()` calls existing tools (`detectCommunities`, `classifySymbolRoles`, `coChangeAnalysis`, `analyzeHotspots`, `analyzeProject`) and formats their typed return values directly into markdown/HTML. No `WikiData` intermediate model.

**Why:** All existing tools have stable, well-typed return values with 2971 tests. An intermediate model adds serialization overhead and a maintenance surface without clear benefit. If decoupling is needed later, extracting `WikiData` from existing types is a straightforward refactor.

### DD6: Hook injection -- merged into existing precheck-read
Wiki context injection is merged into the existing `handlePrecheckRead` handler in `hooks.ts` rather than adding a separate hook. When a `PreToolUse/Read` fires, the handler: (1) performs existing redirect logic for large files, (2) if not redirecting, looks up the file's community from `wiki-manifest.json`'s `file_to_community` map, (3) reads the corresponding `.summary.md` file (pre-generated compact summary, not full wiki page), (4) writes summary to stdout and exits 0 (inject context, allow Read). Token budget enforced with conservative `CHARS_PER_TOKEN = 3` estimate. Max 3 summaries per inject (1 community + 1 hub + 1 surprise).

**Why:** Running two separate PreToolUse/Read hooks serially (precheck-read + precheck-wiki) creates ordering ambiguity -- if precheck-read exits 2 (deny), the wiki inject never fires. Merging avoids the ordering problem entirely and eliminates double file-path parsing. The existing `handlePrecheckRead` already loads stdin and resolves the file path; adding wiki lookup is ~30 LOC in the same handler.

### DD7: Pre-generated summaries for hook inject
Each wiki page has a companion `{slug}.summary.md` file (~200-400 tokens) generated during Pass 1. Summaries contain: community name, top 3 files, cohesion score, top hub symbol, one-sentence description. The hook injects summaries, not full wiki pages.

**Why:** Full community wiki pages can be 1000+ tokens. Injecting full pages would exhaust the token budget on a single community. Pre-generated summaries guarantee predictable size and fast hook execution (one `readFile` call, no truncation logic).

## Solution Overview

```
codesift wiki-generate [--focus <path>] [--output <dir>]
         |
         v
  +------------------+
  | Analyze Phase    |  Promise.allSettled (parallel, 15s timeout each)
  |  communities     |  detectCommunities()
  |  roles           |  classifySymbolRoles()
  |  co-change       |  coChangeAnalysis()
  |  hotspots        |  analyzeHotspots()
  |  project         |  analyzeProject()
  +------------------+
         |
         v
  +------------------+
  | Score Phase      |  Compute surprise scores (structural + temporal)
  +------------------+
         |
         v
  +------------------+
  | Generate Phase   |  Pass 1: Generate page content (per-page generators)
  |  index.md        |  Pass 2: Resolve [[links]] + compute backlinks
  |  {community}.md  |  Write markdown files to .codesift/wiki/
  |  hubs.md         |  Write wiki-manifest.json (hash, slugs, metadata)
  |  surprises.md    |
  |  hotspots.md     |
  |  {framework}.md  |
  +------------------+
         |
         v
  +------------------+
  | Lens Phase       |  Build self-contained HTML from same data
  |  codesift-lens   |  D3 chord + force graph + tabs + wiki browser
  |  .html           |  Inline JSON data + CDN scripts
  +------------------+
```

Hook injection is merged into the existing `handlePrecheckRead` handler:
```
Agent calls Read(file.ts)
  -> handlePrecheckRead fires (existing hook)
  -> if file >= 200 lines: exit 2 (redirect to CodeSift) [existing behavior]
  -> else: lookup file.ts in wiki-manifest.json file_to_community map
  -> if found: read {community}.summary.md from .codesift/wiki/
  -> write summary to stdout (plaintext, <=token budget)
  -> exit 0 (allow Read, summary injected as additionalContext)
```

## Detailed Design

### Data Model

No new persistent data model. Existing tool return types consumed directly:

| Type | Source | Used for |
|------|--------|----------|
| `CommunityResult` | `community-tools.ts` | Community pages, chord diagram data |
| `SymbolRoleInfo[]` | `graph-tools.ts` | Hubs page |
| `CoChangeResult` | `coupling-tools.ts` | Temporal surprise scores |
| `FanInFanOutResult` | `coupling-tools.ts` | Hub identification |
| `HotspotResult` | `hotspot-tools.ts` | Hotspots page |
| `Awaited<ReturnType<typeof analyzeProject>>` | `project-tools.ts` | Framework detection, tech stack (note: no named export — use ReturnType) |

New types (internal to wiki-tools.ts):

```typescript
interface SurpriseScore {
  community_a: string;       // community name
  community_b: string;
  structural_score: number;  // actual_edges / expected_edges
  temporal_score: number;    // max jaccard from co_change pairs crossing this boundary
  combined_score: number;    // weighted: 0.6 * structural + 0.4 * temporal
  edge_count: number;        // actual cross-boundary edges
  example_files: [string, string];  // one representative file pair
}

interface WikiManifest {
  generated_at: string;      // ISO-8601
  index_hash: string;        // FNV-1a from computeIndexHash()
  git_commit: string;        // HEAD at generation time
  pages: Array<{
    slug: string;
    title: string;
    type: 'index' | 'community' | 'hubs' | 'surprises' | 'hotspots' | 'framework';
    file: string;            // relative path within .codesift/wiki/
    outbound_links: string[];  // [[slug]] targets
  }>;
  slug_redirects: Record<string, string>;  // old_slug -> new_slug
  token_estimates: Record<string, number>; // slug -> estimated tokens (for inject budget)
  file_to_community: Record<string, string>; // repo-relative path -> community slug (for hook lookup)
  degraded: boolean;                       // true if any analysis timed out or failed
  degraded_reasons?: string[];             // which analyses failed (e.g., "community_detection_timeout")
}
```

### API Surface

**MCP Tool: `generate_wiki`**

```typescript
{
  name: "generate_wiki",
  category: "reporting",
  params: {
    repo?: string,         // auto-resolve from CWD
    focus?: string,        // scope to directory (e.g., "src/tools")
    output_dir?: string,   // default: "{repo_root}/.codesift/wiki"
    include_lens?: boolean // default: true — also generate codesift-lens.html
  },
  returns: {
    wiki_dir: string,      // path to generated wiki
    lens_path?: string,    // path to generated HTML (if include_lens)
    pages: number,         // count of generated pages
    communities: number,   // count of detected communities
    hubs: number,          // count of hub symbols
    surprises: number,     // count of surprise connections
    stale: boolean         // false on fresh generation
  }
}
```

**CLI Commands:**

```
codesift wiki-generate [--focus <path>] [--output <dir>] [--no-lens] [--trim]
codesift wiki-lint [--fix]
```

Note: `--trim` (not `--compact`) to avoid semantic collision with the existing `--compact` flag used by other commands for JSON output formatting. `--trim` means: top 10 communities, top 20 hubs, skip wiki browser tab in Lens.

**Hook: merged into existing `precheck-read`**

No separate hook entry. Wiki injection is added to the existing `handlePrecheckRead` handler in `hooks.ts`. The handler already fires on `PreToolUse/Read` and already parses the tool input from stdin. The wiki inject path activates only when `.codesift/wiki/wiki-manifest.json` exists on disk.

Hook stdout contract (matching existing Claude Code PreToolUse behavior):
- **Exit 0 + stdout text** = allow the tool call; stdout content is injected as `additionalContext` visible to the agent
- **Exit 2 + stdout text** = deny the tool call; stdout content is shown as the denial reason (existing redirect behavior)
- **Exit 0 + empty stdout** = allow the tool call with no additional context (no-op inject)

The existing `handlePrecheckRead` already uses `codesift precheck-read` (direct binary, not `npx`), so cold-start latency is not an issue. Wiki manifest loading adds ~5ms (single JSON file read, cached after first load within the process).

### Integration Points

All read-only consumption of existing tools:

| Integration | File | What we consume | Changes needed |
|------------|------|-----------------|----------------|
| Community detection | `community-tools.ts` | `detectCommunities()` return value | None |
| Role classification | `graph-tools.ts` | `classifySymbolRoles()` return value | None |
| Temporal coupling | `coupling-tools.ts` | `coChangeAnalysis()` + `fanInFanOut()` | None |
| Hotspot analysis | `hotspot-tools.ts` | `analyzeHotspots()` return value | None |
| Project analysis | `project-tools.ts` | `analyzeProject()` return value | None |
| Hash computation | `graph-store.ts` | `computeIndexHash()` | None |
| Atomic write | `storage/_shared.ts` | `atomicWriteFile()` | None |
| CLI dispatch | `cli/commands.ts` | `COMMAND_MAP` | Add 2 entries (`wiki-generate`, `wiki-lint`) |
| CLI help | `cli/help.ts` | `COMMAND_HELP` | Add 2 entries |
| Hook system | `cli/hooks.ts` | `handlePrecheckRead` | Extend with wiki inject (~30 LOC) |
| Hook setup | `cli/setup.ts` | N/A | No change — wiki inject uses existing `precheck-read` hook |
| Tool registration | `register-tools.ts` | Tool registration pattern | Add 1 tool |
| Instructions | `instructions.ts` | `CODESIFT_INSTRUCTIONS` | Add wiki tool mapping |

### Interaction Contract

The wiki inject modifies the existing `handlePrecheckRead` hook, which fires on every `PreToolUse/Read`. This is a cross-cutting behavior change:

- **Target surface:** `handlePrecheckRead` in `hooks.ts` — extended with wiki summary injection
- **Protected surface:** Existing redirect behavior (exit 2 for large files) is unchanged. Wiki inject only fires in the `else` branch (file is small enough to read directly).
- **Override order:** Redirect check runs first. If redirect fires (exit 2), wiki inject is skipped. If no redirect, wiki inject runs (exit 0 with summary or exit 0 with empty stdout).
- **Validation signal:** Existing tests for `handlePrecheckRead` must still pass. New tests for wiki inject branch.
- **Rollback boundary:** Remove the wiki inject code path from `handlePrecheckRead` (revert to previous behavior). No hook entry removal needed since no new hook is registered.
- **Opt-out:** Wiki inject is a no-op when `wiki-manifest.json` does not exist. Users who don't run `wiki-generate` see zero behavior change.

### Edge Cases

| Edge Case | Trigger | Handling |
|-----------|---------|----------|
| **Repo < 5 files** | `index.files.length < 5` | Single `index.md` with "repo too small" message + flat file list. Zero community/hub/surprise pages. |
| **Repo > 500 files** | `files.length > MAX_UNFOCUSED_FILES` | Existing 500-file cap applies. Truncation notice in `index.md` header. Suggest `--focus`. |
| **0 or 1 community** | `modularity < 0.1` or `communities.length <= 1` | "Low modularity" notice in index. Generate file-tree page instead of community pages. |
| **No git history** | `coChangeAnalysis` returns empty | Surprise page shows structural scores only. Notice: "temporal analysis unavailable (no git history)". |
| **Slug drift** | Community membership changes between regenerations | `wiki-manifest.json` stores `slug_redirects`. `wiki-lint` reports broken links. |
| **Token budget overflow** | Hook inject selects pages exceeding budget | Rank by relevance, hard cap 3 pages. Drop order: surprise -> hub -> community summary. |
| **Framework detection miss** | `analyzeProject()` returns no frameworks | Skip framework pages silently. No error. |
| **Polyglot repo** | 2+ languages in index | Language breakdown per community page. "Polyglot boundaries" section in surprises. Disclaimer about cross-language edge blindness. |
| **Monorepo** | Multiple workspace packages | v1: treat as single repo (communities naturally group per package). v2: `--scope package` flag. |

### Failure Modes

#### Wiki Generation Pipeline

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Index not available | `getCodeIndex()` returns null | All wiki generation | Exit 1: "Run `codesift index` first" | User indexes repo | No partial output | Immediate |
| Community detection timeout (>15s) | `withTimeout(15000)` rejection | Community/surprise/chord pages missing | Degraded wiki with notice: "community detection timed out" | File-tree page generated as fallback | Manifest flags `degraded: true` | Immediate |
| `classifySymbolRoles` returns empty | Empty array check | Hubs page empty | "No hub symbols detected" notice in hubs.md | Acceptable for small/flat repos | Consistent | Immediate |
| `coChangeAnalysis` fails (shallow clone) | `Promise.allSettled` rejection | Temporal surprise scores missing | Structural scores only + "git history unavailable" notice | Acceptable degradation | Consistent | Immediate |

| Concurrent wiki-generate runs | Lockfile check at `.codesift/wiki/.lock` | Second run's output | Second run exits 1: "Wiki generation already in progress" | Wait and retry | No corruption — lockfile prevents interleave | Immediate |

**Cost-benefit:** Frequency: occasional (~5% for shallow clones, ~1% for timeout, ~1% for concurrent runs) x Severity: medium (degraded output, not broken) -> Mitigation cost: trivial (Promise.allSettled already used in architecture-tools.ts; lockfile is ~10 LOC) -> **Decision: Mitigate all via graceful degradation + lockfile.**

#### Lens HTML Generation

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Generated HTML > 2MB | `Buffer.byteLength(html)` check | Browser performance | Slow page load, potential crash | Auto-enable `--compact`: top 10 communities, 20 hubs, skip wiki browser tab | Wiki markdown unaffected | Immediate |
| D3 CDN unreachable | User opens offline | Chart rendering | Blank chord/force areas, tables still work | Accept (CDN dependency documented) | No data loss | On open |
| JSON data causes D3 error | Zero communities or zero edges | D3 chart area | Console error, blank chart | Guard: skip chart section if `communities.length < 2` | Rest of page renders | Immediate |

**Cost-benefit:** Frequency: rare (~1% for >2MB, ~5% offline) x Severity: low (cosmetic) -> Mitigation cost: trivial -> **Decision: Mitigate size cap, accept CDN dependency.**

#### Hook Injection

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Wiki inject adds > 50ms to handlePrecheckRead | `Date.now()` diff before/after wiki path | Current agent turn only | Slightly slower Read permission | Log to stderr; on next call, skip inject for this session | Agent proceeds normally | Immediate |
| `wiki-manifest.json` missing or unreadable | `readFile` ENOENT or JSON parse error | All inject attempts in session | No wiki context (silent) | Skip wiki inject path entirely. Existing redirect behavior unaffected. | Agent proceeds normally | Silent |
| Wiki stale (index hash mismatch) | Compare manifest `index_hash` vs current index hash | All inject attempts | Injected context includes: "Wiki outdated — regenerate with `codesift wiki-generate`" | Staleness warning prepended to summary | Stale content + warning | Immediate |
| File not in `file_to_community` map | Map lookup returns undefined | Single Read call | No wiki context for this file | Skip inject, exit 0. | Consistent | Silent |

**Cost-benefit:** Frequency: frequent for staleness (~20% of sessions) x Severity: medium (wrong context) -> Mitigation cost: trivial (hash comparison, ~5ms) -> **Decision: Mitigate with staleness warning.**

## Acceptance Criteria

### Ship criteria (must pass for release -- deterministic, fact-checkable):

1. `codesift wiki-generate` produces valid markdown files in `.codesift/wiki/` for any indexed repo with >= 5 files and >= 1 import edge.
2. Running `wiki-generate` on an unindexed repo exits with code 1 and a human-readable error within 500ms.
3. Repos with < 5 files produce exactly 1 wiki page ("repo too small") rather than N empty stubs.
4. Repos with > 500 files apply `MAX_UNFOCUSED_FILES` cap and include a visible truncation notice in `index.md`.
5. Generated `codesift-lens.html` opens in Chrome/Firefox without JS console errors; all 5 tabs present and navigable. When communities >= 2: chord diagram renders with >= 1 arc. When communities <= 1: chord diagram shows empty state with "low modularity" notice (no console error).
6. Hook inject (within `handlePrecheckRead`) adds <= 50ms to existing hook execution time. Always exits 0 (allow) when not redirecting, regardless of wiki errors.
7. Hook inject never injects more tokens than the configured budget (verified by unit test comparing `estimateTokens()` output vs budget).
8. Running `wiki-generate` twice on an unchanged repo produces identical output for all non-community-assignment content (manifest metadata, page templates, interlinks). Community assignments may vary due to Louvain non-determinism, but slug redirect map preserves link integrity across runs.
9. Every `[[slug]]` in generated wiki pages resolves to an existing wiki file (zero broken links on fresh generation, verified by `wiki-lint`).
10. `codesift wiki-generate --help` shows usage; `codesift wiki-generate` without repo auto-resolves from CWD.

### Success criteria (must pass for value validation -- measurable quality/efficiency):

1. **Agent context quality:** In a controlled test, an agent with wiki inject answers "which module owns X?" with <= 2 tool calls vs >= 5 without inject (measured on 3 test repos).
2. **Onboarding acceleration:** A developer unfamiliar with the codebase can identify top 3 modules and 2 hub symbols within 5 minutes of opening Lens HTML, without reading source files.
3. **Surprise utility:** At least 1 non-obvious surprise connection per real-world codebase (>= 20 files), validated on 5 test repos.
4. **Freshness signal:** Hook inject correctly warns about stale wiki (index hash mismatch) within the same session where a breaking refactor occurs.
5. **Framework coverage:** Hono, Next.js, and Astro repos each produce >= 1 framework-specific wiki page beyond standard community/hub/surprise pages.

## Validation Methodology

1. **Unit tests** (Vitest): One test per page generator (community, hub, surprise, hotspot, framework, index). Input: fixture data matching tool return types. Output: valid markdown with resolved links.
2. **Integration test**: `generateWiki()` on a fixture repo (the CodeSift repo itself). Assert: files exist, `wiki-manifest.json` valid, `wiki-lint` reports zero broken links, page count matches community count + fixed pages.
3. **Idempotency test**: Generate twice, `diff -r` the output directories. Must be identical.
4. **Lens test** (Playwright): Open `codesift-lens.html` in headless Chrome. Assert: zero console errors, `#chord-diagram svg` exists with >= 1 `path` element, all 5 tab buttons clickable, content switches on click.
5. **Hook test** (unit): Mock `readFile` + `stdin` with tool input. Assert: output includes `additionalContext`, token count <= budget, execution < 200ms, always exits 0.
6. **Agent context test** (manual): Run Claude Code on test repo with and without wiki inject. Count tool calls to answer "what module handles authentication?". Target: <= 2 with inject.

## Rollback Strategy

- **Kill switch:** Delete `.codesift/wiki/wiki-manifest.json`. Without it, the wiki inject code path in `handlePrecheckRead` is a no-op (manifest not found → skip inject). No hook removal needed.
- **Fallback behavior:** Without manifest, agents work exactly as before (no inject, no degradation). Wiki markdown files remain on disk but are inert.
- **Full cleanup:** `rm -rf .codesift/wiki/` removes all generated content. No schema migrations, no persistent state changes, no side effects on other tools.
- **MCP tool:** `generate_wiki` tool is additive; removing it requires only deleting the registration in `register-tools.ts`.
- **Code revert:** Remove wiki inject branch from `handlePrecheckRead` (~30 LOC). Existing redirect behavior is in a separate `if` branch and unaffected.

The entire feature is pure additive -- zero modifications to existing tool behavior. Rollback = delete `.codesift/wiki/` directory.

## Backward Compatibility

- **Zero breaking changes.** All existing tools, CLI commands, hooks, and MCP tools remain unchanged.
- **No schema migrations.** No changes to index format, graph store, or session state.
- **CLI:** New commands (`wiki-generate`, `wiki-lint`) added alongside existing commands. No existing command renamed or removed.
- **Hooks:** New hook entry (`precheck-wiki`) added. Existing hooks (`precheck-read`, `precheck-bash`, `postindex-file`, `precompact-snapshot`) unchanged.
- **Potential confusion:** `generate_report` vs `generate_wiki` vs Lens HTML. Mitigated by clear `--help` text and mapping in `instructions.ts`.

## Out of Scope

### Deferred to v2

- **`--scope package` for monorepos** -- per-package wiki generation with inter-package dependency page. Rationale: requires workspace detection logic; v1 treats monorepo as single repo (communities naturally cluster per package).
- **`--watch` mode** -- auto-regenerate wiki on file changes using existing watcher infrastructure. Rationale: manual regeneration is sufficient for v1; watch mode adds complexity around debouncing and partial regeneration.
- **Sigma.js WebGL renderer** -- for repos with > 500 communities, D3 force layout may be slow. Sigma.js with pre-computed ForceAtlas2 positions is the upgrade path. Rationale: MAX_COMMUNITIES = 20 makes this unnecessary for v1.
- **LLM-enhanced page content** -- use LLM to generate natural-language descriptions of community purpose (e.g., "This module handles user authentication and session management"). Rationale: deterministic topology-based content is the v1 differentiator vs DeepWiki; LLM enhancement is additive.
- **Community auto-naming via TF-IDF** -- extract keywords from community files to generate meaningful names (e.g., "auth-session-module" instead of "src/auth"). Rationale: `nameCommunity()` path-prefix heuristic is sufficient for v1.
- **Dashboard integration** -- `/wiki` and `/lens` routes in the Astro dashboard at `/DEV/codesift-dashboard`. Rationale: wiki + lens work standalone; dashboard integration is a separate feature.

### Permanently out of scope

- **Hosting/serving wiki as a web app** -- wiki is local files, not a server. Users who want web access should commit to git and browse on GitHub.
- **Real-time collaboration on wiki** -- wiki is auto-generated, not human-edited. No conflict resolution needed.
- **Cross-language import edge detection** -- requires runtime analysis or explicit annotation. Static analysis across language boundaries (e.g., TS calling Python via REST) is fundamentally unreliable.

## Open Questions

None -- all questions resolved during Phase 2 design dialogue.

## Adversarial Review

**Providers:** cursor-agent, gemini (parsed from JSON)
**Status:** All CRITICAL findings resolved in spec revision. Remaining WARNINGs addressed or accepted.

### Resolved CRITICALs:
1. **WikiManifest missing file→community map** (gemini + cursor-agent): Added `file_to_community: Record<string, string>` to WikiManifest.
2. **AC8 byte-identical vs Louvain non-determinism** (gemini + cursor-agent): AC8 revised — idempotency applies to non-community-assignment content; slug redirect map preserves link integrity.
3. **AC5 chord ≥1 arc vs 0-1 communities** (cursor-agent): AC5 revised — chord diagram requirement conditional on communities >= 2; empty state with notice for <= 1.
4. **Hook npx cold-start vs 200ms SLA** (gemini + cursor-agent): Resolved by merging wiki inject into existing `handlePrecheckRead` (direct binary, not npx). Budget changed to +50ms incremental.
5. **manifest.degraded field missing** (gemini + cursor-agent): Added `degraded: boolean` + `degraded_reasons?: string[]` to WikiManifest.
6. **wiki-inject command missing from COMMAND_MAP** (gemini): Resolved — no separate command needed; wiki inject merged into existing precheck-read handler.

### Resolved WARNINGs:
7. **DD1 manifest location ambiguity** (gemini): Manifest lives in `.codesift/wiki/wiki-manifest.json` (repo-side, alongside wiki pages). Hash cache for staleness comparison reads current index hash at runtime from the index store (no separate cache file).
8. **No summary step for hook inject** (gemini): Added DD7 — pre-generated `.summary.md` files per community (~200-400 tokens) for hook consumption.
9. **Interaction Contract missing** (spec reviewer + adversarial): Added full Interaction Contract section defining target/protected surfaces, override order, and rollback boundary.

### Accepted WARNINGs:
10. **Success criteria #2-3 subjective** (cursor-agent): Accepted — onboarding acceleration is inherently human-evaluated. Validation methodology section specifies the protocol (timed task on fixed fixture). Automated proxies would test the wrong thing.
11. **Surprise scoring complexity caps** (cursor-agent): Surprise scoring iterates community pairs (max 20×20=400 pairs) × co-change pairs (typically <100). Worst case: ~40K comparisons in <100ms. No cap needed at current MAX_COMMUNITIES=20.

---

## Appendix: File Changes

### New files (3)

| File | Purpose | Estimated LOC |
|------|---------|--------------|
| `src/tools/wiki-tools.ts` | `generateWiki()`, page generators, summary generators, surprise scoring, manifest, lint | ~650 |
| `src/tools/lens-tools.ts` | `generateLens()`, HTML template with inline D3/marked/JSON | ~400 |
| `src/cli/wiki-commands.ts` | `handleWikiGenerate()`, `handleWikiLint()` CLI handlers | ~120 |

### Modified files (6)

| File | Change | Lines changed |
|------|--------|--------------|
| `src/cli/commands.ts` | Add `wiki-generate`, `wiki-lint` to `COMMAND_MAP` | +4 |
| `src/cli/help.ts` | Add help text for wiki commands | +15 |
| `src/cli/hooks.ts` | Extend `handlePrecheckRead` with wiki inject branch | +30 |
| `src/register-tools.ts` | Register `generate_wiki` MCP tool | +15 |
| `src/register-tool-loaders.ts` | Add lazy loader for wiki + lens tools | +5 |
| `src/instructions.ts` | Add wiki tool to CODESIFT_INSTRUCTIONS | +3 |

**Total estimated: ~1,170 LOC new, ~72 LOC modified.**
