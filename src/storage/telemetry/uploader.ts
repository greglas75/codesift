// Telemetry uploader (spec §3). Runs on a timer, NEVER on the tool hot path.
// Source of truth is the local usage.jsonl + a watermark (last-uploaded ts) —
// no separate spool to keep in sync. Push happens ONLY when an endpoint is
// configured (CODESIFT_TELEMETRY_URL); with no endpoint nothing leaves the
// machine, which is the safe default until the public collector is exposed
// (staged rollout: notice first, push later).
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
function retroIdentityPath(): string {
  return join(dataDir(), "telemetry-watermark-retros-identity");
}
function retroLogPath(): string {
  return join(homedir(), ".zuvo", "retros.log");
}

/** Identity plus a digest of bytes immediately before an offset; stable across later appends. */
function retroLogIdentity(offset: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(retroLogPath(), "r");
    const stat = fstatSync(fd);
    if (offset < 0 || offset > stat.size) return null;
    const start = Math.max(0, offset - 256);
    const tail = Buffer.alloc(offset - start);
    const bytes = readSync(fd, tail, 0, tail.length, start);
    if (bytes !== tail.length) return null;
    const hash = createHash("sha256").update(tail).digest("hex").slice(0, 16);
    return `${stat.dev}:${stat.ino}:${offset}:${hash}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf-8").trim(); } catch { return null; }
}

function writeText(path: string, value: string): boolean {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(tmp, value, { encoding: "utf-8", flag: "wx" });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* no temp file to clean */ }
    console.error(`[codesift] telemetry cursor identity could not be persisted: ${String(err)}`);
    return false;
  }
}

function readTs(path: string): number {
  try {
    const n = Number(readFileSync(path, "utf-8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function writeTs(path: string, ts: number): boolean {
  const current = readTs(path);
  if (current >= ts) return true;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(tmp, String(ts), { encoding: "utf-8", flag: "wx" });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* no temp file to clean */ }
    console.error(`[codesift] telemetry watermark could not be persisted: ${String(err)}`);
    return false;
  }
}
function readWatermark(): number {
  return readTs(watermarkPath());
}
function writeWatermark(ts: number): boolean {
  return writeTs(watermarkPath(), ts);
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
  let retroCursorReset = false;
  let retroSavedOffset = 0;   // hoisted: the reset notice below needs it outside the level-1 branch
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
    const savedOffset = readTs(retroWatermarkPath());
    retroSavedOffset = savedOffset;
    const savedIdentity = retroLogIdentity(savedOffset);
    if (savedIdentity !== null && readText(retroIdentityPath()) === savedIdentity) {
      retroSinceOffset = savedOffset;
    } else {
      retroCursorReset = savedOffset > 0;
      retroSinceOffset = 0;
    }
    let scanIdentity = retroLogIdentity(retroSinceOffset);
    let scan = await scanRetros(retroSinceOffset, retroLogPath(), "offset");
    if (scanIdentity !== retroLogIdentity(retroSinceOffset)) {
      // The path changed between validation and read. Retry from the beginning of the replacement
      // and refuse to upload if it rotates again during the retry.
      retroCursorReset = true;
      retroSinceOffset = 0;
      scanIdentity = retroLogIdentity(0);
      scan = await scanRetros(0, retroLogPath(), "offset");
      if (scanIdentity !== retroLogIdentity(0)) return "failed";
    }
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

  let persisted = writeWatermark(maxTs);
  // Advance the retro cursor independently, and only forward. Guarded so a flush that carried
  // no retros (or a level that does not carry them) cannot move it — moving it on an empty scan
  // would re-create the original bug in a new place.
  // A cursor reset means retros.log was REWRITTEN under us — rotated, restored, or truncated. The
  // rescan-from-0 above already handles it correctly, but until now it happened in complete
  // silence: `retroCursorReset` only chose between two write functions and was never reported.
  // On 2026-08-15 a machine's retros.log went 143486 -> 70167 bytes and lost ten days of history;
  // this code did exactly the right thing with what remained, and nobody learned that anything had
  // happened for four days. Detection without a signal is not detection.
  //
  // The two cases are not equally bad and must not read the same. Any rewrite is worth a line;
  // a file now SHORTER than the offset we had already consumed is positive evidence that local
  // history is gone, and the collector is then the only copy of what came before.
  if (retroCursorReset) {
    if (retroNextOffset < retroSavedOffset) {
      console.error(
        `[codesift] telemetry: retros.log SHRANK — ${retroSavedOffset} bytes had already been consumed, ` +
        `the file now ends at ${retroNextOffset}. Local retro history was lost; what was uploaded ` +
        `before the rewrite survives only on the collector.`,
      );
    } else {
      console.error(
        `[codesift] telemetry: retro cursor reset — retros.log was rewritten under the uploader ` +
        `(saved offset ${retroSavedOffset}); rescanned from 0 to ${retroNextOffset}.`,
      );
    }
  }
  if (retroNextOffset > retroSinceOffset) {
    const offsetPersisted = retroCursorReset
      ? writeText(retroWatermarkPath(), String(retroNextOffset))
      : writeTs(retroWatermarkPath(), retroNextOffset);
    const nextIdentity = retroLogIdentity(retroNextOffset);
    const identityPersisted = offsetPersisted && nextIdentity !== null
      ? writeText(retroIdentityPath(), nextIdentity)
      : false;
    persisted = persisted && offsetPersisted && identityPersisted;
  }
  return persisted ? "sent" : "failed";
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
