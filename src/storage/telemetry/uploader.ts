// Telemetry uploader (spec §3). Runs on a timer, NEVER on the tool hot path.
// Source of truth is the local usage.jsonl + a watermark (last-uploaded ts) —
// no separate spool to keep in sync. Push happens ONLY when an endpoint is
// configured (CODESIFT_TELEMETRY_URL); with no endpoint nothing leaves the
// machine, which is the safe default until the public collector is exposed
// (staged rollout: notice first, push later).
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveTelemetryLevel } from "./config.js";
import { readLocalUsageEntries, aggregateToolMetrics, aggregateHintFunnel, aggregatePlanTurnFunnel } from "./aggregator.js";
import { buildEnvProfile } from "./env-profile.js";
import { getAnonId } from "./anon-id.js";
import { buildLevel1Payload, assertSanitized } from "./sanitizer.js";
import { scanRetros } from "./retro-aggregator.js";

const FLUSH_TIMEOUT_MS = 2000; // hard cap per spec §3
const INITIAL_FLUSH_DELAY_MS = 10_000;
const FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

function dataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}
function watermarkPath(): string {
  return join(dataDir(), "telemetry-watermark");
}
/**
 * Retros get their OWN byte-offset cursor. They are append-only but can be written by processes
 * whose clocks disagree, so a timestamp watermark loses late records with an older or identical
 * timestamp. A byte offset follows append order and does not depend on event time.
 *
 * Absent on upgrade, so it starts at 0 and the first flush backfills the machine's retro history.
 * That is intended: those runs happened and were never reported.
 */
function retroWatermarkPath(): string {
  return join(dataDir(), "telemetry-watermark-retros-offset");
}

function readTs(path: string): number {
  try {
    const n = Number(readFileSync(path, "utf-8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function writeTs(path: string, ts: number): void {
  const current = readTs(path);
  if (current >= ts) return;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(tmp, String(ts), { encoding: "utf-8", flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* no temp file to clean */ }
    console.error(`[codesift] telemetry watermark could not be persisted: ${String(err)}`);
  }
}
function readWatermark(): number {
  return readTs(watermarkPath());
}
function writeWatermark(ts: number): void {
  writeTs(watermarkPath(), ts);
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
type FlushResult = "off" | "empty" | "sent" | "failed";
let flushInFlight: Promise<FlushResult> | null = null;

export function flushTelemetry(now: number): Promise<FlushResult> {
  if (flushInFlight) return flushInFlight;
  const run = flushTelemetryOnce(now);
  const tracked = run.finally(() => {
    if (flushInFlight === tracked) flushInFlight = null;
  });
  flushInFlight = tracked;
  return tracked;
}

async function flushTelemetryOnce(now: number): Promise<FlushResult> {
  const level = resolveTelemetryLevel();
  if (level === "off") return "off";

  const ep = endpoint();
  const since = readWatermark();
  const entries = await readLocalUsageEntries(since);
  const maxTs = entries.reduce((m, e) => (e.ts > m ? e.ts : m), since);

  let body: unknown;
  let path: string;
  let retroSinceOffset = 0;
  let retroNextOffset = 0;
  if (level === "full") {
    // Level 2 (opt-in): raw entries, batched. Full detail — query/paths included. Retros do not
    // ride this level, so no tool usage genuinely means nothing to send.
    if (entries.length === 0) return "empty";
    path = "/ingest/codesift";
    body = { schema_version: 1, level: "full", anon_id: getAnonId(), entries };
  } else {
    // Level 1 (anon): aggregate-only, allowlisted, guarded.
    // Read retros BEFORE deciding there is nothing to send. They are an independent stream: a
    // machine can run zuvo skills with no CodeSift tool calls at all (measured: CodeSift was
    // unavailable / not-indexed / transport-closed in ~40% of zuvo runs), and the old
    // `entries.length === 0 -> empty` return fired first, so those machines reported NOTHING and
    // read as "zuvo is not installed here".
    retroSinceOffset = readTs(retroWatermarkPath());
    const scan = await scanRetros(retroSinceOffset, undefined, "offset");
    retroNextOffset = scan.nextOffset;
    if (entries.length === 0 && scan.rows.length === 0) return "empty";
    path = "/ingest/codesift";
    const payload = buildLevel1Payload({
      anonId: getAnonId(),
      env: buildEnvProfile(),
      tools: aggregateToolMetrics(entries),
      hints: aggregateHintFunnel(entries),
      planTurn: aggregatePlanTurnFunnel(entries),
      // Absent when zuvo is not installed. Rides this payload rather than getting its own channel
      // because this is the channel that reaches anyone: `/ingest/zuvo` is token-gated (it carries
      // repo names and debt text) and its sender ships over SSH to a tailnet address, so it has
      // exactly one reporting install.
      retros: scan.rows,
      now,
    });
    assertSanitized(payload); // never send an unsanitized L1 payload
    body = payload;
  }

  let ok = await postGzip(ep.url + path, ep.token, body);
  if (!ok) ok = await postGzip(ep.url + path, ep.token, body); // single retry
  if (!ok) return "failed"; // leave watermark — retry next flush

  writeWatermark(maxTs);
  // Advance the retro cursor independently, and only forward. Guarded so a flush that carried
  // no retros (or a level that does not carry them) cannot move it — moving it on an empty scan
  // would re-create the original bug in a new place.
  if (retroNextOffset > retroSinceOffset) writeTs(retroWatermarkPath(), retroNextOffset);
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
