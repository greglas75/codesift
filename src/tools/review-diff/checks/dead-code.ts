import { findDeadCode } from "../../symbol-tools.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

/**
 * Dead-code check: run findDeadCode scoped to changedFiles and map candidates to T2 findings.
 */
export async function checkDeadCode(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const filePattern =
      changedFiles.length === 1
        ? changedFiles[0]!
        : `{${changedFiles.join(",")}}`;

    const result = await findDeadCode(index.repo, { file_pattern: filePattern });

    const findings: ReviewFinding[] = result.candidates.map((c) => ({
      check: "dead-code",
      severity: "warn",
      message: `"${c.name}" appears unused — ${c.reason}`,
      file: c.file,
      line: c.start_line,
      symbol: c.name,
    }));

    return {
      check: "dead-code",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} dead-code candidate(s) found`
        : "No dead code detected",
    };
  } catch (err: unknown) {
    return {
      check: "dead-code",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
