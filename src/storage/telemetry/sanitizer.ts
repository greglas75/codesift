// The ONLY place a Level-1 (anonymous) payload is constructed. Allowlist, not
// blocklist (spec §1): every field is assembled explicitly here, so adding a
// new field to the wire format is a conscious edit to this file — never an
// accidental spread of a raw entry. `assertSanitized` is a defense-in-depth
// guard that fails loudly (in tests / dev) if a forbidden key ever leaks in.
import { TELEMETRY_SCHEMA_VERSION } from "./config.js";
import type { EnvProfile } from "./env-profile.js";
import type { ToolAggregate } from "./aggregator.js";

export interface Level1Payload {
  schema_version: number;
  ts: number;
  anon_id: string;
  env: EnvProfile;
  tools: Level1ToolMetric[];
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
  now: number;
}): Level1Payload {
  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    ts: input.now,
    anon_id: input.anonId,
    env: pickEnv(input.env),
    tools: input.tools.map(pickToolMetric),
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
