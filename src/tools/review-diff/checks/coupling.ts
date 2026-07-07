import { computeCoChangePairs } from "../../coupling-tools.js";
import type { CheckResult, ReviewFinding } from "../types.js";

const MIN_JACCARD = 0.5;
type CoChangePair = ReturnType<typeof computeCoChangePairs>["pairs"][number];

/**
 * Coupling gaps check: uses shared computeCoChangePairs from coupling-tools.ts,
 * then flags coupled files that are missing from the diff.
 */
export async function checkCouplingGaps(
  repoRoot: string,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();

  try {
    const { pairs } = computeCoChangePairs(repoRoot, {
      since_days: 180,
      min_support: 3,
    });

    const changedSet = new Set(changedFiles);
    const findings = pairs.flatMap((pair) =>
      couplingGapFinding(pair, changedSet) ?? [],
    );

    return {
      check: "coupling",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} coupling gap(s) detected`
        : "No coupling gaps detected",
    };
  } catch (err: unknown) {
    return {
      check: "coupling",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function couplingGapFinding(
  pair: CoChangePair,
  changedSet: Set<string>,
): ReviewFinding | null {
  if (pair.jaccard < MIN_JACCARD) return null;

  const aInDiff = changedSet.has(pair.file_a);
  const bInDiff = changedSet.has(pair.file_b);
  if (aInDiff === bInDiff) return null;

  const present = aInDiff ? pair.file_a : pair.file_b;
  const missing = aInDiff ? pair.file_b : pair.file_a;

  return {
    check: "coupling",
    severity: "warn",
    message: `"${present}" is frequently co-changed with "${missing}" (Jaccard ${pair.jaccard.toFixed(2)}, ${pair.co_commits} co-commits) but "${missing}" is not in this diff`,
    file: present,
  };
}
