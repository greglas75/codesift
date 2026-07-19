// Local telemetry spool: entries are appended here cheaply on the hot path;
// a separate timer (Phase 3 uploader) drains it. Hard size cap so a machine
// that's offline for weeks never grows an unbounded file (spec §3).
import { appendFileSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Hard cap — when exceeded, the oldest half is dropped on next append. */
export const SPOOL_MAX_BYTES = 1024 * 1024; // 1 MB

function dataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}

export function getSpoolPath(): string {
  return join(dataDir(), "telemetry-spool.jsonl");
}

/** Append one JSON record. Best-effort, never throws (telemetry is optional). */
export function appendToSpool(record: unknown): void {
  try {
    const path = getSpoolPath();
    mkdirSync(dataDir(), { recursive: true });

    // Rotate BEFORE appending if we're already over cap — keep the newest half.
    try {
      if (statSync(path).size > SPOOL_MAX_BYTES) rotateSpool(path);
    } catch {
      /* file absent → nothing to rotate */
    }

    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    /* fail-silent — telemetry must never break a tool call */
  }
}

/** Drop the oldest half of the spool (line-aligned), keeping recent records. */
function rotateSpool(path: string): void {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    const tmp = path + ".tmp";
    writeFileSync(tmp, keep.join("\n") + (keep.length ? "\n" : ""), "utf-8");
    renameSync(tmp, path);
  } catch {
    /* if rotation fails, leave the file — next append still capped-checked */
  }
}

/** Read all spooled records (best-effort, skips malformed lines). */
export function readSpool(): unknown[] {
  try {
    const raw = readFileSync(getSpoolPath(), "utf-8");
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Empty the spool after a successful flush. Best-effort. */
export function clearSpool(): void {
  try {
    writeFileSync(getSpoolPath(), "", "utf-8");
  } catch {
    /* ignore */
  }
}
