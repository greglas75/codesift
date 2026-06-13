# zuvo:review — 4-feature plan, aggregate cross-task review

- **Date:** 2026-06-13
- **Scope:** `2a6e4f0..ab615b2` (16 commits) — the approved 16-task plan in `docs/specs/2026-06-11-codesift-four-features-plan.md`
- **Diff:** 35 files, +9833/−42, mixed (prod + test). **TIER 3 — DEEP.**
- **Mode:** FIX-AUTO (apply MUST-FIX + localized/high-confidence RECOMMENDED, backlog structural/NIT).
- **Features:** F1 cross-repo contract groups · F2 live Postgres introspection · F3 Model2Vec static embeddings · F4 hash-snapshot cold-start sync.
- **Fixes commit:** `78843ec`

## Method & framing

Each of the 16 commits already passed 1–6 rounds of per-task cross-provider adversarial during `zuvo:execute`. The aggregate review's unique value is therefore the **cross-task / integration view** that per-task review structurally cannot see: bugs at the seams between features and contract mismatches between modules built in different tasks. Three TIER-3 audit agents (Behavior / CQ / Structure) were scoped to the integration seams; a post-fix cross-provider adversarial pass (gemini + cursor-agent + codex, `--multi`) validated the fix diff.

## Deterministic scans (degraded — CodeSift self-repo index unavailable this session)

`review_diff: absent-in-build (git/grep substitution)` · secret_hits=0 · empty_catch=0 (2 bare `catch {` are commented intentional skips) · `as any`=0 · TODO/FIXME=0 · `scan_secrets: absent-in-build (grep secret-scan: 0)`.

## Findings & disposition

### MUST-FIX (applied)

- **BEHAV-1 — `register-tools.ts` `repo_group` create returned `{}`.** `registerGroup` returns `void`; `JSON.stringify({group: undefined})` → `"{}"`. Caller got no confirmation; automation could read it as a failed create and retry → duplicate groups. **Fix:** read the persisted group back via `getGroup`; fail loud (`{error}`) if read-back misses (corruption / concurrent delete). `register-tools.ts:4869`.
- **BEHAV-2 — `register-tools.ts` `introspect_pg` `drift_check` vacuous result.** With no/unindexed `repo`, an empty symbol list made `pgDriftCheck` report "no drift" masquerading as a clean check. The schema description promised CWD auto-detect the code never implemented. **Fix:** promote to a **top-level** `{error}` (not buried under `drift`, where pipelines gating on `"error" in result` would skip it); trim/type-guard `repo`; explicit error when `getCodeIndex` returns `null` (unindexed). `register-tools.ts:4831`.

### RECOMMENDED (applied — localized, high-confidence)

- **CQ-1 — `index-tools.ts:490` empty-string sentinel in snapshot.** `shas[j] ?? ""` persisted `""` for a null hash. **Fix:** omit the entry so no reader can mistake `""` for a valid sha1. (No in-repo reader gives `""` special meaning; the only consumer compares sha equality and treats absent → re-hash.)
- **BEHAV-3 — `static-embedding-provider.ts:148` stale `dimensions` on all-cache-hit.** Getter returned the 256 static-table fallback when `embed()` never ran. **Fix:** read the real column count from the module cache (read-only — authoritative `#realDims` still set by `embed()` from real output).
- **STRUCT-5 — `cross-repo-contract-tools.ts` duplicate `ContractMatch` import** (two mid-file imports, one aliased `_ContractMatch`). **Fix:** consolidated into the top-of-file import.

### Post-fix adversarial hardening (applied)

The `--multi` pass on the fix diff raised 6 items; 5 accepted as hardening of the fixes, 1 dismissed:
- repo_group read-back failure now returns explicit error (was silent `{group: undefined}`).
- drift_check error promoted to top level (pipelines gating on `"error"` no longer skip it).
- drift_check `index === null` (unindexed/typo'd repo) now an explicit error, not a vacuous "no drift".
- `repo` arg trimmed/type-guarded (`"   "` no longer truthy-passes).
- `dimensions` getter made non-mutating (no early pinning from a read path).
- **Dismissed:** snapshot key-presence "mixed-version reader" concern — speculative; snapshot is versioned (v1) and local-only, no diverging reader exists in-repo.

### Deferred → `memory/backlog.md` (structural-refactor + NIT)

STRUCT-3 (indexFolder ~358-exec-line monolith → zuvo:refactor), STRUCT-1/4 (file-size splits), STRUCT-6/7/8/9/10 (dead export, util over-exports, registry ENOENT-vs-parse, lexer type un-export [TS4023 risk], inline import-type), CQ-2 (consumer-scan per-repo file cap), CQ-3 (sequential repo resolution), CQ-4 (nested-backtick lexer false-negative), BEHAV-4 (snapshot+watcher cold-start tax — correct-by-design).

## CQ critical-gate verdict

CQ5 credential redaction (pg conn string env-only, redacted on every throw, absent from telemetry `TOOL_ARG_FIELDS`) — **PASS**. CQ8 timeouts (connect + statement + wall-clock + finally end(); download connect/inactivity/size caps + partial-file cleanup) — **PASS**. CQ3 SQL-injection via `schema` (parameterized `$1`, numeric timeout interpolation only) — **PASS**. CQ6 fan-out caps (MAX_GROUP_REPOS=20, MAX_DOWNLOAD_BYTES, MAX_HEADER_BYTES) — **PASS**. No MUST-FIX from CQ.

## Verification

tsc `--noEmit` clean · `npm run build` exit 0 · **full suite 4522 passed / 3 skipped / 0 failed** · post-fix adversarial re-run satisfied.

## Deployment risk

New production files (+1) · API contract surface — new MCP tools (+2) · multi-module blast radius (+1). **Score 4 — MEDIUM.** Merge after review, full suite run (done). No auth/payment/migration factors.

## Verdict

**APPROVE.** 2 confirmed seam bugs fixed, 3 RECOMMENDED + 5 adversarial hardenings applied, 0 residual MUST-FIX. Structural-refactor and NIT items backlogged with recipes. All critical gates pass; full suite green.
