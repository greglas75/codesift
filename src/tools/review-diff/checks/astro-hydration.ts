import { hydrationAuditFromIndex } from "../../astro-islands.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

/**
 * Astro hydration check: run hydrationAuditFromIndex scoped to Astro files in diff.
 * Returns skipped when diff has zero .astro files.
 */
export async function checkAstroHydration(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();

  const astroFiles = changedFiles.filter((f) => f.endsWith(".astro"));
  if (astroFiles.length === 0) {
    return {
      check: "astro-hydration",
      status: "pass",
      findings: [],
      duration_ms: Date.now() - start,
      summary: "skipped: no astro files in diff",
    };
  }

  try {
    const result = hydrationAuditFromIndex(index, "all");

    const changedAstroSet = new Set(astroFiles);
    const filteredIssues = result.issues.filter((i) => changedAstroSet.has(i.file));

    const findings: ReviewFinding[] = filteredIssues.map((i) => {
      const f: ReviewFinding = {
        check: "astro-hydration",
        severity: i.severity === "error" ? "error" : i.severity === "warning" ? "warn" : "info",
        message: `[${i.code}] ${i.message} — ${i.fix}`,
        file: i.file,
        line: i.line,
      };
      if (i.component !== undefined) f.symbol = i.component;
      return f;
    });

    return {
      check: "astro-hydration",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} Astro hydration issue(s) found (score: ${result.score})`
        : "No Astro hydration issues detected",
    };
  } catch (err: unknown) {
    return {
      check: "astro-hydration",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
