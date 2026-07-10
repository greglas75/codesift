import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CHECK_TIMEOUT_MS,
  MAX_BUFFER,
  parseDependencyMajor,
  TOP_N,
  type FreshnessAggregate,
  type OutdatedPackage,
  type PackageManager,
} from "./dependency-audit-types.js";

const execFileAsync = promisify(execFile);

function parseOutdated(stdout: string): FreshnessAggregate {
  const aggregate: FreshnessAggregate = { outdated_count: 0, major_gaps: [] };
  if (!stdout.trim()) return aggregate;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("invalid outdated JSON");
  }
  if (!parsed || typeof parsed !== "object") return aggregate;

  const entries: OutdatedPackage[] = [];
  for (const [packageName, data] of Object.entries(parsed as Record<string, unknown>)) {
    if (!data || typeof data !== "object") continue;
    const entry = data as { current?: unknown; latest?: unknown };
    const current = typeof entry.current === "string" ? entry.current : "";
    const latest = typeof entry.latest === "string" ? entry.latest : "";
    if (!current || !latest) continue;
    const currentMajor = parseDependencyMajor(current);
    const latestMajor = parseDependencyMajor(latest);
    const majorGap = currentMajor !== null && latestMajor !== null
      ? Math.max(0, latestMajor - currentMajor)
      : 0;
    entries.push({ package: packageName, current, latest, major_gap: majorGap });
  }

  aggregate.outdated_count = entries.length;
  entries.sort((left, right) =>
    right.major_gap - left.major_gap || left.package.localeCompare(right.package));
  aggregate.major_gaps = entries.slice(0, TOP_N);
  return aggregate;
}

export async function checkDependencyFreshness(
  packageManager: PackageManager,
  workspace: string,
): Promise<FreshnessAggregate> {
  if (packageManager === "unknown") {
    throw new Error("cannot run outdated: unknown package manager");
  }
  try {
    const { stdout } = await execFileAsync(packageManager, ["outdated", "--json"], {
      cwd: workspace,
      maxBuffer: MAX_BUFFER,
      timeout: CHECK_TIMEOUT_MS,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    return parseOutdated(stdout);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim().length > 0) {
        return parseOutdated(stdout);
      }
    }
    throw error;
  }
}
