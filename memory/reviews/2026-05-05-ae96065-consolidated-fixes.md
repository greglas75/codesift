# Review: ae96065 — fix: consolidate agent fixes (Hono mounts, extractors, tools, CLI)

- **Tier:** 3 (DEEP)
- **Scope:** 55 files (+1691 / -313 lines), 27 prod / 20 test / 4 fixture / 4 doc
- **Intent:** BUGFIX (consolidation of prior-review follow-ups)
- **Risk signals:** API (Hono extractor), >500L, new prod files (heritage-edges.ts, constant-file-pattern.ts), AI co-author (Cursor)
- **Verdict:** **REQUEST CHANGES — 1 MUST-FIX (cross-provider CRITICAL)**, 6 RECOMMENDED, 4 NIT
- **Verification:** Test suite PASS (3792 passed / 1 skipped, 272 files, 71.85s) — but the MUST-FIX defect is on an exception path that current tests do not exercise.
- **Deployment risk:** MEDIUM (4 pts) — API contract +2, >500 lines +1, new prod files +1; recommend full test suite and the MUST-FIX patch pre-merge.

## Tool Availability

| Tool / Index       | Status                                | Used For   |
|--------------------|---------------------------------------|------------|
| CodeSift index     | NOT INDEXED (extractor v2→v3 stale)   | —          |
| analyze_complexity | UNAVAILABLE (stale index)             | —          |
| analyze_hotspots   | SKIPPED (stale index)                 | —          |
| search_patterns    | SKIPPED (stale index)                 | —          |
| adversarial pass 1 | OK (gemini timeout, cursor-agent ran) | F1.6       |
| adversarial pass 2 | OK (rotated provider)                 | F1.6       |

## Skipped Steps

- **CodeSift pre-compute:** index is stale (`typescript` extractor v2.0.0 → current v3.0.0). Reindexing would have taken >2 min on this repo, and since the diff *is* a self-modification of the indexer, a fresh pre-merge index would still misalign.
- **Adversarial pass 2 with first attempt:** failed because zuvo updated from 1.3.102 → 1.3.103 mid-session and the absolute path in PATH cache was stale. Re-run with corrected path succeeded.

---

## FINDINGS

### MUST-FIX

#### R-0 [MUST-FIX] [CROSS:cursor-agent] `hono.ts` — `inFlight` set leaks on `walkRouteMounts` throw

- **File:** `src/parser/extractors/hono.ts:142-153` (cache-hit branch — NEW in this commit) AND `src/parser/extractors/hono.ts:233-247` (main-path branch — pre-existing same-shape bug)
- **Severity:** CRITICAL (cross-provider, bypasses confidence gate; effective confidence 100/100)
- **Evidence:**
  ```ts
  try {
    const importMap = this.extractImportMap(replayTree.rootNode, file);
    const localMounts: HonoMount[] = [];
    inFlight.add(file);
    await this.walkRouteMounts(...);   // ← if this rejects/throws…
    inFlight.delete(file);              // ← …this never runs
  } finally {
    replayTree.delete();                // ← only this is in the finally
  }
  ```
  Same pattern at line 234-247: `inFlight.add(file); await walkRouteMounts(...); inFlight.delete(file);` — `delete` is OUTSIDE the `try { … } finally { tree.delete(); }`.
- **Impact:** A single transient I/O error or parse failure inside `walkRouteMounts` poisons the cycle-detection set for the rest of the extraction. Subsequent attempts to parse the same file hit `inFlight.has(file)` and short-circuit, recording `parse_cycle_skipped` for what is not actually a cycle. Indexes built after a transient hiccup will silently miss real routes — exactly the failure class this commit is *trying to fix*.
- **Why tests miss it:** `walkRouteMounts` doesn't throw under any current fixture; the suite covers happy paths and explicit cycle inputs, not exception propagation. `tests/parser/hono-extractor.test.ts` would not catch this.
- **Fix:**
  ```ts
  inFlight.add(file);
  try {
    await this.walkRouteMounts(...);
  } finally {
    inFlight.delete(file);
    replayTree.delete();   // (cache-hit branch only)
  }
  ```
  Apply at both call sites. Add a unit test with a stubbed `walkRouteMounts` that throws to assert `inFlight.size === 0` after the call.

---

### RECOMMENDED

#### R-1 [RECOMMENDED] tsconfig-paths.ts — lost ancestor cache population (perf regression)

- File: `src/utils/tsconfig-paths.ts:75-94`
- Confidence: 80/100
- Evidence: Pre-fix `findNearestTsconfig` populated `dirToConfigCache` for every dir visited during the walk (`for (const v of visited) dirToConfigCache.set(v, candidate);`). Post-fix only the input dir gets cached. With repoRoot now in the key, ancestor population is still safe and would still O(1) sibling lookups under the same parent, but it was removed.
- Impact: O(N) repeated walks from sibling dirs of a deep import tree on every alias resolve. Was previously O(1) after first hit.
- Fix: Re-introduce ancestor caching with the new compound key:
  ```ts
  let cur = resolve(dir);
  const visited: string[] = [];
  while (isDirInsideRepo(repoRootAbs, cur)) {
    visited.push(cur);
    const candidate = join(cur, "tsconfig.json");
    if (existsSync(candidate)) {
      for (const v of visited) dirToConfigCache.set(dirToConfigCacheKey(v, repoRoot), candidate);
      return candidate;
    }
    ...
  }
  for (const v of visited) dirToConfigCache.set(dirToConfigCacheKey(v, repoRoot), null);
  ```

#### R-2 [RECOMMENDED] heritage-edges.ts — silent skip on ambiguous heritage targets

- File: `src/utils/heritage-edges.ts:48-52`
- Confidence: 75/100
- Evidence: When 2+ files declare a class/interface with the same simple name (e.g. duplicated `User` types in two domains), `resolveHeritageTargetFile` returns `null` with no telemetry — that heritage edge is dropped silently. For a feature branded "Best-effort module-level edges", the silent miss erodes graph completeness without any signal.
- Impact: Knowledge map under-reports heritage edges in monorepos with namespace collisions.
- Fix: Persist a `heritage_resolution_skipped: { ambiguous: number; unresolved: number }` field on the persistent graph (mirrors existing `skip_reasons` pattern in `hono-model.ts`).

#### R-3 [RECOMMENDED] [CROSS:cursor-agent] git-hooks-installer.ts — no path normalization on `core.hooksPath` equality

- File: `src/cli/git-hooks-installer.ts:171-194`
- Confidence: 65/100 (cross-provider WARNING)
- Evidence: Compares the global `core.hooksPath` value to `hooksDir` via raw string equality. Tilde expansion, trailing slashes, or symlinked home directories make the same dir appear as different strings.
- Impact: Either (a) the `otherGlobalHooksPath` branch fires on a path that IS ours, leaving config untouched and emitting a confusing warning, or (b) we falsely match and skip a legitimate other-hooks dir. Latter is the riskier failure.
- Fix: `realpathSync(currentHooksPath) === realpathSync(hooksDir)` (with a try/catch in case current path doesn't exist).

#### R-4 [RECOMMENDED] [CROSS:cursor-agent + LEAD] index-store.ts — degenerate empty-index reports arbitrary language

- File: `src/storage/index-store.ts:84-94`
- Confidence: 70/100
- Evidence: When `index.files.length === 0 && storedKeys.length === 0`, `collectExtractorVersionMismatches` picks `Object.keys(currentVersions)[0]!` as the reported language. The error message then says e.g. "stale typescript extractor" when there's actually no index at all — misleading for diagnosis.
- Fix: Either (a) introduce a distinct stale `reason: "empty_index"` separate from `extractor_version_mismatch`, or (b) populate `mismatch_detail` with an explicit "index has no files" sentinel so the degenerate case is visible.

#### R-5 [RECOMMENDED] pattern-tools.ts — postFilter fail-open is an undocumented behavior change

- File: `src/tools/pattern-tools.ts:712-732`
- Confidence: 65/100
- Evidence: Pre-fix comment said `match dropped` on postFilter throw; new code keeps the match (fail-open) with rationale "transient postFilter bugs do not hide security findings." Reasonable for security patterns, but it's an inverted default with no test asserting either side. A buggy custom postFilter regex now silently produces false positives instead of being noticed.
- Fix: Add a unit test that asserts a throwing postFilter keeps the match AND emits the warning to stderr; document the change in CHANGELOG.

#### R-6 [RECOMMENDED] react-tools.ts — `sym.id ?? sym.name` fallback masks unset id

- File: `src/tools/react-tools.ts:804`
- Confidence: 60/100
- Evidence: `computePropChainDepth(sym.id ?? sym.name, ...)` — but `reverseAdj` is built from `adjacency.children` keyed by `sym.id` only (line 130: `children.set(sym.id, childList)`). If `sym.id` is ever undefined, the fallback to `sym.name` looks up a key guaranteed not to be in the reverse adjacency → silently returns 0 instead of surfacing the type contract violation. Since `CodeSymbol.id` is required by the type, the fallback hides bugs rather than fixing them.
- Fix: Drop the `?? sym.name` fallback. If a runtime guard is desired, throw with a clear "missing id on symbol from extractor X" message.

---

### NIT

#### R-7 [NIT] constant-file-pattern.ts — 4-char threshold permits substring false positives

- File: `src/utils/constant-file-pattern.ts:18`
- Confidence: 50/100
- Evidence: Patterns of length ≥4 without a slash fall through to `f.includes(p)`. So `pattern="core"` matches both `src/core/x.ts` and `src/scoreboard.ts`. Documented intent is "avoid loose substring false positives on short patterns" but 4 is still loose for common English fragments.
- Fix: Either raise threshold to 6, or require word-boundary match on the substring fallback.

#### R-8 [NIT] symbol-tools.ts — collectReExportedFiles regex misses common forms

- File: `src/tools/symbol-tools.ts:842-858`
- Confidence: 50/100
- Evidence: Regex anchored with `^\s*export\s+...` only matches export at line start. Misses:
  - `; export * from "./x"` (continuation)
  - `/** doc */ export { Y } from "./x"` (block comment prefix)
  - `import { Y } from "./y"; export { Y }` (no `from`, two-step re-export)
- Impact: Some barrel-style modules using non-standard layouts will still false-positive as dead.
- Fix: Either drop the `^` anchor, or use the existing tree-sitter parser to walk export_statement nodes.

#### R-9 [NIT] [CROSS:cursor-agent] commands.ts — `--no-git-hooks` vs `--git-hooks` precedence ambiguity

- File: `src/cli/commands.ts:464-481`
- Confidence: 50/100 (cross-provider WARNING/INFO)
- Evidence: `wantGitHooks = options.hooks || getBoolFlag(flags, "git-hooks") === true` — git hooks can run when `options.hooks` is false if `--git-hooks` is true; combined with the `--no-git-hooks` short-circuit on a different dimension, contradictory flags depend on parser ordering.
- Fix: Document precedence in `--help` (e.g. "`--no-git-hooks` always wins"). Not a bug, an operational footgun.

#### R-10 [NIT] [CROSS:cursor-agent] hono.ts replay error context discarded

- File: `src/parser/extractors/hono.ts:122-141`
- Confidence: 45/100 (cross-provider INFO)
- Evidence: `catch { ... skip_reasons[...] += 1; return; }` discards the error message and stack — only counter increments. On-call diagnostics for "why are 2k routes missing in production index?" have no breadcrumb.
- Fix: Capture `String(err)` once into `model.skip_reasons.last_error_message` (or similar) so a single example reaches the report.

---

### Adversarial findings DROPPED

- **ADV-3** (typescript.ts inner walk duplicate symbols): outer switch case `export_statement` returns after handling. The inner `walk(inner, sym.id, true)` is the only walk into the anonymous default's body. No duplication path under current grammar. Confidence too low.
- **ADV-7** (python.ts meta reassignment): `sym.meta = { ...(sym.meta ?? {}), partial_extraction: true }` is the canonical immutable-update idiom and preserves all enumerable own properties. Adversarial provider's concern about non-enumerable properties is over-cautious; tree-sitter `meta` objects are always plain JSON-shaped records. Drop.

---

## QUALITY WINS (top 3)

1. **Hono double-mount fixture + 3 unit tests** at `tests/parser/hono-extractor.test.ts:97-133` — regression coverage for the mount cache bug, including `parent_var` inheritance from the owner variable. Full integration fixture under `tests/fixtures/hono/double-mount-app/`.
2. **F14 dead-code regression suite** at `tests/integration/tools.test.ts:1015-1088` — three discrete tests covering tests-as-references, `export * from`, and named re-exports. Each scenario reproduced the exact false-positive that hit production users.
3. **Defense-in-depth on path traversal** — `tsconfig-paths.ts`, `import-graph.ts`, and now `symbol-tools.ts` all use the same `relative()` + `isAbsolute()` + `..`-prefix triple-check for inside-repo containment. Consistent pattern across the codebase reduces the chance of future regressions.

---

## TEST ANALYSIS

- New tests added: 11 prod-affecting tests (3 F14 dead-code regressions, 3 Hono double-mount, 5 TypeScript extractor gaps, plus 4 misc).
- Test suite passes at HEAD (`ae96065`): 3792 passed / 1 skipped, 272 files, 71.85s.
- **Coverage gap relative to MUST-FIX:** No test covers the `walkRouteMounts` exception path. Adding such a test (stubbed throw → assert `inFlight.size === 0`) would have caught R-0 before merge.

## Backlog deltas (post-review)

Move from `[ ]` to `[x]` (already shipped in this commit per evidence):
- `typescript-constants-tools.ts|perf|pathmap` — memoized in `state.normalizedPathMap`
- `typescript-constants-tools.ts|robustness|readFile-catch` — narrows ENOENT vs other I/O
- `typescript-constants-tools.ts|numeric|Number-precision` — `!Number.isFinite(n)` + `!Number.isSafeInteger(n)` guards
- `constant-resolution-tools.ts|UX|infer-lang-fallback` — returns `[]` instead of `["python"]`
- `index-store.ts|tolerance-dedup` — `isExtractorVersionCurrent` delegates to `collectExtractorVersionMismatches`
- `index-store.ts|edge|empty-extractor` — degenerate-empty-index branch returns mismatch (note: see R-4, language is arbitrary)
- `status-tools.ts|resilience|detectStale` — try/catch wrapper + shared `resolveRegisteredRepoMeta`

Add new entries (this review):
- **R-0** `hono.ts|correctness|inflight-leak-on-throw` — MUST-FIX, both cache-hit and main-path branches
- R-1 `tsconfig-paths.ts|perf|ancestor-cache-lost`
- R-2 `heritage-edges.ts|telemetry|ambiguous-skip-counter`
- R-3 `git-hooks-installer.ts|robustness|hookspath-normalize`
- R-4 `index-store.ts|UX|empty-index-language-arbitrary`
- R-5 `pattern-tools.ts|test|postFilter-fail-open-untested`
- R-6 `react-tools.ts|hygiene|sym-id-fallback-masks-bug`
- R-7 `constant-file-pattern.ts|precision|4char-substring-fp`
- R-8 `symbol-tools.ts|coverage|reexport-regex-anchored-misses`
- R-9 `commands.ts|UX|git-hooks-flag-precedence`
- R-10 `hono.ts|observability|replay-error-context-lost`
