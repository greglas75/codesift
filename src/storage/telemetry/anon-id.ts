// Stable random anonymous ID — generated once on first use, persisted, and
// NEVER derived from hardware / hostname / username (spec §1). Lets the
// collector count unique installs without identifying anyone.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

function dataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}

export function getAnonIdPath(): string {
  return join(dataDir(), "telemetry-id");
}

let cached: string | null = null;

/**
 * Return the persistent anon id, creating it on first call. Purely random
 * (UUID v4). Best-effort: if the file can't be written (read-only FS), a
 * fresh random id is returned for this process so telemetry still works —
 * it just won't be stable across restarts on that box.
 */
export function getAnonId(): string {
  if (cached) return cached;

  const path = getAnonIdPath();
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    /* not created yet */
  }

  const id = randomUUID();
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, id + "\n", { encoding: "utf-8", flag: "wx" });
    cached = id;
    return id;
  } catch {
    // Lost a race (another process created it) or FS is read-only.
    try {
      const raced = readFileSync(path, "utf-8").trim();
      if (raced) {
        cached = raced;
        return raced;
      }
    } catch {
      /* still unwritable — fall through to ephemeral */
    }
    cached = id;
    return id;
  }
}

/** Test-only: drop the in-process cache. */
export function _resetAnonIdCacheForTests(): void {
  cached = null;
}
