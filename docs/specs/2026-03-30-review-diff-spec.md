# review_diff — Design Specification

> **spec_id:** 2026-03-30-review-diff-1845
> **topic:** Compound diff review tool with parallel static analysis
> **status:** Approved
> **created_at:** 2026-03-30T18:45:00Z
> **approved_at:** 2026-03-30T19:30:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

When an AI agent reviews code changes, it currently makes 6-8 sequential MCP tool calls to gather static analysis data: `impact_analysis`, `scan_secrets`, `find_dead_code`, `search_patterns`, `analyze_hotspots`, `analyze_complexity`. Each call has latency overhead, token overhead (repeated repo/ref params), and the agent must manually correlate results across calls.

CKB (SimplyLiz/CodeMCP) ships a `reviewPR` tool that runs 17 deterministic checks in parallel in ~5 seconds, returning a single structured JSON. This is a proven competitive advantage — agents get comprehensive static analysis in 1 call instead of 6-8.

CodeSift already has 6 of the 9 needed checks as standalone tools. The gap is: no compound orchestrator, no co-change coupling analysis, no breaking change detection, no source-to-test gap detection.

**Who is affected:** Zuvo skills (`/review`, `/ship`, `/build`) and any agent workflow that reviews diffs.

**What happens if we do nothing:** Agents continue making 6-8 sequential calls per review, wasting ~60-70% of tokens on the static analysis phase. Competitive disadvantage vs CKB.

## Design Decisions

### D1: Scope — 9 checks in v1

**Chosen:** 6 existing tools composed + 3 new checks (coupling, breaking, test-gaps).

**Why:** These 9 cover the highest-value checks from CKB's 17. The remaining 8 (risk-score composite, classify, split, traceability, critical-paths, comment-drift, health grades, reviewer suggestion) are lower priority and can be added incrementally in v2 without changing the output schema.

**Rejected alternative:** Ship all 17 checks at once. Too much scope — comment-drift (Go-only in CKB), traceability, independence are niche features that don't justify delaying v1.

### D2: Parallel execution with partial failure tolerance

**Chosen:** `Promise.allSettled` with per-check `Promise.race` timeout (8s default).

**Why:** Proven pattern in `report-tools.ts` (`generateReport`). A timeout in `scan_secrets` (avg 9.2s) must not abort blast-radius analysis. CKB uses the same pattern (Go `sync.WaitGroup`).

**Rejected alternative:** Sequential execution (like `codebase_retrieval`). That tool is sequential due to OOM risk from concurrent filesystem walks. `review_diff` sub-checks are index-based — no concurrent FS walks, parallel is safe.

### D3: Configurable check selection via `checks` parameter

**Chosen:** `checks?: string[]` parameter filters which checks run. Empty = all.

**Why:** Skills need different check subsets. `/ship` only needs `["secrets", "breaking", "blast-radius", "bug-patterns"]`. `/review` needs all. CKB has the same pattern (`opts.Checks []string`).

### D4: HoldTheLine — only flag issues on changed lines

**Chosen:** Default behavior: findings filtered to changed lines only. Pre-existing issues in untouched code are not reported.

**Why:** CKB defaults to `HoldTheLine: true`. Without this, every review_diff call would surface hundreds of pre-existing issues, drowning the actual diff-related findings. Can be disabled via parameter in v2.

### D5: Token budget with per-check allocation

**Chosen:** `token_budget` parameter (default 15,000) with per-check caps. T3 findings truncated first when budget exceeded.

**Why:** The 30K global hard cap in `formatResponse` would silently truncate mid-JSON, producing invalid output. Per-check budgeting prevents this.

### D6: Co-change coupling — Jaccard algorithm

**Chosen:** codegraph/optave algorithm (verified from source code):
- `git log --name-only --no-merges --diff-filter=AMRC --since=180d`
- Skip commits with >50 files (bulk operations)
- Jaccard = `count / (countA + countB - count)`
- minSupport=3, minJaccard=0.5 (higher than codegraph's 0.3 to reduce noise)

**Why:** Exact same algorithm used by codegraph (36 stars), CKB, and Chisel. Battle-tested. Simple to implement with existing `execFileSync("git", ...)` pattern.

### D7: Breaking change detection — tree-sitter AST diff

**Chosen:** Compare exported symbols between `since` and `until` refs using tree-sitter:
1. `git show <since>:<file>` → parse → extract exported symbol names + signatures
2. Current file → parse → extract exported symbol names + signatures
3. Diff: removed exports = T1 finding, changed signatures = T1 finding
4. Renames suppressed via `git diff --find-renames`

**Why:** CKB uses SCIP (language server protocol) for this — more precise but requires SCIP indexer. Tree-sitter is already available in CodeSift and covers the 80% case (export presence/absence) without additional dependencies.

**Limitation:** Cannot detect signature-level breaking changes for dynamically typed languages. Acceptable for v1.

### D8: Test gap detection — naming + import graph

**Chosen:** Two-pathway detection (inspired by Chisel TestMapper, verified from source):
1. Naming convention: `auth.ts` → look for `auth.test.ts`, `auth.spec.ts`, `__tests__/auth.ts`
2. Import graph: find test files that import the changed source file (via existing index)
3. If both pathways → 0 tests → finding

**Why:** Chisel's 3-pathway system (direct + co-change + import-graph with 0.88^hops decay) is more sophisticated but over-engineered for v1. Naming + imports covers 90% of real test relationships.

## Solution Overview

A new MCP tool `review_diff` that:
1. Parses the git diff once (via existing `changedSymbols`)
2. Fans out to 9 parallel sub-checks via `Promise.allSettled`
3. Each sub-check wrapped in `Promise.race` for timeout protection
4. Results assembled into tiered findings (T1=blocking, T2=important, T3=info)
5. Token budget enforced per-check, T3 findings truncated first
6. Returns structured JSON with verdict (pass/warn/fail), score (0-100), and findings

```
Agent calls review_diff(repo, since="HEAD~3")
    │
    ├── 1. Parse diff once ──────────────────────────────────────┐
    │                                                            │
    ├── 2. Fan out (parallel) ──────────────────────────────┐    │
    │   ├── blast-radius (impact_analysis, scoped)          │    │
    │   ├── secrets (scan_secrets, scoped to diff files)    │    │
    │   ├── dead-code (find_dead_code, scoped)              │    │
    │   ├── bug-patterns (search_patterns, batched)         │    │
    │   ├── hotspots (analyze_hotspots, scoped)             │    │
    │   ├── complexity-delta (NEW)                          │    │
    │   ├── coupling-gaps (NEW)                             │    │
    │   ├── breaking-changes (NEW)                          │    │
    │   └── test-gaps (NEW)                                 │    │
    │                                                       │    │
    ├── 3. Assemble findings ───────────────────────────────┘    │
    │   ├── Assign tiers (T1/T2/T3)                              │
    │   ├── Filter to changed lines (HoldTheLine)                │
    │   ├── Calculate score (0-100)                              │
    │   └── Enforce token budget                                 │
    │                                                            │
    └── 4. Return ReviewDiffResult ──────────────────────────────┘
```

## Detailed Design

### Data Model

```typescript
// Input
interface ReviewDiffOptions {
  repo: string;
  since: string;
  until?: string;           // default: "HEAD". Special: "WORKING", "STAGED"
  checks?: string[];        // filter which checks run. empty = all
  exclude_patterns?: string[]; // default: ["*.lock","*.min.js","dist/**","*.generated.*"]
  token_budget?: number;    // default: 15000
  max_files?: number;       // default: 50
  check_timeout_ms?: number; // default: 8000
}

// Per-check result (internal)
interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail" | "error" | "timeout" | "skip";
  tier: 1 | 2 | 3;
  summary: string;
  findings: ReviewFinding[];
  duration_ms: number;
}

// Individual finding
interface ReviewFinding {
  check: string;
  tier: 1 | 2 | 3;
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  end_line?: number;
  message: string;
  detail?: string;
  rule_id?: string;
  confidence?: number;       // 0.0-1.0
}

// Output
interface ReviewDiffResult {
  tool: "review_diff";
  version: string;
  diff_stats: {
    files_changed: number;
    lines_added: number;
    lines_removed: number;
    since: string;
    until: string;
  };
  verdict: "pass" | "warn" | "fail";
  score: number;              // 0-100
  checks: Array<{
    name: string;
    status: string;
    tier: 1 | 2 | 3;
    summary: string;
    duration_ms: number;
  }>;
  findings: ReviewFinding[];
  metadata: {
    total_checks: number;
    checks_passed: number;
    checks_failed: number;
    checks_errored: number;
    duration_ms: number;
    index_warning?: string;
    truncated_checks?: string[];
    files_capped?: boolean;
  };
}
```

### Tier Assignment (static, same as CKB)

```typescript
function findingTier(check: string): 1 | 2 | 3 {
  switch (check) {
    case "breaking":
    case "secrets":
      return 1;
    case "coupling":
    case "complexity":
    case "dead-code":
    case "blast-radius":
    case "bug-patterns":
      return 2;
    case "test-gaps":
    case "hotspots":
      return 3;
    default:
      return 3;
  }
}
```

### Verdict Calculation

```typescript
function determineVerdict(checks: CheckResult[]): "pass" | "warn" | "fail" {
  if (checks.some(c => c.status === "fail")) return "fail";
  if (checks.some(c => c.status === "warn")) return "warn";
  return "pass";
}
```

A check status is `"fail"` when it produces T1 findings (secrets, breaking changes).
A check status is `"warn"` when it produces T2 findings.
T3 findings never change the check status from `"pass"`.

### Score Calculation

Tiers are applied sequentially in order T1 → T2 → T3 → errors. Each tier's penalty applies to the running total, and the floor enforces a minimum for that tier's contribution only:

```typescript
function calculateScore(findings: ReviewFinding[], checks: CheckResult[]): number {
  let score = 100;

  // T1: each finding -20, can reach 0
  const t1Count = findings.filter(f => f.tier === 1).length;
  score -= t1Count * 20;
  score = Math.max(score, 0);

  // T2: each finding -5, cannot drop below 20
  const t2Count = findings.filter(f => f.tier === 2).length;
  score -= t2Count * 5;
  score = Math.max(score, 20);

  // But if T1 already dropped us below 20, T2 floor doesn't raise it
  if (t1Count > 0) score = Math.min(score, 100 - t1Count * 20);

  // T3: each finding -1, cannot drop below 50 (but T1/T2 can)
  const t3Count = findings.filter(f => f.tier === 3).length;
  score -= t3Count * 1;
  // T3 floor only applies if no T1/T2 findings dragged us lower
  if (t1Count === 0 && t2Count === 0) score = Math.max(score, 50);

  // Errored/timed-out checks: -3 each
  const errorCount = checks.filter(c => c.status === "error" || c.status === "timeout").length;
  score -= errorCount * 3;

  return Math.max(score, 0);
}
```

**Examples:**
- 1 secret (T1): score = 80
- 2 secrets (T1): score = 60
- 5 T2 findings, 0 T1: score = 75
- 1 T1 + 3 T2: score = 65 (80 - 15 = 65, T2 floor of 20 does not raise)
- 10 T3, 0 T1/T2: score = 90 (floor 50 not hit)

### API Surface

Single MCP tool registered in `TOOL_DEFINITIONS`:

```typescript
{
  name: "review_diff",
  description: "Run 9 parallel static analysis checks on a git diff. Returns tiered findings (T1=blocking, T2=important, T3=info) with verdict and score. Composes: blast-radius, secrets, dead-code, bug-patterns, hotspots, complexity-delta, coupling-gaps, breaking-changes, test-gaps.",
  schema: {
    repo: { type: "string", description: "Repository identifier" },
    since: { type: "string", description: "Base git ref (e.g. HEAD~3, commit SHA)" },
    until: { type: "string", description: "Target ref. Default: HEAD. Special: WORKING, STAGED" },
    checks: { type: "string", description: "Comma-separated check names to run (default: all)" },
    exclude_patterns: { type: "string", description: "Comma-separated globs to exclude" },
    token_budget: { type: "number", description: "Max tokens for response (default: 15000)" },
    max_files: { type: "number", description: "Warn if diff exceeds N files (default: 50)" },
    check_timeout_ms: { type: "number", description: "Per-check timeout in ms (default: 8000)" },
  },
  handler: reviewDiffHandler
}
```

Note: `checks` and `exclude_patterns` are comma-separated strings in the MCP schema (not JSON arrays) to match conventions used throughout CodeSift. The handler splits them before constructing the internal options object:

```typescript
// In reviewDiffHandler (register-tools.ts):
const opts: ReviewDiffOptions = {
  repo: args.repo,
  since: args.since,
  until: args.until ?? "HEAD",
  checks: args.checks ? args.checks.split(",").map(s => s.trim()) : undefined,
  exclude_patterns: args.exclude_patterns ? args.exclude_patterns.split(",").map(s => s.trim()) : DEFAULT_EXCLUDE,
  token_budget: zNum(args.token_budget) ?? 15000,
  max_files: zNum(args.max_files) ?? 50,
  check_timeout_ms: zNum(args.check_timeout_ms) ?? 8000,
};
```

The split happens once in the handler. All internal functions receive typed `ReviewDiffOptions` with `string[]` arrays.

### Integration Points

**Existing tools composed (internal function calls, not MCP calls):**

| Check | Existing function | File | Scoping |
|-------|------------------|------|---------|
| `blast-radius` | `impactAnalysis()` | `src/tools/impact-tools.ts` | Pass `since` directly |
| `secrets` | `scanSecrets()` | `src/tools/secret-tools.ts` | `file_pattern` = changed files joined |
| `dead-code` | `findDeadCode()` | `src/tools/symbol-tools.ts` | `file_pattern` = changed files |
| `bug-patterns` | `searchPatterns()` | `src/tools/pattern-tools.ts` | See bug-patterns scoping below |

**Bug-patterns scoping:** `searchPatterns` accepts a single `pattern` string per call. For `review_diff`, run all BUILTIN_PATTERNS (currently 7: `empty-catch`, `any-type`, `console-log`, `todo-fixme`, `magic-number`, `deep-nesting`, `scaffolding`) in a single `Promise.all` inside the bug-patterns check, each scoped to `file_pattern` = changed files. Merge all findings, deduplicate by `(file, line, rule_id)`. Token allocation: 2000 tokens shared across all pattern results — if exceeded, keep findings sorted by confidence desc and truncate lowest. This sub-parallelism is safe because `searchPatterns` reads from the in-memory index (no FS walks).
| `hotspots` | `analyzeHotspots()` | `src/tools/hotspot-tools.ts` | `file_pattern` = changed files |

**New internal functions (in `review-diff-tools.ts`):**

| Check | New function | Algorithm |
|-------|-------------|-----------|
| `complexity` | `checkComplexityDelta()` | `analyze_complexity` on changed files, compare with `git show <since>:<file>` parse |
| `coupling` | `checkCouplingGaps()` | `git log --name-only` → Jaccard matrix → missing partners |
| `breaking` | `checkBreakingChanges()` | `git show <since>:<file>` → tree-sitter exports → diff with current |
| `test-gaps` | `checkTestGaps()` | naming convention + import graph → no test = finding |

**Shared utility — changed file list:**

Do NOT extract `getChangedFiles()` from `impact-tools.ts`. Instead, call the existing public `changedSymbols()` from `diff-tools.ts` as the first step. It returns `{files: [{path, symbols, diff?}]}` — extract the file paths:

```typescript
const diffResult = await changedSymbols(index, { since, until });
const changedFiles = diffResult.files.map(f => f.path);
```

For `WORKING`/`STAGED` sentinels, `changedSymbols` already supports different git diff modes internally. If it doesn't support `WORKING`/`STAGED`, extend its `since`/`until` handling rather than creating a parallel utility. This keeps the diff parsing in one place.

The `changedFiles: string[]` list is then passed to all sub-checks as `file_pattern` for scoping.

### Edge Cases

| Case | Handling |
|------|---------|
| Empty diff (since === until) | `{verdict: "pass", score: 100, findings: [], diff_stats: {files_changed: 0}}` |
| Invalid git ref | Pre-flight `validateGitRef(since)` + `validateGitRef(until)`. Return `{error: "invalid_ref: ..."}` |
| >50 changed files | T3 informational finding `"large_diff: N files changed, results may be incomplete"`. All checks still run but scoped. |
| Non-git repo | Pre-flight `git rev-parse --is-inside-work-tree`. Error response. |
| Individual check timeout | `Promise.race([check(), timeout(8000)])` → `{status: "timeout"}` in checks array. Other checks unaffected. |
| Stale index | `metadata.index_warning` when `since` is not HEAD~1. Document that analysis reflects HEAD state. |
| Renamed files | `git diff --find-renames` → parse rename pairs → suppress false-positive breaking-change findings |
| Binary/generated files | `exclude_patterns` filters before sub-checks. Defaults exclude lockfiles, minified, dist. |
| Token budget exceeded | Per-check allocation. When total exceeds budget, truncate T3 findings first, then T2 detail fields. Never truncate T1. |
| WORKING/STAGED sentinel | `until: "WORKING"` → `git diff <since>` (no second ref). `until: "STAGED"` → `git diff --cached <since>`. |

## Acceptance Criteria

**Must have:**

1. `review_diff(repo, since)` returns valid `ReviewDiffResult` JSON for any valid git ref range.
2. All 9 checks execute in parallel; a failure/timeout in one does not abort others.
3. Each finding includes `check`, `tier`, `severity`, `file`, `message`.
4. T1 findings (secrets, breaking) set verdict to `"fail"`.
5. Empty diff returns `{verdict: "pass", score: 100, findings: []}`.
6. Invalid `since` ref returns structured error, not stack trace.
7. `scan_secrets` is scoped to changed files only (not full repo).
8. `checks` parameter correctly filters which checks execute.
9. Response is valid JSON at all sizes (no mid-JSON truncation).
10. Per-check timeout prevents single check from blocking entire call.

**Should have:**

11. `coupling` check detects missing co-changed files with Jaccard >= 0.5.
12. `breaking` check detects removed/renamed exported symbols between refs.
13. `test-gaps` check identifies changed source files with no corresponding test.
14. `exclude_patterns` correctly filters binary/generated files from all checks.
15. `WORKING` and `STAGED` sentinels work for uncommitted changes.
16. Rename detection suppresses false-positive breaking-change findings.
17. Score calculation reflects finding severity distribution.

**Edge case handling:**

18. >50 files produces informational warning, does not abort.
19. Non-git repo returns clean error response.
20. Timed-out checks appear as `{status: "timeout"}` in response.
21. `metadata.index_warning` present when reviewing historical diffs.

## Out of Scope

- **LLM narrative generation** — CKB has `--llm` flag for AI summary. Not in v1.
- **Risk score composite** — Chisel's 5-factor formula. Deferred to v2.
- **PR split suggestion** — CKB splits large PRs into clusters. Deferred to v2.
- **Change classification** — feature/bugfix/refactor breakdown. Deferred to v2.
- **Traceability** — commit-to-ticket linkage. Deferred to v2.
- **Reviewer independence** — regulated industry check. Deferred to v2.
- **Health grades** — A-F code health delta. Deferred to v2.
- **CODEOWNERS integration** — affected owners, suggested reviewers. Deferred to v2.
- **Comment drift** — numeric mismatch in const blocks. Deferred to v2.
- **Dismissals** — `.codesift/review-dismissals.json` for silencing known issues. Deferred to v2.
- **HoldTheLine toggle** — default is hold-the-line, no parameter to disable in v1.
- **Zuvo skill file modifications** — the skill integration (making `/review` call `review_diff`) is a separate task after the tool ships.
- **CI/CD integration** — GitHub Action, exit codes, SARIF output. Deferred.

## Open Questions

None — all design questions resolved during Phase 2 dialogue.
