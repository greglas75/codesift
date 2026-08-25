/**
 * Secret scanning tool — detects hardcoded secrets in indexed files.
 *
 * Uses @sanity-labs/secret-scan for pattern matching. CodeSift adds:
 * - AST context (which function/class the secret is in)
 * - Confidence demotion for test/doc/placeholder contexts
 * - File-level caching keyed by mtime
 * - Inline allowlist via `// codesift:allow-secret`
 */

import { join } from "node:path";
import { currentAbortSignal } from "../server-helpers/request-context.js";
import picomatch from "picomatch";
import { getCodeIndex } from "./index-tools.js";
import {
  getSecretCache,
  isMissingFileError,
  scanFileForSecrets,
  severityAtLeast,
  shouldSkipFile,
} from "./secret-scan-shared.js";
export {
  SEVERITY_MAP,
  classifyContext,
  enrichWithSymbolContext,
  getSecretCache,
  getSeverity,
  isAllowlisted,
  isDocFile,
  maskSecret,
  offsetToLine,
  onFileChanged,
  onFileDeleted,
  resetSecretCache,
  scanFileForSecrets,
} from "./secret-scan-shared.js";
export type {
  SecretCacheEntry,
  SecretContext,
  SecretFinding,
  SecretSeverity,
} from "./secret-scan-shared.js";
import { isTestFile } from "../utils/test-file.js";
import type { SecretFinding, SecretSeverity } from "./secret-scan-shared.js";

export interface ScanSecretsResult {
  findings: SecretFinding[];
  files_scanned: number;
  files_with_secrets: number;
  scan_coverage: "none" | "partial" | "full";
  files_failed?: number;
  partial_failure?: boolean;
  /** Set when the cap hid findings. Absent means `findings` is everything that matched. */
  truncated?: boolean;
  /** How many matched in total, when more matched than were returned. */
  total_findings?: number;
  /** Set when the walk did not finish: the remaining files were never looked at. */
  stopped_early?: "aborted" | "budget";
  hint?: string;
}

/**
 * Wall-clock ceiling for the file walk.
 *
 * 60s sits inside the 90s client-facing tool timeout, so the scan reports a partial result itself
 * rather than being cut off by a timeout that does not actually stop it.
 */
const SCAN_BUDGET_MS = 60_000;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Scan all indexed files in a repo for secrets.
 * Returns findings filtered by options.
 */
export async function scanSecrets(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    min_confidence?: "high" | "medium" | "low" | undefined;
    exclude_tests?: boolean | undefined;
    severity?: SecretSeverity | undefined;
    max_results?: number | undefined;
  },
): Promise<ScanSecretsResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const excludeTests = options?.exclude_tests ?? true;
  const filePattern = options?.file_pattern;
  const minConfidence = options?.min_confidence ?? "medium";
  const minSeverity = options?.severity ?? "low";
  const maxResults = options?.max_results ?? 200;

  const confidenceOrder: Record<string, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  const minConfidenceLevel = confidenceOrder[minConfidence] ?? 1;

  let allFindings: SecretFinding[] = [];
  let filesScanned = 0;
  let filesFailed = 0;
  // The scan walked every indexed file with no ceiling and no abort check. Measured on this repo:
  // 27.9 seconds and 10,533 findings, of which 200 were kept — telemetry puts the p90 at 23.4s.
  //
  // The tool-level timeout above it is not a stop: it answers `timed_out` and lets the loop run on,
  // which is how this tool reached 5.1 HOURS against a 90-second budget (see
  // RequestContext.abortSignal). For a secret scanner that is worse than slow — the abandoned scan
  // competes for the same disk as the narrower retry the agent issues after giving up.
  const abortSignal = currentAbortSignal();
  const scanDeadline = Date.now() + SCAN_BUDGET_MS;
  let stoppedEarly: "aborted" | "budget" | null = null;
  const filesWithSecrets = new Set<string>();

  const fileMatcher = filePattern ? picomatch(filePattern) : null;

  for (const file of index.files) {
    if (abortSignal?.aborted) { stoppedEarly = "aborted"; break; }
    if (Date.now() > scanDeadline) { stoppedEarly = "budget"; break; }

    // Skip if file pattern doesn't match
    if (fileMatcher && !fileMatcher(file.path)) continue;

    // Skip test files if requested
    if (excludeTests && isTestFile(file.path)) continue;

    // Skip files we know to skip
    if (shouldSkipFile(file.path)) continue;

    const absPath = join(index.root, file.path);
    try {
      const findings = await scanFileForSecrets(
        absPath,
        file.path,
        repo,
        index.symbols,
      );
      filesScanned++;

      // Filter by confidence and severity
      const filtered = findings.filter(
        (f) =>
          (confidenceOrder[f.confidence] ?? 1) >= minConfidenceLevel
          && severityAtLeast(f.severity, minSeverity),
      );

      if (filtered.length > 0) {
        filesWithSecrets.add(file.path);
        allFindings.push(...filtered);
      }
    } catch (err: unknown) {
      if (isMissingFileError(err)) {
        continue;
      }
      filesFailed++;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[codesift] Secret scan failed for ${file.path}: ${message}`);
    }
  }

  // Cap results — and SAY SO. Truncating in silence made "findings: 200" read as "there are 200",
  // which for a security tool is the one misreading that matters: a repo with 500 leaked keys
  // reported the same number as a repo with exactly 200, and nothing in the response distinguished
  // them. The default cap is 200, so any repo at or above it looked identical.
  const totalFindings = allFindings.length;
  const truncated = totalFindings > maxResults;
  if (truncated) {
    allFindings = allFindings.slice(0, maxResults);
  }

  // Determine scan coverage
  const repoCache = getSecretCache().get(repo);
  let scanCoverage: ScanSecretsResult["scan_coverage"] = "none";
  if (repoCache && repoCache.size > 0) {
    scanCoverage = repoCache.size >= index.files.length ? "full" : "partial";
  }
  // A scan that stopped early is NOT full, whatever the cache says. "No secrets found" from a scan
  // that never reached the rest of the repo is a false all-clear, which is the one wrong answer a
  // secret scanner must never give.
  if (stoppedEarly) scanCoverage = filesScanned > 0 ? "partial" : "none";

  return {
    findings: allFindings,
    ...(truncated
      ? {
          truncated: true,
          total_findings: totalFindings,
          hint:
            `Showing ${maxResults} of ${totalFindings} findings. Raise max_results, or narrow the `
            + "scan with file_pattern / severity / min_confidence — the rest are NOT clean.",
        }
      : {}),
    ...(stoppedEarly
      ? {
          stopped_early: stoppedEarly,
          hint:
            stoppedEarly === "aborted"
              ? `Scan ABORTED after ${filesScanned} of ${index.files.length} files (client timed out). `
                + "The unscanned files are NOT known to be clean — narrow with file_pattern and re-run."
              : `Scan stopped at the ${SCAN_BUDGET_MS}ms budget after ${filesScanned} of ${index.files.length} files. `
                + "The unscanned files are NOT known to be clean — narrow with file_pattern, or raise scan_budget_ms.",
        }
      : {}),
    files_scanned: filesScanned,
    files_with_secrets: filesWithSecrets.size,
    scan_coverage: scanCoverage,
    ...(filesFailed > 0
      ? {
          files_failed: filesFailed,
          partial_failure: true,
        }
      : {}),
  };
}
