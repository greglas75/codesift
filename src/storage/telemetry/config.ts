// Telemetry level resolution + opt-out. No network here — this module only
// decides WHETHER and at what level telemetry runs. See spec
// docs/specs/2026-07-19-telemetry-spec.md §4.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type TelemetryLevel = "off" | "anon" | "full";

/** Bump when the L1 payload shape changes. Collector tolerates unknown versions. */
export const TELEMETRY_SCHEMA_VERSION = 1;

function dataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}

export function getConfigPath(): string {
  return join(dataDir(), "config.json");
}

interface StoredConfig {
  telemetry?: string | { level?: string };
}

/** Best-effort read of ~/.codesift/config.json — never throws. */
export function readStoredConfig(): StoredConfig {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as StoredConfig;
  } catch {
    /* absent or malformed → defaults */
  }
  return {};
}

function normalizeLevel(v: unknown): TelemetryLevel | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "off" || s === "0" || s === "false" || s === "no") return "off";
  if (s === "full") return "full";
  if (s === "anon" || s === "on" || s === "1" || s === "true" || s === "anonymous") return "anon";
  return null;
}

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no";
}

/**
 * Resolve the effective telemetry level. Precedence (first match wins):
 *   1. DO_NOT_TRACK truthy            → off   (respect the cross-tool standard)
 *   2. CODESIFT_TELEMETRY env         → off | anon | full
 *   3. config.json `telemetry`        → off | anon | full   (level string or {level})
 *   4. default                        → anon  (opt-out model — spec decision)
 */
export function resolveTelemetryLevel(): TelemetryLevel {
  if (isTruthyEnv(process.env["DO_NOT_TRACK"])) return "off";

  const fromEnv = normalizeLevel(process.env["CODESIFT_TELEMETRY"]);
  if (fromEnv) return fromEnv;

  const stored = readStoredConfig().telemetry;
  const fromStore = normalizeLevel(
    typeof stored === "object" && stored !== null ? stored.level : stored,
  );
  if (fromStore) return fromStore;

  return "anon";
}

/**
 * Persist the telemetry level into ~/.codesift/config.json (merging with any
 * existing config). Atomic tmp+rename. Used by `codesift telemetry on|off|full`.
 */
export function writeStoredTelemetryLevel(level: TelemetryLevel): void {
  const path = getConfigPath();
  let cfg: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
  } catch {
    /* absent/malformed → start fresh */
  }
  cfg["telemetry"] = { level };
  mkdirSync(dataDir(), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function noticePath(): string {
  return join(dataDir(), "telemetry-notice-shown");
}

/**
 * Print the one-time consent notice to STDERR (spec §4). Shown once per machine
 * when telemetry is anon, then a marker file suppresses it. STDERR so it never
 * corrupts the MCP stdio protocol. Best-effort — never throws.
 */
export function maybePrintFirstRunNotice(): void {
  try {
    if (resolveTelemetryLevel() !== "anon") return;
    const marker = noticePath();
    try {
      readFileSync(marker, "utf-8");
      return; // already shown
    } catch {
      /* not shown yet */
    }
    process.stderr.write(
      "[codesift] Anonymous usage stats are ON (tool names, latencies, error/empty rates,\n" +
      "  bucketed env — NO queries, paths, repo names or code). See exactly what is sent:\n" +
      "  `codesift telemetry show`.  Opt out: CODESIFT_TELEMETRY=off (or DO_NOT_TRACK=1).\n",
    );
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(marker, String(Date.now()) + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

/** Human-readable reason for the current level — powers `codesift telemetry show`. */
export function telemetrySource(): { level: TelemetryLevel; reason: string } {
  if (isTruthyEnv(process.env["DO_NOT_TRACK"])) {
    return { level: "off", reason: "DO_NOT_TRACK env is set" };
  }
  const fromEnv = normalizeLevel(process.env["CODESIFT_TELEMETRY"]);
  if (fromEnv) return { level: fromEnv, reason: `CODESIFT_TELEMETRY=${process.env["CODESIFT_TELEMETRY"]}` };

  const stored = readStoredConfig().telemetry;
  const fromStore = normalizeLevel(
    typeof stored === "object" && stored !== null ? stored.level : stored,
  );
  if (fromStore) return { level: fromStore, reason: `config.json telemetry=${fromStore}` };

  return { level: "anon", reason: "default (anonymous, opt-out)" };
}
