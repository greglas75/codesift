# Tool Adoption Fixes — Design Specification

> **spec_id:** 2026-04-14-tool-adoption-fixes-1845
> **topic:** Fix tool discovery pipeline to boost adoption of underused tools
> **status:** Approved
> **created_at:** 2026-04-14T18:45:00Z
> **reviewed_at:** 2026-04-14T19:15:00Z
> **approved_at:** 2026-04-14T19:30:00Z
> **approval_mode:** interactive
> **adversarial_review:** warnings
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift has 146 MCP tools but usage is concentrated in the top 5 (70% of 6,606 calls over 21 days). High-value tools like `review_diff` (9 parallel static analysis checks in 1 call), `scan_secrets` (1,100 rules), and `trace_route` (full endpoint trace, saves ~29K tokens vs 5+ search_text calls) have near-zero adoption.

Root causes identified through full usage data analysis + code exploration:

1. **plan_turn tells agents to "call describe_tools" even though it already auto-reveals tools** — causes 75 unnecessary describe_tools calls in 3 days (14% of all calls)
2. **review_diff and scan_secrets are hidden** (not in CORE_TOOL_NAMES) — agents never see them
3. **H9 hint points to hidden tool** (semantic_search) — broken nudge that can't convert
4. **Framework auto-load uses process.cwd() at startup** — fails for GUI apps where CWD ≠ project root
5. **No contextual nudges** when agents use inefficient patterns (e.g., grep for routes instead of trace_route)
6. **plan_turn's structural signal (W_STRUCTURAL=0.4) amplifies popular tools** — self-reinforcing bias

If we do nothing: agents continue burning 7.7% of all calls (507/6,606) on discovery overhead, and the 50+ ghost tools remain permanently undiscovered despite being production-ready.

## Design Decisions

1. **Inline params in plan_turn instead of "call describe_tools"** — the `extractToolParams()` function already exists and is used by `discover_tools`. Reuse it in `formatPlanTurnResult()` to include compact param signatures. This eliminates the describe_tools roundtrip for plan_turn users.

2. **Add review_diff + scan_secrets to CORE_TOOL_NAMES** — these are composite tools that provide outsized value per call. They should be visible to all agents without discovery.

3. **Auto-reveal semantic_search when H9 fires** — call `enableToolByName("semantic_search")` alongside emitting the hint, so the agent can immediately use it.

4. **Trigger detectAutoLoadTools on indexed path after index_folder** — the `indexFolder()` handler knows the exact project root. Use that path instead of (or in addition to) `process.cwd()`.

5. **Add contextual H-codes for underused tools** — when `search_text` matches route/endpoint patterns, nudge toward `trace_route`. When patterns match secrets, nudge toward `scan_secrets`.

6. **Reduce W_STRUCTURAL from 0.4 to 0.1** — diminish popularity bias in plan_turn's tool ranking so specialized tools can surface when they're a better match.

## Solution Overview

Six targeted fixes across 5 source files. No new tools, no breaking API changes.

```
Fix 1: plan-turn-tools.ts  — formatPlanTurnResult() adds inline params, removes "call describe_tools" text
Fix 2: register-tools.ts   — CORE_TOOL_NAMES += review_diff, scan_secrets
Fix 3: server-helpers.ts   — H9 handler calls enableToolByName("semantic_search")
Fix 4: register-tools.ts   — index_folder handler calls detectAutoLoadToolsCached(indexed_path)
Fix 5: server-helpers.ts   — New H13 (route nudge) and H14 (secrets nudge) hint codes
Fix 6: tool-ranker.ts      — W_STRUCTURAL = 0.1
Also:  instructions.ts     — H12/H13/H14 added to hint legend
```

**Agent-visible changes:** Fix 2 adds 2 tools to ListTools at startup. Fix 3 adds 1 tool to ListTools mid-session (after H9 fires). Fix 5 adds new hint prefixes to search_text responses. Fix 6 changes plan_turn ranking order. All are additive — no existing behavior removed.

## Detailed Design

### Fix 1: plan_turn inline params

**File:** `src/tools/plan-turn-tools.ts`, function `formatPlanTurnResult()` (line 583)

Change the tool output section (lines 616–622) to include compact param signatures per tool. Use existing `extractToolParams()` from `register-tools.ts`.

**Current output:**
```
─── Tools (2) ───
  trace_route [hidden]  confidence: 0.950
    Traces HTTP route → handler → service → DB
```

**New output:**
```
─── Tools (2) ───
  trace_route  confidence: 0.950
    Traces HTTP route → handler → service → DB
    params: path (required), method?, framework?
```

Remove the "Reveal Required" section entirely (lines 630–635). The tools are already auto-revealed by `enableToolByName()` at line 3819 of register-tools.ts — the text is misleading.

**Import change:** Export `extractToolParams` from `register-tools.ts` and import it in `plan-turn-tools.ts`. Do NOT use `describeTools` — it takes an array of names and returns a full `DescribeToolsResult` object, wrong interface for inline per-tool use.

**Lazy schema caveat:** Hidden tools use `lazySchema()` wrappers that may not resolve until first invocation. `extractToolParams` calls `Object.entries(def.schema)` which may return empty for unresolved lazy schemas. Mitigation: in `formatPlanTurnResult()`, call the lazy schema getter to force resolution before extracting params. If resolution fails, omit the params line for that tool (graceful degradation — same as today).

### Fix 2: CORE_TOOL_NAMES additions

**File:** `src/register-tools.ts`, `CORE_TOOL_NAMES` set (line 719)

Add after line 753 (after `nest_audit`, at the end of the composite tools block):
```typescript
  "review_diff",             // 9 parallel static analysis checks on git diffs
  "scan_secrets",            // ~1100 secret detection rules
```

This changes core count from 51 to 53.

### Fix 3: H9 auto-reveal semantic_search

**File:** `src/server-helpers.ts`, around line 252

Current:
```typescript
if (toolName === "search_text" && typeof args["query"] === "string" && QUESTION_PATTERN.test(args["query"])) {
    hints.push(`⚡H9`);
}
```

Add `enableToolByName("semantic_search")` call when H9 fires. This requires exporting `enableToolByName` from register-tools.ts (currently module-private). Export it as a named export. To avoid circular import risk between server-helpers.ts and register-tools.ts, inject it as a callback during server initialization rather than importing directly.

### Fix 4: Framework auto-load on index_folder path

**File:** `src/register-tools.ts`, index_folder handler (line 802)

After `indexFolder()` completes, call `detectAutoLoadToolsCached(args.path)` to check the indexed path (not CWD) for framework signals. This handles the case where the MCP server started from home directory but the user indexes `/Users/x/projects/my-next-app/`.

```typescript
handler: async (args) => {
  const result = await indexFolder(args.path as string, { ... });
  // Auto-enable framework tools based on indexed path
  const toEnable = await detectAutoLoadToolsCached(args.path as string);
  for (const name of toEnable) enableToolByName(name);
  return result;
},
```

### Fix 5: New contextual H-codes

**File:** `src/server-helpers.ts`, in `buildResponseHint()` function

**H13 — Route nudge:** When `search_text` is called with query matching route patterns (`/api/`, `endpoint`, `handler`, `router`, `middleware`):
```typescript
if (toolName === "search_text" && typeof args["query"] === "string" &&
    ROUTE_PATTERN.test(args["query"])) {
  hints.push(`⚡H13 route query detected → try trace_route(path=) for full endpoint tracing`);
}
```

**H14 — Secrets nudge:** When `search_text` is called with query matching secret patterns (`api.key`, `token`, `secret`, `password`, `credential`, `AWS_`, `OPENAI_`):
```typescript
if (toolName === "search_text" && typeof args["query"] === "string" &&
    SECRET_PATTERN.test(args["query"])) {
  hints.push(`⚡H14 secret query detected → try scan_secrets(min_confidence="high") for comprehensive detection`);
}
```

Also add H12/H13/H14 to the hint code legend in `src/instructions.ts` (line 20, after H11). H12 already exists in server-helpers.ts but is missing from the legend:
```
H12    → batch search_text into codebase_retrieval
H13    → use trace_route for endpoints   H14 → use scan_secrets for credentials
```

### Fix 6: Reduce structural bias

**File:** `src/search/tool-ranker.ts`, line 71

Change:
```typescript
const W_STRUCTURAL = 0.4;
```
To:
```typescript
const W_STRUCTURAL = 0.1;
```

This reduces the popularity-based signal weight from 0.4 to 0.1. The lexical (1.0), identity (2.0), and semantic (0.8) signals remain unchanged and will dominate rankings. Specialized tools that match the query semantically will no longer be outranked by popular generic tools.

### Integration Points

- **Fix 1 + Fix 2 interact:** With review_diff/scan_secrets now in CORE, plan_turn's `is_hidden` flag will be false for them, so the old "Reveal Required" section wouldn't fire anyway. But removing the section entirely is still correct for other hidden tools that plan_turn recommends.
- **Fix 3 requires exporting enableToolByName** — currently module-private in register-tools.ts. Export it.
- **Fix 4 reuses existing detectAutoLoadToolsCached** — already handles caching and dedup.
- **Fix 5 regex patterns** must avoid false positives. E.g., `ROUTE_PATTERN` should not match every mention of "route" in general text queries — anchor to patterns like `/api/`, `POST `, `GET /`, `router.`, `app.get(`.

### Interaction Contract

Multiple fixes change agent-visible behavior:

- **Fix 2:** `review_diff` and `scan_secrets` appear in ListTools at session start (2 new tools). Additive — no existing tools removed.
- **Fix 3:** `semantic_search` appears in ListTools mid-session after H9 fires. The MCP SDK's `handle.enable()` sends a `tools/list_changed` notification — clients that subscribe will see it immediately. Clients with stale caches will see it on next ListTools refresh. Note: `enableToolByName()` is already used by plan_turn (line 3819) so this is an established pattern, not a new contract.
- **Fix 5:** New `⚡H13` and `⚡H14` hint prefixes may appear in `search_text` responses. Hints are advisory text prepended to results — same mechanism as existing H1-H12.
- **Fix 6:** `plan_turn` may return different tool rankings. No format change — same fields, different ordering.

### Edge Cases

1. **H13/H14 fire on irrelevant queries:** E.g., search_text("api key management feature") could trigger H14 incorrectly. Use strict regex: require compound patterns like `API_KEY`, `api.key`, `apiKey`, `AWS_SECRET` — not bare words like "secret" or "token" alone. Non-trigger examples: "secret santa feature", "token pagination", "route to success".
2. **index_folder called with partial path:** E.g., `index_folder(path="src/")` — detectAutoLoadTools needs the project root, not a subdirectory. Only trigger auto-load when path looks like a project root (contains package.json, composer.json, etc.).
3. **W_STRUCTURAL=0.1 causes regression for valid popular recommendations:** search_text is sometimes genuinely the best tool. The identity signal (W=2.0) and lexical signal (W=1.0) still heavily favor exact name matches, so "search for text" queries will still correctly recommend search_text.
4. **enableToolByName called for already-enabled tool:** Idempotent — `enableToolByName()` (line 340) checks handle.enable existence before calling. No side effects on double-call.
5. **extractToolParams returns empty for hidden tool with unresolved lazy schema:** Omit params line for that tool. Agent falls back to describe_tools — same as today.
6. **Multiple hints co-occur (e.g., H9 + H13 on same call):** Hints stack as ordered list. Validation checks substring presence, not prefix position.

### Failure Modes

#### plan_turn formatter (Fix 1)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| extractToolParams returns empty for a tool | params array length === 0 | Single tool in plan_turn output | Tool listed without params (same as today) | Agent falls back to describe_tools | None | Immediate |
| formatPlanTurnResult output exceeds context budget | Response length check | Single plan_turn call | Slightly longer response (~200 tokens more) | CASCADE shortener handles overflow | None | Immediate |
| Import of extractToolParams fails at build time | TypeScript compilation error | All plan_turn calls | plan_turn returns error | Fix import, redeploy | None | Build time |

**Cost-benefit:** Frequency: rare (~1%) × Severity: low (fallback exists) → Mitigation cost: trivial → **Decision: Mitigate with empty-array guard**

#### CORE_TOOL_NAMES expansion (Fix 2)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Agent context overloaded with 53 vs 51 tool schemas | Token counting in session | All sessions | Marginally less room for code context | Remove tools from CORE if needed | None | Observable over days |
| review_diff/scan_secrets have bugs not caught by testing | Error in tool execution | Agents that call these tools | Tool returns error instead of results | Fix bug, redeploy | None | Immediate |
| Agents call review_diff/scan_secrets when inappropriate | Usage log review | Sessions where tools are called | Wasted call (~1s) | Agent moves on to next tool | None | Observable in usage stats |

**Cost-benefit:** Frequency: low × Severity: negligible (2 extra tools in schema) → Mitigation cost: zero → **Decision: Accept**

#### H9 auto-reveal (Fix 3)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Callback not injected during initialization | H9 fires but enableTool is null | H9 hints only | semantic_search stays hidden (same as today) | Add null-check guard | None | Startup |
| semantic_search requires embedding provider not configured | Tool returns "no embeddings" error | Agent that calls semantic_search | Agent falls back to search_text | Agent switches tools | None | Immediate |
| enableToolByName called for already-enabled semantic_search | Idempotent — no side effects | None | None | N/A | None | N/A |

**Cost-benefit:** Frequency: moderate (H9 fires on question queries) × Severity: low → Mitigation cost: low (callback injection with null guard) → **Decision: Mitigate with callback injection**

#### Framework auto-load on index_folder (Fix 4)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| index_folder path is a subdirectory, not project root | detectAutoLoadTools returns empty (no package.json found) | No framework tools enabled | Same as today — no regression | None needed | None | Immediate |
| detectAutoLoadToolsCached adds latency to index_folder | Timing in usage stats | index_folder calls | ~5ms additional latency (filesystem check) | Acceptable | None | Immediate |
| Framework tools auto-enabled for wrong project (false positive) | Tool returns "not a Hono project" errors | Agent calls Hono tools on non-Hono project | Wasted call, clear error message | Agent ignores and moves on | None | Immediate |
| Multiple index_folder calls auto-enable different framework bundles | enabledFrameworkBundles set dedup | None — idempotent | No visible effect | None needed | None | N/A |

**Cost-benefit:** Frequency: every index_folder call × Severity: negligible (filesystem check) → Mitigation cost: trivial → **Decision: Mitigate (root detection heuristic)**

#### New H-codes (Fix 5)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| H13/H14 regex too broad — fires on irrelevant queries | False positive rate in usage stats | Agent sees unnecessary hint | Agent ignores hint (no harm) | Tighten regex | None | Observable in usage stats |
| H13/H14 regex too narrow — misses valid cases | False negative rate | Agent doesn't see hint when it should | Same as today — no regression | Broaden regex | None | Observable |
| Agent follows H13 but trace_route fails (repo not indexed for call graph) | trace_route returns error | Agent that follows hint | Agent falls back to search_text | Agent adapts | None | Immediate |

**Cost-benefit:** Frequency: moderate × Severity: nil (hints are advisory) → Mitigation cost: low → **Decision: Accept (start narrow, broaden based on data)**

#### Structural weight reduction (Fix 6)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Popular tools ranked too low for queries where they're genuinely best | plan_turn result quality degradation | plan_turn users | Slightly less relevant top-1 recommendation | Agent uses second recommendation or falls back | None | Observable in usage stats |
| Niche tools ranked too high and confuse agent | plan_turn result quality | plan_turn users | Agent calls wrong tool, gets error, retries | Agent falls back to second recommendation | None | Observable |
| No observable change (other signals dominate at W_LEXICAL=1.0, W_IDENTITY=2.0) | A/B comparison of rankings | None | None | N/A | None | N/A |

**Cost-benefit:** Frequency: every plan_turn call × Severity: low (other signals compensate) → Mitigation cost: trivial (change one constant) → **Decision: Mitigate — monitor plan_turn result quality for 1 week after deploy**

## Acceptance Criteria

**Ship criteria** (must pass for release — deterministic, fact-checkable):

1. `formatPlanTurnResult()` output includes `params:` line for each recommended tool (shows required + notable optional params; tools with no params show `params: (none required)`; tools with unresolved lazy schema omit the params line)
2. `formatPlanTurnResult()` output does NOT contain "call describe_tools" or "Reveal Required" text
3. `review_diff` and `scan_secrets` appear in `CORE_TOOL_NAMES` set
4. After calling `search_text(query="how does authentication work")`, `semantic_search` appears as callable in the MCP tool list (verified by calling `semantic_search` without prior `describe_tools(reveal=true)`)
5. `index_folder` handler calls `detectAutoLoadToolsCached(path)` after indexing completes
6. H13 fires when `search_text` query matches `/\/api\/|endpoint|handler|router\.|middleware|app\.(get|post|put|delete)/i`
7. H14 fires when `search_text` query matches `/api[._-]?key|AWS_|OPENAI_|SECRET_KEY|password|credential/i` (note: bare "secret" and "token" excluded to avoid false positives)
8. `W_STRUCTURAL` value is 0.1 in `tool-ranker.ts`
9. All existing tests pass (`npm test`)
10. No circular imports introduced (build succeeds)

**Success criteria** (must pass for value validation — measurable quality/efficiency):

1. `describe_tools` share of total calls drops by ≥50% (baseline: 14% of calls over 3 days → target: ≤7%)
2. `review_diff` appears in usage stats with ≥5 calls in first week (baseline: 0)
3. `scan_secrets` appears in usage stats with ≥3 calls in first week (baseline: 0)
4. Framework tools appear in usage stats for repos indexed via `index_folder` from a non-matching CWD
5. `plan_turn` share of total calls increases (baseline: 3.6% → target: ≥5%)

## Validation Methodology

**describe_tools reduction:**
```bash
# After 7 days, run:
cat ~/.codesift/usage.jsonl | python3 -c "
import sys, json
from datetime import datetime
cutoff = int(datetime(2026, 4, 21).timestamp() * 1000)  # 7 days after deploy
tools = {}
for line in sys.stdin:
    r = json.loads(line)
    if r['ts'] >= cutoff:
        tools[r['tool']] = tools.get(r['tool'], 0) + 1
print(f'describe_tools: {tools.get(\"describe_tools\", 0)}')
print(f'plan_turn: {tools.get(\"plan_turn\", 0)}')
print(f'review_diff: {tools.get(\"review_diff\", 0)}')
print(f'scan_secrets: {tools.get(\"scan_secrets\", 0)}')
"
```

**Framework auto-load verification:**
```bash
# Start MCP server from home directory, then index a Next.js project:
# index_folder(path="/Users/x/projects/my-next-app")
# Then check: nextjs_route_map should appear in ListTools
```

**H13/H14 verification:**
```bash
# Call search_text(query="/api/users POST handler")
# Verify response starts with ⚡H13
# Call search_text(query="AWS_SECRET_ACCESS_KEY")
# Verify response starts with ⚡H14
```

## Rollback Strategy

Each fix is independent and can be reverted individually:

- **Fix 1:** Revert formatPlanTurnResult changes → agents see old output, call describe_tools as before
- **Fix 2:** Remove review_diff/scan_secrets from CORE_TOOL_NAMES → tools return to hidden
- **Fix 3:** Remove enableToolByName call from H9 → semantic_search stays hidden (same as before)
- **Fix 4:** Remove detectAutoLoadToolsCached call from index_folder handler → startup-only detection (same as before)
- **Fix 5:** Remove H13/H14 hint conditions → no nudges emitted (same as before)
- **Fix 6:** Change W_STRUCTURAL back to 0.4 → old ranking behavior

Kill switch: none needed — all changes are internal pipeline improvements. No user-facing API changes, no data migrations, no config changes.

## Backward Compatibility

- **Tool schemas:** No changes. 53 core tools instead of 51 — existing agents get 2 more tools in ListTools.
- **plan_turn output format:** Changed but not in a breaking way. Existing agents parsing plan_turn text will see additional `params:` lines and absence of "Reveal Required" section. No structured contract to break.
- **Instructions:** H13/H14 added to hint legend in instructions.ts. Agents that don't know these hints will ignore them (hints are advisory).
- **Usage log format:** No changes to usage.jsonl schema.

## Out of Scope

### Deferred to v2

- **Reduce CORE_TOOL_NAMES to ~15-20 tools** — research suggests fewer visible tools improves selection, but requires plan_turn to be proven reliable first. Wait for post-deploy data.
- **Dynamic instruction payloads** — project-specific routing tables instead of static 1.5K-token blob. High value but high complexity.
- **"Did you mean?" for unregistered_tool calls** — 13 calls with invented tool names. BM25 fuzzy match against tool names. Low volume, medium value.
- **Positional bias mitigation** — randomize tool order in ListTools or implement BiasBusters subset-selector. Requires careful testing.
- **plan_turn as mandatory first call** — auto-inject plan_turn recommendation in first tool response if agent hasn't used it yet. Risky UX change.

### Permanently out of scope

- **Generic execute_tool dispatcher** (Speakeasy/Synaptic Labs pattern) — loses native function calling semantics which models are trained for. CodeSift's current design (core tools visible + discovery pipeline) is architecturally superior for tool-call-optimized models.
- **Removing describe_tools/discover_tools** — still needed as manual fallback for edge cases where plan_turn doesn't surface the right tool.

## Open Questions

None — all design questions resolved in Phase 2 dialogue.

## Adversarial Review

**Providers:** codex-5.3, gemini, cursor-agent (claude auto-excluded as host)

**CRITICAL findings (6 total, all resolved):**

1. **ListTools mutability undeclared** (codex-5.3) — Fixed: Interaction Contract now enumerates all agent-visible changes across Fixes 2, 3, 5, 6.
2. **H13 regex contradictory** (codex-5.3) — Fixed: AC#6 reconciled with Edge Cases; non-trigger examples added.
3. **Scope underestimated** (codex-5.3) — Fixed: file count corrected to 5; callback injection location specified.
4. **Removing describe_tools instruction breaks hidden tool calling** (gemini) — Investigated: plan_turn already calls `enableToolByName()` server-side (line 3818-3820), which sends `tools/list_changed` notification. Agents can call the tool immediately after plan_turn returns. The "call describe_tools" text was redundant, not functional.
5. **Lazy schemas cause extractToolParams to fail silently** (gemini) — Fixed: spec now mandates lazy schema resolution before param extraction, with graceful degradation (omit params line) on failure.
6. **Interaction Contract incomplete** (cursor-agent) — Fixed: now enumerates all agent-visible changes.

**WARNING findings (6 total):**
- AC#4 testability — Fixed: concrete test assertion specified.
- Rollback ordering — Added note: revert Fix 1 before removing shared exports from register-tools.ts.
- Success criteria normalization — Fixed: using share-of-calls instead of raw counts.
- H14 regex too broad — Fixed: bare "secret" and "token" excluded.
- AC#1 ambiguity for no-param tools — Fixed: explicit "(none required)" output specified.
- Hint co-occurrence in validation — Fixed: check substring presence, not prefix position.

**INFO:** Edge case numbering fixed (was skipping item 2 after earlier edit).
