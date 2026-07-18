import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import picomatch from "picomatch";
import type { CodeSymbol } from "../types.js";
import { collectSecretFindings } from "./secret-detectors.js";
import { getSecretCache } from "./secret-scan-cache.js";
import type { SecretCacheEntry, SecretFinding, SecretSeverity } from "./secret-scan-types.js";

const MAX_FILE_SIZE = 500 * 1024;
const SKIP_PATTERNS = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "*.min.js", "*.min.css"];
const SKIP_DIR_PATTERNS = ["audits/artifacts/"];

export function severityAtLeast(severity: SecretSeverity, minimum: SecretSeverity): boolean {
  const order: Record<SecretSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  return order[severity] >= order[minimum];
}

export function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err
    && (err as { code?: unknown }).code === "ENOENT";
}

export function shouldSkipFile(filePath: string): boolean {
  const base = basename(filePath);
  return SKIP_PATTERNS.some((pattern) => pattern.includes("*")
    ? picomatch.isMatch(base, pattern) : base === pattern)
    || SKIP_DIR_PATTERNS.some((directory) => filePath.includes(directory));
}

function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 512);
  for (let index = 0; index < checkLength; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function cacheResult(
  cache: Map<string, SecretCacheEntry>,
  relPath: string,
  mtimeMs: number,
  findings: SecretFinding[],
): SecretFinding[] {
  cache.set(relPath, { mtime_ms: mtimeMs, findings });
  return findings;
}

export async function scanFileForSecrets(
  filePath: string,
  relPath: string,
  repo: string,
  symbols: CodeSymbol[],
): Promise<SecretFinding[]> {
  const allCaches = getSecretCache();
  const repoCache = allCaches.get(repo) ?? new Map<string, SecretCacheEntry>();
  if (!allCaches.has(repo)) allCaches.set(repo, repoCache);
  const fileStat = await stat(filePath);
  const cached = repoCache.get(relPath);
  if (cached?.mtime_ms === fileStat.mtimeMs) return cached.findings;
  if (shouldSkipFile(relPath)) return cacheResult(repoCache, relPath, fileStat.mtimeMs, []);
  const buffer = await readFile(filePath);
  if (isBinaryContent(buffer) || buffer.length > MAX_FILE_SIZE) {
    return cacheResult(repoCache, relPath, fileStat.mtimeMs, []);
  }
  return cacheResult(
    repoCache,
    relPath,
    fileStat.mtimeMs,
    collectSecretFindings(buffer.toString("utf-8"), relPath, symbols),
  );
}
