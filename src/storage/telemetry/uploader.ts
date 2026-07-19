// Telemetry uploader (spec §3). Runs on a timer, NEVER on the tool hot path.
// Source of truth is the local usage.jsonl + a watermark (last-uploaded ts) —
// no separate spool to keep in sync. Push happens ONLY when an endpoint is
// configured (CODESIFT_TELEMETRY_URL); with no endpoint nothing leaves the
// machine, which is the safe default until the public collector is exposed
// (staged rollout: notice first, push later).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveTelemetryLevel } from "./config.js";
import { readLocalUsageEntries, aggregateToolMetrics, aggregateHintFunnel, aggregatePlanTurnFunnel } from "./aggregator.js";
import { buildEnvProfile } from "./env-profile.js";
import { getAnonId } from "./anon-id.js";
import { buildLevel1Payload, assertSanitized } from "./sanitizer.js";

const FLUSH_TIMEOUT_MS = 2000; // hard cap per spec §3
const INITIAL_FLUSH_DELAY_MS = 10_000;
const FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

function dataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}
function watermarkPath(): string {
  return join(dataDir(), "telemetry-watermark");
}

function readWatermark(): number {
  try {
    const n = Number(readFileSync(watermarkPath(), "utf-8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function writeWatermark(ts: number): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(watermarkPath(), String(ts), "utf-8");
  } catch {
    /* ignore */
  }
}

/** Baked default collector — anonymous ingest needs NO token (the endpoint is
 *  open + validated + rate-limited). Full/fleet sets CODESIFT_TELEMETRY_TOKEN.
 *  Both are env-overridable. */
const DEFAULT_TELEMETRY_URL = "https://coding.tgmedit.com";

function endpoint(): { url: string; token: string } {
  const url = (process.env["CODESIFT_TELEMETRY_URL"] ?? DEFAULT_TELEMETRY_URL).replace(/\/$/, "");
  const token = process.env["CODESIFT_TELEMETRY_TOKEN"] ?? "";
  return { url, token };
}

async function postGzip(url: string, token: string, body: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const gz = gzipSync(Buffer.from(JSON.stringify(body), "utf-8"));
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-api-key": token,
        "x-telemetry-client": "codesift-mcp",
      },
      body: gz,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false; // timeout / network / abort — fail-silent
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One flush cycle. Reads usage since the watermark, builds the level-appropriate
 * payload, POSTs once (with a single retry), and advances the watermark ONLY on
 * success. Best-effort; never throws.
 */
export async function flushTelemetry(now: number): Promise<"off" | "empty" | "sent" | "failed"> {
  const level = resolveTelemetryLevel();
  if (level === "off") return "off";

  const ep = endpoint();
  const since = readWatermark();
  const entries = await readLocalUsageEntries(since);
  if (entries.length === 0) return "empty";
  const maxTs = entries.reduce((m, e) => (e.ts > m ? e.ts : m), since);

  let body: unknown;
  let path: string;
  if (level === "full") {
    // Level 2 (opt-in): raw entries, batched. Full detail — query/paths included.
    path = "/ingest/codesift";
    body = { schema_version: 1, level: "full", anon_id: getAnonId(), entries };
  } else {
    // Level 1 (anon): aggregate-only, allowlisted, guarded.
    path = "/ingest/codesift";
    const payload = buildLevel1Payload({
      anonId: getAnonId(),
      env: buildEnvProfile(),
      tools: aggregateToolMetrics(entries),
      hints: aggregateHintFunnel(entries),
      planTurn: aggregatePlanTurnFunnel(entries),
      now,
    });
    assertSanitized(payload); // never send an unsanitized L1 payload
    body = payload;
  }

  let ok = await postGzip(ep.url + path, ep.token, body);
  if (!ok) ok = await postGzip(ep.url + path, ep.token, body); // single retry
  if (!ok) return "failed"; // leave watermark — retry next flush

  writeWatermark(maxTs);
  return "sent";
}

let timer: NodeJS.Timeout | null = null;

/** Start the background flush timer. Called once at server startup. No-op when
 *  telemetry is off or no endpoint is configured. */
export function startTelemetryTimer(): void {
  if (timer) return;
  if (resolveTelemetryLevel() === "off") return;
  const tick = () => { void flushTelemetry(Date.now()); };
  setTimeout(tick, INITIAL_FLUSH_DELAY_MS).unref();
  timer = setInterval(tick, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

export function stopTelemetryTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
