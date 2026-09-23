<!-- zuvo-review -->
range: 3608aba..bca873d
adversarial: zuvo/proofs/competitive-a-5491d20035-adversarial.txt
files: src/cli/hooks/pre-compact.ts,src/cli/hooks/session.ts,src/instructions.ts,src/register-tool-groups/core/symbols.ts,src/register-tools/discovery.ts,src/server-helpers.ts,src/server-helpers/response-budget.ts,src/server-helpers/shown-source.ts,src/server-helpers/stdio-envelope.ts,src/server.ts,src/tools/explore-tools.ts,src/tools/graph-tools.ts

Verified-against: bca873d

```
CODE REVIEW | TIER 3 (DEEP) | caller: zuvo:ship (v0.18.0 release)
SCOPE:  12 production files, 3608aba..bca873d | INTENT: FEATURE
AUDIT:  TEAM (behavior, structure, CQ auditors + confidence re-scorer + coverage-check, sonnet)
        adversarial --multi x4 passes (cursor-agent, codex-5.3, codex-5.4, byteplus, byteplus-alt,
        byteplus-3, openrouter, openrouter-3, openrouter-4, claude, muse)
RISK:   MEDIUM (API contract: new tool, new params; transport change) — full suite before merge
SELF-REVIEW: yes — --multi used on every pass
CodeSift MCP: unavailable (server disconnected mid-session) — git/grep substitutes, recorded below
```

VERDICT: PASS after in-run fixes (0 open MUST-FIX).

## FINDINGS — all fixed in this range

R-1 [MUST-FIX, fixed c7452d5] Ledger recorded a body as shown before delivery (formatting failure,
  explore clipping, cap truncation each produced a false "unchanged" pointer).
  File: src/server-helpers/shown-source.ts:203 (check vs record split: src/server-helpers/shown-source.ts:150)
  Confidence: 90 (adversarial CRITICAL, cursor-agent; BEHAV-1)
R-2 [MUST-FIX, fixed c7452d5] Ledger survived /clear (stdio process reused). SessionStart resets it.
  File: src/cli/hooks/session.ts:30
R-3 [MUST-FIX, fixed c7452d5] Prefixed vs unprefixed ids of one symbol missed each other.
  File: src/server-helpers/shown-source.ts:122
R-4 [RECOMMENDED, fixed c7452d5] Compaction marker compared mtime to Date.now().
  File: src/server-helpers/shown-source.ts:79
R-5 [RECOMMENDED, fixed c7452d5] serveStdio swallowed a failed transport start (BEHAV-2).
  File: src/server.ts:629
R-6 [MUST-FIX (CQ8 critical gate), fixed c7452d5] explore rendered a call-graph failure as "no callers".
  File: src/tools/explore-tools.ts:81
R-7 [RECOMMENDED, fixed c7452d5] Truncation notice landed outside the cap; wrong resume line after a mid-line cut.
  File: src/server-helpers/response-budget.ts:19 ; src/server-helpers.ts:256
R-8 [RECOMMENDED, fixed c7452d5] main() 127 lines / explore() 70 lines (CQ11).
  File: src/server.ts:611
R-9 [RECOMMENDED, fixed c7452d5] onClosed skipped if the owner's close handler threw; null bundle symbol.
  File: src/server-helpers/stdio-envelope.ts:69 ; src/register-tool-groups/core/symbols.ts:237
R-10 [RECOMMENDED, fixed ac385c0] Over-long single line clipped to an empty body; NaN top; BRIEF beat single.
  File: src/tools/explore-tools.ts:65 ; src/tools/explore-tools.ts:152 ; src/instructions.ts:172
R-11 [MUST-FIX, fixed bca873d] An ambiguous top hit failed the whole explore call (adversarial CRITICAL, claude).
  File: src/tools/explore-tools.ts:119
R-12 [RECOMMENDED, fixed bca873d] countLines counted a trailing newline as a line.
  File: src/server-helpers.ts:200

## REJECTED (with evidence)
- Cascade vs ledger: no shortener registered for any source-returning tool (register-tools.ts:220-227).
- Cross-repo key collision: a pointer requires an identical body hash, so it stays content-true.
- Ledger shared by daemon clients: enableShownSourceLedger is called only on the stdio path.
- envelopeClientName ignores clientInfo without the protocol key: 2025 clients go through oninitialized.
- "await touchCompactionMarker": it is synchronous. "explore lacks elision": false.
- Body inside the budget cut by cutAtRecordBoundary: the cut lands at or after the separator following it.

## BACKLOG (memory/backlog.md, 2026-09-23 block)
- [RECOMMENDED, structural] no automated dual-era stdio test — src/server.ts:560
- [RECOMMENDED, structural] get_symbol vs get_symbols render `export` differently — src/tools/symbol-lookup-tools.ts:282
- [NIT] formatSymbolsCompact re-export chain unused by handlers — src/tools/symbol-context-tools.ts:48
- [NIT] exact repeats served from the response cache bypass the ledger — src/server-helpers.ts:133

## CQ EVAL (per file, from the CQ auditor at 29b8025; re-checked after fixes)
- src/instructions.ts: PASS (critical CQ3=1 CQ4=N/A CQ5=1 CQ6=1 CQ8=N/A CQ14=1)
- src/server-helpers/stdio-envelope.ts: PASS
- src/server-helpers/shown-source.ts: PASS
- src/server-helpers/response-budget.ts: PASS (new, pure config)
- src/server-helpers.ts: PASS (CQ11 pre-existing size)
- src/register-tool-groups/core/symbols.ts: PASS (CQ11 pre-existing size)
- src/cli/hooks/pre-compact.ts, src/cli/hooks/session.ts: PASS
- src/register-tools/discovery.ts: PASS
- src/tools/graph-tools.ts: PASS (CQ11 pre-existing size)
- src/tools/explore-tools.ts: FAIL at 29b8025 (CQ8=0, CQ11=0) -> PASS after c7452d5
- src/server.ts: PASS (main() extracted)

## VALIDITY GATE
  review_diff: absent-in-build (codesift MCP disconnected; audit via 3 sub-agents + git diff)
  changed_symbols/diff_outline: absent-in-build (git diff --stat + per-file reads)
  impact_analysis: absent-in-build (callers traced by behavior auditor)
  scan_secrets: absent-in-build (grep secret-scan on diff: 0)
  audit_tree: readonly(29b8025)
  tier2_subagents: behavior DISPATCHED(returned) | structure DISPATCHED(returned) | cq DISPATCHED(returned) | confidence_rescorer DISPATCHED(returned)
  adversarial: passes_run=4, AR_RC=0 each, self_review_flag=yes — used --multi
  mutation_chain: not_required (report-only)
  gate_status: PASS (codesift degraded, recorded)
