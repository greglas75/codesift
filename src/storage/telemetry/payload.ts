// Convenience assembly used by `codesift telemetry show` and (Phase 3) the
// uploader: local usage → aggregates → sanitized Level-1 payload.
import { readLocalUsageEntries, aggregateToolMetrics, aggregateHintFunnel, aggregatePlanTurnFunnel } from "./aggregator.js";
import { buildEnvProfile } from "./env-profile.js";
import { getAnonId } from "./anon-id.js";
import { buildLevel1Payload, assertSanitized, type Level1Payload } from "./sanitizer.js";
import { aggregateRetros } from "./retro-aggregator.js";

/**
 * Build the exact Level-1 payload that would be sent right now, from the local
 * usage.jsonl. Repo dimensions are omitted here (added per-context at push
 * time). Runs the sanitizer guard so `telemetry show` proves the allowlist.
 */
export async function buildCurrentLevel1Payload(now: number, sinceTs = 0): Promise<Level1Payload> {
  const entries = await readLocalUsageEntries(sinceTs);
  const tools = aggregateToolMetrics(entries);
  const hints = aggregateHintFunnel(entries);
  const planTurn = aggregatePlanTurnFunnel(entries);
  const env = buildEnvProfile();
  // Absent when zuvo is not installed; never an error.
  const retros = await aggregateRetros(sinceTs);
  const payload = buildLevel1Payload({ anonId: getAnonId(), env, tools, hints, planTurn, retros, now });
  assertSanitized(payload); // throws if the allowlist was ever violated
  return payload;
}
