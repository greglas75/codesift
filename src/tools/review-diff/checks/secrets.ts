import { scanSecrets } from "../../secret-tools.js";
import type { CodeIndex } from "../../../types.js";
import { literalChangedFilePattern } from "../file-pattern.js";
import type { CheckResult, ReviewFinding } from "../types.js";

/**
 * Secrets check: run scanSecrets scoped to changedFiles and map findings to T1.
 */
export async function checkSecrets(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const filePattern = literalChangedFilePattern(changedFiles);

    const result = await scanSecrets(index.repo, { file_pattern: filePattern, min_confidence: "high" });

    const findings: ReviewFinding[] = result.findings.map((f) => ({
      check: "secrets",
      severity: "error",
      message: `Secret detected: ${f.rule} (${f.severity}) — ${f.masked_secret}`,
      file: f.file,
      line: f.line,
    }));

    return {
      check: "secrets",
      status: findings.length > 0 ? "fail" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} secret(s) detected`
        : "No secrets detected",
    };
  } catch (err: unknown) {
    return {
      check: "secrets",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
