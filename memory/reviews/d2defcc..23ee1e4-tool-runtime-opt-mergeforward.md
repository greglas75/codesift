<!-- zuvo-review -->
---
range: d2defcc..23ee1e4
files: *
scope: perf/tool-runtime-opt merge-forward onto post-#21 main
tier: 2
verdict: APPROVE
---

# Merge-forward review — perf/tool-runtime-opt onto new main

The perf branch (7 commits, already TIER-3 reviewed —
`4cad382..b39c0e7-tool-runtime-opt.md`) had to be merged forward across PR #8 +
PR #21 (45 commits). The one real conflict is the same class as the sql.ts
resolution in #21: the perf branch **edited tool definitions in place** in
`register-tool-groups/core.ts` + `analysis.ts`, while PR #21 **split those files**,
relocating every definition into `core/{search,symbols,meta}.ts` and
`analysis/review.ts`.

Taking main's side drops the perf edits; taking perf's side undoes the split.
Resolved by keeping main's split structure and **re-applying each perf edit to
the definition's new home**:

| perf edit | ported to |
|---|---|
| `find_references` max_refs cap + `DEFAULT_MAX_REFS`/`normalizeMaxRefs` | `core/symbols.ts` |
| `get_file_tree` compact-by-default | `core/search.ts` |
| `cacheable: true` × get_repo_outline | `core/search.ts` |
| `cacheable: true` × detect_communities, find_circular_deps | `core/meta.ts` |
| `cacheable: true` × analyze_complexity, fan_in_fan_out, architecture_summary, nest_audit | `analysis.ts` |
| `cacheable: true` × audit_scan | `analysis/review.ts` |

`find_references` needed genuine merging (not a diff apply): main had evolved it
past the perf branch's base — adding `.trim().min(1)` validation, `zJsonArray`,
and a required-arg throw. The max_refs cap was woven **into** that evolved handler,
preserving both. The perf infra (`handler-wrappers.ts`, the `cacheable` field in
`shared.ts`, the runtime wiring) auto-merged clean — main never touched it.

## Verification

- `tsc --noEmit` — **0 errors**. Every relocated definition resolves; the
  `cacheable` field is recognized; 8 `cacheable: true` flags present (3 core + 5
  analysis, matching the reviewed perf branch exactly).
- The 43 tests covering this exact surface — `core-token-diet`,
  `handler-wrappers`, `wrapper-wiring`, `meta-usage-stats`, `tool-wrappers-smoke`
  — **all pass**. They find tools by `name:` through the `CORE_TOOL_ENTRIES`
  aggregator, so they exercise the ported edits regardless of which file now
  holds the definition.

## Known environment caveat (NOT a code finding)

A full `npm test` in this reused worktree shows 54 failures in PHP/Yii + parser
tests. Verified they fail **identically on clean origin/main in this same
worktree** (detached-HEAD run) and pass in a fresh checkout — a stale
per-worktree environment artifact (the php tree-sitter parse returns an
unwalkable tree here despite a byte-identical grammar), orthogonal to this merge.
CI (fresh `npm ci` + `download-wasm`) is the authoritative environment, exactly
as for PR #21.
