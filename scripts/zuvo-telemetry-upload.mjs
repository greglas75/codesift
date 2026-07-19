#!/usr/bin/env node
// Zuvo uploader (spec §5): ships new ~/.zuvo/runs.log rows to the shared
// collector's /ingest/zuvo namespace. Zuvo already has the meter (runs.log) —
// this is the "only an uploader" piece. runs.log is the user's own internal
// data, so the zuvo namespace is secret-gated (full detail, not anonymized).
//
// Watermark = line count already sent (~/.zuvo/.telemetry-upload-watermark).
// Env: CODESIFT_TELEMETRY_URL (default https://coding.tgmedit.com),
//      CODESIFT_TELEMETRY_TOKEN or CODESIFT_COLLECTOR_TOKEN (the secret).
// Cron (Mac, e.g. hourly): 7 * * * * node /path/to/zuvo-telemetry-upload.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { gzipSync } from "node:zlib";

const ZUVO = process.env.ZUVO_DIR ?? join(homedir(), ".zuvo");
const RUNLOG = join(ZUVO, "runs.log");
const WATERMARK = join(ZUVO, ".telemetry-upload-watermark");
const URL_BASE = (process.env.CODESIFT_TELEMETRY_URL ?? "https://coding.tgmedit.com").replace(/\/$/, "");
const TOKEN = process.env.CODESIFT_TELEMETRY_TOKEN ?? process.env.CODESIFT_COLLECTOR_TOKEN ?? "";
const TIMEOUT_MS = 4000;

// runs.log is tab-separated; columns are positional (append-runlog writer).
const COLS = ["ts", "action", "project", "gate1", "gate2", "verdict", "count", "mode", "description", "branch", "sha", "tier", "variant"];

function parseRow(line) {
  const f = line.split("\t");
  const row = {};
  COLS.forEach((c, i) => { if (f[i] !== undefined && f[i] !== "-") row[c] = f[i]; });
  return row;
}

function readWatermark() {
  try { const n = Number(readFileSync(WATERMARK, "utf-8").trim()); return Number.isFinite(n) ? n : 0; }
  catch { return 0; }
}

async function main() {
  let lines;
  try { lines = readFileSync(RUNLOG, "utf-8").split("\n").filter(Boolean); }
  catch { console.error(`no runs.log at ${RUNLOG}`); process.exit(0); }

  const wm = readWatermark();
  const fresh = lines.slice(wm);
  if (fresh.length === 0) { console.log("zuvo: nothing new"); process.exit(0); }

  const body = { schema_version: 1, source: "zuvo-runs", host: hostname(), rows: fresh.map(parseRow) };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE}/ingest/zuvo`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip", "x-api-key": TOKEN, "x-telemetry-client": "zuvo" },
      body: gzipSync(Buffer.from(JSON.stringify(body), "utf-8")),
      signal: controller.signal,
    });
    if (!res.ok) { console.error(`zuvo upload failed: ${res.status}`); process.exit(1); }
    writeFileSync(WATERMARK, String(lines.length), "utf-8"); // advance only on success
    console.log(`zuvo: sent ${fresh.length} rows (watermark → ${lines.length})`);
  } catch (e) {
    console.error(`zuvo upload error: ${e?.message ?? e}`);
    process.exit(1);
  } finally {
    clearTimeout(t);
  }
}
main();
