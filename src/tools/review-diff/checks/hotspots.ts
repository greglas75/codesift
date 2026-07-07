import { analyzeHotspots } from "../../hotspot-tools.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

/**
 * Hotspots check: run analyzeHotspots and filter to files in changedFiles.
 * Maps high-churn files to T3 advisory findings.
 */
export async function checkHotspots(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const changedSet = new Set(changedFiles);
    const result = await analyzeHotspots(index.repo);

    const findings: ReviewFinding[] = result.hotspots
      .filter((h) => changedSet.has(h.file))
      .map((h) => ({
        check: "hotspots",
        severity: "warn" as const,
        message: `High churn file: ${h.file} — hotspot_score ${h.hotspot_score} (${h.commits} commits, ${h.lines_changed} lines changed)`,
        file: h.file,
      }));

    return {
      check: "hotspots",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} hotspot file(s) in diff`
        : "No hotspot files in diff",
    };
  } catch (err: unknown) {
    return {
      check: "hotspots",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
