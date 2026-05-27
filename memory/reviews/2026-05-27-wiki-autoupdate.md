# Code Review — wiki auto-update + session overview

- **Scope:** HEAD~1..HEAD (commit `1f4f07b`)
- **Diff:** 6 files, +520/-12 | type: mixed (prod + test + docs)
- **Tier:** TIER 2 STANDARD (prod-logic ~250 lines; 520 total inflated by 221-line test file)
- **Intent:** FEATURE | **Self-review:** YES (author == reviewer)
- **Verdict:** APPROVE — 0 MUST-FIX, 2 RECOMMENDED (low-conf), 2 NIT
- **Deployment risk:** MEDIUM (score 2: +1 >500 lines, +1 multi-module blast) — merge after full suite (green: 4153 passed)

## Tool Availability
| Tool / Index | Status | Used For |
|---|---|---|
| CodeSift index | EMPTY-RESULT (git fallback used) — index_folder reported 9512 files/245765 symbols but per-repo queries returned "Repository not found" (registry/data-dir race this session) | changed_symbols, impact, patterns |
| audit_scan | OK (0 findings CQ8/11/13/14/17/REACT — weak signal, possibly stale index) | CQ8/11/13/14/17 |
| scan_secrets | UNAVAILABLE (not registered this session) → grep fallback (0 hits) | CAP5 |
| changed_symbols / diff_outline / review_diff | UNAVAILABLE (not registered) → git diff fallback | structural diff |
| adversarial-review | OK (gemini; claude auto-excluded as self-host) — 0 findings | cross-model |

## Mandatory tools
- review_diff: UNAVAILABLE this session → git-diff fallback (structural review done natively)
- changed_symbols: git fallback → 14 new functions (wikiOverviewMaxChars, positiveIntEnv, findRepoRootFromDir, currentGitCommit, tryLoadProjectOverview, sevRank, wikiRegenMaxFiles, wikiRegenStatePath, shouldDebounceWikiRegen, maybeRegenerateWiki, captureGitCommit + edits to handleSessionStart/handlePostindexFile/handleWikiGenerate/main)
- diff_outline: git fallback (6 files)
- impact_analysis: "Repository not found" (degraded) — blast radius assessed manually: hooks.ts + cli.ts + wiki-tools.ts + wiki-commands.ts = CLI/hook surface only; no library API consumers
- scan_secrets: grep fallback → 0 hardcoded secrets
- search_patterns(empty-catch): degraded; manual CQ8 audit → 8 catch blocks, all safe-default/commented (file convention)
- find_references: not required (no finding cites a library symbol)

## CQ self-eval (changed prod files: src/cli.ts, src/cli/hooks.ts, src/cli/wiki-commands.ts, src/tools/wiki-tools.ts)
- CQ3 input validation: PASS (hook input parsed defensively; slug regex guard `^[a-z0-9-]+$`)
- CQ4 multi-tenant orgId: N/A (no DB/tenant code)
- CQ5 null/undefined guards: PASS (manifest parse guards, null repoRoot returns, optional-chaining on manifest fields)
- CQ6/CQ8 error handling: PASS (every catch returns safe default; "CQ8: never crash the hook" convention preserved)
- CQ11 complexity: PASS (functions small, single-purpose)
- CQ14 duplication: minor — see R-3
Critical gates: all PASS.

## Findings

### RECOMMENDED
R-1 [RECOMMENDED] `process.exit(0)` may truncate buffered stdout on large piped output
  File: src/cli.ts:102
  Confidence: 52/100
  Evidence: one-shot commands now force-exit to defeat the embedding/onnx keep-alive hang. For large-output commands (search/tree/symbols-batch) piped to a file, Node's process.exit can truncate an unflushed stdout buffer.
  Note: NET IMPROVEMENT — before this change those commands hung forever (pipe never closed). Risk is the standard Node exit caveat, low for the small summaries of index/wiki-generate.
  Fix (optional): drain before exit, e.g. `process.stdout.write("", () => process.exit(0))` or set process.exitCode and unref remaining handles.

R-2 [RECOMMENDED] SessionStart runs a synchronous `git rev-parse HEAD` on the hot path
  File: src/cli/hooks.ts:262
  Confidence: 48/100
  Evidence: when a v2 wiki exists, every session start spawns git via spawnSync (1.5s timeout) to compute the staleness hint. Normally ~10-30ms but blocking; worst case 1.5s if git stalls.
  Fix (optional): skip the staleness probe (auto-regen already keeps the wiki fresh) or gate it behind an env flag.

### NIT
NITs (2 — no functional impact):
  R-3 duplicate git-HEAD helper: src/cli/hooks.ts:262 (currentGitCommit) vs src/tools/wiki-tools.ts:127 (captureGitCommit) — could share a util. (cross-module, different sync APIs — acceptable)
  R-4 src/cli/hooks.ts:352 — tryLoadProjectOverview truncates via slice(0,max) mid-line — cosmetic; could trim to last newline.

## Quality wins
- Found+fixed a real latent bug during E2E: cli.ts never exited → one-shot commands hung → would have leaked a zombie process per hook-spawned regen. Now gated force-exit.
- Performance-conscious design: structural trigger makes the common case (editing known files) cost ZERO regen; size gate + 30min throttle + detached spawn cap worst case.
- Strong test coverage: 14 targeted tests incl. opt-outs, throttle, structural + size gates; full suite 4153 green.

## Test analysis
New file tests/cli/hooks-wiki-overview.test.ts (14 tests) covers overview injection (v2/v1/missing/opt-out), auto-regen spawn, AUTO_REGEN opt-out, throttle, structural gate (known vs new file), size gate. child_process + index-tools mocked. Adequate.
