import { impactAnalysis } from "../../impact-tools.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

/**
 * Blast-radius check: run impactAnalysis and map affected_symbols to T2 findings.
 */
export async function checkBlastRadius(
  index: CodeIndex,
  since: string,
  until: string,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await impactAnalysis(index.repo, since, { until });
    const MAX_BLAST_FINDINGS = 10;
    const allFindings: ReviewFinding[] = result.affected_symbols.map((sym) => ({
      check: "blast-radius",
      severity: "warn",
      message: `Symbol "${sym.name}" in ${sym.file} is affected by changes`,
      file: sym.file,
      symbol: sym.name,
    }));

    const findings = allFindings.slice(0, MAX_BLAST_FINDINGS);
    const totalCount = allFindings.length;
    return {
      check: "blast-radius",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: totalCount > 0
        ? `${totalCount} affected symbol(s) found${totalCount > MAX_BLAST_FINDINGS ? ` (showing ${MAX_BLAST_FINDINGS})` : ""}`
        : "No blast radius detected",
    };
  } catch (err: unknown) {
    return {
      check: "blast-radius",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
