// The ONLY place a Level-1 (anonymous) payload is constructed. Allowlist, not
// blocklist (spec §1): every field is assembled explicitly here, so adding a
// new field to the wire format is a conscious edit to this file — never an
// accidental spread of a raw entry. `assertSanitized` is a defense-in-depth
// guard that fails loudly (in tests / dev) if a forbidden key ever leaks in.
import { TELEMETRY_SCHEMA_VERSION } from "./config.js";
import type { EnvProfile } from "./env-profile.js";
import type { ToolAggregate, HintEmission, PlanTurnFunnel } from "./aggregator.js";
import type { RetroAggregate } from "./retro-aggregator.js";

export interface Level1Payload {
  schema_version: number;
  ts: number;
  anon_id: string;
  env: EnvProfile;
  tools: Level1ToolMetric[];
  hints: Level1HintEmission[];
  plan_turn: Level1PlanTurn[];
  /** Absent when zuvo is not installed — the common case for a codesift-only user. */
  retros?: Level1Retro[];
}

/**
 * A day of zuvo retrospectives, reduced to enums and counts.
 *
 * The four identifying fields of a retro line (project, branch, commit sha, and the free-text
 * "missing template" note) are not present here and are never read by the aggregator. That is the
 * distinction the collector's own gate is built on: `/ingest/zuvo` is token-gated precisely because
 * raw retros "carry repo names and debt text", while `/ingest/codesift` is open to anonymous L1.
 * This rides the open channel because it genuinely is L1, not because it was scrubbed into looking
 * like it.
 */
export interface Level1Retro {
  day: string;
  skill: string;
  code_type: string;
  friction: string;
  context_gap: string;
  codesift: string;
  routing: string;
  count: number;
  median_turns: number;
  median_tool_calls: number;
  median_files_read: number;
  median_files_modified: number;
  blind_audit_ran: number;
  adversarial_ran: number;
  /**
   * Gate outcomes that are NOT a verdict and NOT a skip: the skill has no such
   * step at all.
   *
   * Without these the correction that produced them is unreadable at the far end.
   * `gateRan` stopped counting `N/A` as a verdict, which is right, but if only the
   * `_ran` counters ship then a population of skills that never had a blind audit
   * looks identical to one that has a blind audit and skips it — the metric falls
   * and the reason is unrecoverable. 108 of 164 recorded verdicts came from skills
   * with no such step, so this is most of the signal, not an edge case.
   *
   * It reveals strictly less than `_ran` does: that a SKILL has no gate is a
   * property of the skill, and which skill ran is already sent.
   */
  blind_audit_na: number;
  adversarial_na: number;
}

export interface Level1ToolMetric {
  tool: string;
  day: string;
  count: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  error_rate: number;
  empty_result_rate: number;
  cache_hit_rate: number;
}

export interface Level1HintEmission {
  day: string;
  hint_code: string;
  emitted: number;
  applied: number;
}

export interface Level1PlanTurn {
  day: string;
  recommended: number;
  used: number;
}

/** Explicitly pick ONLY allowlisted fields from an aggregate. */
function pickToolMetric(a: ToolAggregate): Level1ToolMetric {
  return {
    tool: a.tool,
    day: a.day,
    count: a.count,
    p50_ms: a.p50_ms,
    p95_ms: a.p95_ms,
    max_ms: a.max_ms,
    error_rate: a.error_rate,
    empty_result_rate: a.empty_result_rate,
    cache_hit_rate: a.cache_hit_rate,
  };
}

function pickHint(h: HintEmission): Level1HintEmission {
  return { day: h.day, hint_code: h.hint_code, emitted: h.emitted, applied: h.applied };
}

function pickPlanTurn(p: PlanTurnFunnel): Level1PlanTurn {
  return { day: p.day, recommended: p.recommended, used: p.used };
}

function pickRetro(r: RetroAggregate): Level1Retro {
  return {
    day: r.day,
    skill: r.skill,
    code_type: r.code_type,
    friction: r.friction,
    context_gap: r.context_gap,
    codesift: r.codesift,
    routing: r.routing,
    count: r.count,
    median_turns: r.median_turns,
    median_tool_calls: r.median_tool_calls,
    median_files_read: r.median_files_read,
    median_files_modified: r.median_files_modified,
    blind_audit_ran: r.blind_audit_ran,
    adversarial_ran: r.adversarial_ran,
    blind_audit_na: r.blind_audit_na,
    adversarial_na: r.adversarial_na,
  };
}

/** Explicitly pick ONLY allowlisted env fields (no hostname/paths). */
function pickEnv(env: EnvProfile): EnvProfile {
  const picked: EnvProfile = {
    platform: env.platform,
    arch: env.arch,
    ram_bucket: env.ram_bucket,
    cores: env.cores,
    node_ver: env.node_ver,
    codesift_ver: env.codesift_ver,
  };
  if (env.repo_size_bucket !== undefined) picked.repo_size_bucket = env.repo_size_bucket;
  if (env.top3_ext !== undefined) picked.top3_ext = env.top3_ext.slice(0, 3);
  return picked;
}

export function buildLevel1Payload(input: {
  anonId: string;
  env: EnvProfile;
  tools: ToolAggregate[];
  hints?: HintEmission[];
  planTurn?: PlanTurnFunnel[];
  retros?: RetroAggregate[];
  now: number;
}): Level1Payload {
  const retros = (input.retros ?? []).map(pickRetro);
  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    ts: input.now,
    anon_id: input.anonId,
    env: pickEnv(input.env),
    tools: input.tools.map(pickToolMetric),
    hints: (input.hints ?? []).map(pickHint),
    plan_turn: (input.planTurn ?? []).map(pickPlanTurn),
    // Omitted rather than sent empty: an absent key says "this install has no zuvo", an empty array
    // says "zuvo ran and produced nothing". Those are different facts and the reader cannot
    // distinguish them after the fact.
    ...(retros.length > 0 ? { retros } : {}),
  };
}

/**
 * Keys that must NEVER appear anywhere in an L1 payload. Extension identifiers
 * like ".ts" in top3_ext are fine (they're values, not keys); this checks KEYS.
 */
const FORBIDDEN_KEYS = new Set([
  "query", "repo", "path", "file", "files", "args", "args_summary",
  "symbol", "symbols", "hostname", "host", "username", "user", "ip",
  "source", "content", "code", "name", "session_id",
]);

/**
 * Deep-scan a payload's KEYS for anything forbidden. Throws on violation.
 * Called from tests and (dev builds) before send — cheap insurance that the
 * allowlist is actually honoured end-to-end.
 */
export function assertSanitized(payload: unknown, pathTrace = "$"): void {
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertSanitized(v, `${pathTrace}[${i}]`));
    return;
  }
  if (payload && typeof payload === "object") {
    for (const [k, v] of Object.entries(payload)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
        throw new Error(`telemetry sanitizer: forbidden key "${k}" at ${pathTrace}`);
      }
      assertSanitized(v, `${pathTrace}.${k}`);
    }
  }
}
