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
}

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
  const filesWithSecrets = new Set<string>();

  const fileMatcher = filePattern ? picomatch(filePattern) : null;

  for (const file of index.files) {
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

  // Cap results
  if (allFindings.length > maxResults) {
    allFindings = allFindings.slice(0, maxResults);
  }

  // Determine scan coverage
  const repoCache = getSecretCache().get(repo);
  let scanCoverage: ScanSecretsResult["scan_coverage"] = "none";
  if (repoCache && repoCache.size > 0) {
    scanCoverage = repoCache.size >= index.files.length ? "full" : "partial";
  }

  return {
    findings: allFindings,
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
