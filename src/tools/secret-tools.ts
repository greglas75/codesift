/**
 * Secret scanning tool — detects hardcoded secrets in indexed files.
 *
 * Uses @sanity-labs/secret-scan for pattern matching. CodeSift adds:
 * - AST context (which function/class the secret is in)
 * - Confidence demotion for test/doc/placeholder contexts
 * - File-level caching keyed by mtime
 * - Inline allowlist via `// codesift:allow-secret`
 */

import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { scan } from "@sanity-labs/secret-scan";
import picomatch from "picomatch";
import { getCodeIndex } from "./index-tools.js";
import { isTestFile } from "../utils/test-file.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecretSeverity = "critical" | "high" | "medium" | "low";

export interface SecretContext {
  type: "test" | "doc" | "config" | "production";
  symbol_name?: string;
  symbol_kind?: string;
}

export interface SecretFinding {
  rule: string;
  label: string;
  masked_secret: string;
  confidence: "high" | "medium" | "low";
  severity: SecretSeverity;
  file: string;
  line: number;
  context: SecretContext;
}

export interface SecretCacheEntry {
  mtime_ms: number;
  findings: SecretFinding[];
}

export interface ScanSecretsResult {
  findings: SecretFinding[];
  files_scanned: number;
  files_with_secrets: number;
  scan_coverage: "none" | "partial" | "full";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 500 * 1024; // 500KB

const SKIP_PATTERNS = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.min.js",
  "*.min.css",
];

const SKIP_DIR_PATTERNS = ["audits/artifacts/"];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

const PLACEHOLDER_NAMES = new Set([
  "placeholder",
  "example",
  "sample",
  "dummy",
  "test",
  "mock",
  "fake",
  "stub",
  "default",
  "template",
]);

/**
 * Maps rule IDs to severity. Library confidence is BASE.
 * CodeSift only DEMOTES (test/doc/placeholder → low). Never promotes.
 */
export const SEVERITY_MAP: Record<string, SecretSeverity> = {
  // Critical — cloud provider keys
  aws: "critical",
  "aws-secret": "critical",
  gcp: "critical",
  "gcp-api-key": "critical",
  azure: "critical",

  // High — API keys for paid services
  openai: "high",
  anthropic: "high",
  stripe: "high",
  "stripe-secret": "high",
  twilio: "high",
  sendgrid: "high",
  github: "high",
  "github-pat": "high",
  gitlab: "high",
  slack: "high",
  "slack-token": "high",

  // Medium — generic/entropy-based
  "generic-api-key": "medium",
  "private-key": "medium",
  "database-connection-string": "medium",
  jwt: "medium",
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Cache: repo → filePath → { mtime_ms, findings } */
const secretCache = new Map<string, Map<string, SecretCacheEntry>>();

export function getSecretCache(): Map<string, Map<string, SecretCacheEntry>> {
  return secretCache;
}

export function resetSecretCache(): void {
  secretCache.clear();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Mask a secret for safe display.
 * <8 chars → "****"
 * >=8 chars → first4 + "***" + last4
 */
export function maskSecret(secret: string): string {
  if (secret.length < 8) return "****";
  return secret.slice(0, 4) + "***" + secret.slice(-4);
}

/** Check if file is a documentation file by extension. */
export function isDocFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return DOC_EXTENSIONS.has(ext);
}

/**
 * Classify the context of a file for confidence adjustment.
 * - test files → "test"
 * - doc files → "doc"
 * - .env, .yaml, .yml, .json config → "config"
 * - everything else → "production"
 */
export function classifyContext(filePath: string): SecretContext["type"] {
  if (isTestFile(filePath)) return "test";
  if (isDocFile(filePath)) return "doc";

  const base = basename(filePath);
  if (
    base.endsWith(".env") ||
    base.startsWith(".env") ||
    base.endsWith(".yaml") ||
    base.endsWith(".yml") ||
    base.endsWith(".toml") ||
    base.endsWith(".ini") ||
    base.endsWith(".cfg") ||
    (base.endsWith(".json") && !base.endsWith("package.json"))
  ) {
    return "config";
  }
  return "production";
}

/**
 * Get severity for a rule ID from the severity map.
 * Unknown rules default to "medium".
 */
export function getSeverity(rule: string): SecretSeverity {
  return SEVERITY_MAP[rule] ?? "medium";
}

/**
 * Check if a finding is allowlisted via inline comment.
 * Looks for `// codesift:allow-secret` on the same line or the line above.
 */
export function isAllowlisted(
  lines: string[],
  lineNumber: number,
): boolean {
  const marker = "codesift:allow-secret";
  // lineNumber is 1-based
  const lineIdx = lineNumber - 1;
  if (lineIdx >= 0 && lineIdx < lines.length) {
    if (lines[lineIdx]!.includes(marker)) return true;
  }
  // Check line above
  const aboveIdx = lineIdx - 1;
  if (aboveIdx >= 0 && aboveIdx < lines.length) {
    if (lines[aboveIdx]!.includes(marker)) return true;
  }
  return false;
}

/**
 * Convert a byte offset in a string to a 1-based line number.
 */
export function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Check if a file should be skipped (lock files, minified, etc.).
 */
function shouldSkipFile(filePath: string): boolean {
  const base = basename(filePath);

  // Skip lock files and minified assets
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.includes("*")) {
      if (picomatch.isMatch(base, pattern)) return true;
    } else {
      if (base === pattern) return true;
    }
  }

  // Skip audit artifacts directory
  for (const dir of SKIP_DIR_PATTERNS) {
    if (filePath.includes(dir)) return true;
  }

  return false;
}

/**
 * Check if file content looks binary (null byte in first 512 bytes).
 */
function isBinaryContent(buffer: Buffer): boolean {
  const check = Math.min(buffer.length, 512);
  for (let i = 0; i < check; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Enrich a finding with symbol context from the AST index.
 * - Finds the symbol that overlaps the finding's line
 * - Adds symbol_name and kind
 * - Demotes confidence if symbol name looks like a placeholder
 */
export function enrichWithSymbolContext(
  finding: SecretFinding,
  symbols: CodeSymbol[],
): SecretFinding {
  // Find the symbol that contains this line
  const matchingSymbol = symbols.find(
    (s) =>
      s.file === finding.file &&
      finding.line >= s.start_line &&
      finding.line <= s.end_line,
  );

  if (!matchingSymbol) return finding;

  const enriched = { ...finding };
  enriched.context = {
    ...finding.context,
    symbol_name: matchingSymbol.name,
    symbol_kind: matchingSymbol.kind,
  };

  // Demote if symbol name looks like a placeholder
  const lowerName = matchingSymbol.name.toLowerCase();
  for (const placeholder of PLACEHOLDER_NAMES) {
    if (lowerName.includes(placeholder)) {
      enriched.confidence = "low";
      break;
    }
  }

  return enriched;
}

/**
 * Scan a single file for secrets.
 * Reads raw file, calls scan(), maps offsets to lines, checks allowlist,
 * enriches with AST context, masks, and caches.
 */
export async function scanFileForSecrets(
  filePath: string,
  relPath: string,
  repo: string,
  symbols: CodeSymbol[],
): Promise<SecretFinding[]> {
  // Check cache
  const repoCache = secretCache.get(repo) ?? new Map<string, SecretCacheEntry>();
  if (!secretCache.has(repo)) secretCache.set(repo, repoCache);

  const fileStat = await stat(filePath);
  const cached = repoCache.get(relPath);
  if (cached && cached.mtime_ms === fileStat.mtimeMs) {
    return cached.findings;
  }

  // Skip check
  if (shouldSkipFile(relPath)) {
    repoCache.set(relPath, { mtime_ms: fileStat.mtimeMs, findings: [] });
    return [];
  }

  // Read file
  const buffer = await readFile(filePath);

  // Skip binary files
  if (isBinaryContent(buffer)) {
    repoCache.set(relPath, { mtime_ms: fileStat.mtimeMs, findings: [] });
    return [];
  }

  // Skip oversized files
  if (buffer.length > MAX_FILE_SIZE) {
    repoCache.set(relPath, { mtime_ms: fileStat.mtimeMs, findings: [] });
    return [];
  }

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");
  const contextType = classifyContext(relPath);

  // Run secret-scan
  const secrets = scan(content);

  const findings: SecretFinding[] = [];

  for (const secret of secrets) {
    const line = offsetToLine(content, secret.start);

    // Check inline allowlist
    if (isAllowlisted(lines, line)) continue;

    let confidence: "high" | "medium" | "low" = secret.confidence;

    // Demote confidence for test/doc files
    if (contextType === "test" || contextType === "doc") {
      confidence = "low";
    }

    const finding: SecretFinding = {
      rule: secret.rule,
      label: secret.label,
      masked_secret: maskSecret(secret.text),
      confidence,
      severity: getSeverity(secret.rule),
      file: relPath,
      line,
      context: { type: contextType },
    };

    // Enrich with symbol context
    const enriched = enrichWithSymbolContext(finding, symbols);
    findings.push(enriched);
  }

  // Cache results
  repoCache.set(relPath, { mtime_ms: fileStat.mtimeMs, findings });

  return findings;
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
    max_results?: number | undefined;
  },
): Promise<ScanSecretsResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const excludeTests = options?.exclude_tests ?? false;
  const filePattern = options?.file_pattern;
  const minConfidence = options?.min_confidence ?? "low";
  const maxResults = options?.max_results ?? 200;

  const confidenceOrder: Record<string, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  const minConfidenceLevel = confidenceOrder[minConfidence] ?? 1;

  let allFindings: SecretFinding[] = [];
  let filesScanned = 0;
  const filesWithSecrets = new Set<string>();

  const fileMatcher = filePattern ? picomatch(filePattern) : null;

  for (const file of index.files) {
    // Skip if file pattern doesn't match
    if (fileMatcher && !fileMatcher(file.path)) continue;

    // Skip test files if requested
    if (excludeTests && isTestFile(file.path)) continue;

    // Skip files we know to skip
    if (shouldSkipFile(file.path)) continue;

    filesScanned++;

    const absPath = join(index.root, file.path);
    try {
      const findings = await scanFileForSecrets(
        absPath,
        file.path,
        repo,
        index.symbols,
      );

      // Filter by confidence
      const filtered = findings.filter(
        (f) => (confidenceOrder[f.confidence] ?? 1) >= minConfidenceLevel,
      );

      if (filtered.length > 0) {
        filesWithSecrets.add(file.path);
        allFindings.push(...filtered);
      }
    } catch {
      // File may have been deleted since indexing — skip
      continue;
    }
  }

  // Cap results
  if (allFindings.length > maxResults) {
    allFindings = allFindings.slice(0, maxResults);
  }

  // Determine scan coverage
  const repoCache = secretCache.get(repo);
  let scanCoverage: ScanSecretsResult["scan_coverage"] = "none";
  if (repoCache && repoCache.size > 0) {
    scanCoverage = repoCache.size >= index.files.length ? "full" : "partial";
  }

  return {
    findings: allFindings,
    files_scanned: filesScanned,
    files_with_secrets: filesWithSecrets.size,
    scan_coverage: scanCoverage,
  };
}

// ---------------------------------------------------------------------------
// Watcher hooks
// ---------------------------------------------------------------------------

/** Invalidate cache for a changed file. */
export function onFileChanged(repo: string, filePath: string): void {
  const repoCache = secretCache.get(repo);
  if (repoCache) {
    repoCache.delete(filePath);
  }
}

/** Remove cache entry for a deleted file. */
export function onFileDeleted(repo: string, filePath: string): void {
  const repoCache = secretCache.get(repo);
  if (repoCache) {
    repoCache.delete(filePath);
  }
}
