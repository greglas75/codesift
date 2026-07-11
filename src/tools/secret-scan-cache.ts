import type { SecretCacheEntry } from "./secret-scan-types.js";

const secretCache = new Map<string, Map<string, SecretCacheEntry>>();

export function getSecretCache(): Map<string, Map<string, SecretCacheEntry>> {
  return secretCache;
}

export function resetSecretCache(): void {
  secretCache.clear();
}

export function onFileChanged(repo: string, filePath: string): void {
  secretCache.get(repo)?.delete(filePath);
}

export function onFileDeleted(repo: string, filePath: string): void {
  secretCache.get(repo)?.delete(filePath);
}
