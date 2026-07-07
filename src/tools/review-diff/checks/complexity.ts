import { analyzeComplexity } from "../../complexity-tools.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

/**
 * Complexity delta check: run analyzeComplexity and filter to functions in
 * changedFiles with cyclomatic complexity > 10. Maps to T2 findings.
 */
export async function checkComplexityDelta(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const changedSet = new Set(changedFiles);
    const result = await analyzeComplexity(index.repo, { top_n: 50 });

    const findings: ReviewFinding[] = result.functions
      .filter((fn) => changedSet.has(fn.file) && fn.cyclomatic_complexity > 10)
      .map((fn) => ({
        check: "complexity",
        severity: "warn" as const,
        message: `High complexity: "${fn.name}" in ${fn.file} — cyclomatic complexity ${fn.cyclomatic_complexity} (>${10})`,
        file: fn.file,
        line: fn.start_line,
        symbol: fn.name,
      }));

    return {
      check: "complexity",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} high-complexity function(s) in diff`
        : "No high-complexity functions in diff",
    };
  } catch (err: unknown) {
    return {
      check: "complexity",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
