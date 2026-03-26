import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Registry, RepoMeta } from "../types.js";
import { atomicWriteFile } from "./_shared.js";

/**
 * Load the multi-repo registry from disk.
 * Returns an empty registry if the file doesn't exist or is invalid.
 */
export async function loadRegistry(registryPath: string): Promise<Registry> {
  try {
    const raw = await readFile(registryPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (isValidRegistry(parsed)) {
      return parsed;
    }

    return emptyRegistry();
  } catch {
    return emptyRegistry();
  }
}

/**
 * Save the registry atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveRegistry(
  registryPath: string,
  registry: Registry,
): Promise<void> {
  const data = JSON.stringify(registry);
  await atomicWriteFile(registryPath, data);
}

/**
 * Register or update a repo in the registry.
 */
export async function registerRepo(
  registryPath: string,
  meta: RepoMeta,
): Promise<void> {
  const registry = await loadRegistry(registryPath);
  registry.repos[meta.name] = meta;
  registry.updated_at = Date.now();
  await saveRegistry(registryPath, registry);
}

/**
 * Get a single repo's metadata by name.
 * Returns null if the repo is not registered.
 */
export async function getRepo(
  registryPath: string,
  name: string,
): Promise<RepoMeta | null> {
  const registry = await loadRegistry(registryPath);
  return registry.repos[name] ?? null;
}

/**
 * List all registered repos.
 */
export async function listRepos(
  registryPath: string,
): Promise<RepoMeta[]> {
  const registry = await loadRegistry(registryPath);
  return Object.values(registry.repos);
}

/**
 * Partially update a repo's metadata (e.g., last_git_commit after freshness check).
 */
export async function updateRepoMeta(
  registryPath: string,
  repoName: string,
  updates: Partial<Pick<RepoMeta, "last_git_commit" | "symbol_count" | "file_count" | "updated_at">>,
): Promise<void> {
  const registry = await loadRegistry(registryPath);
  const existing = registry.repos[repoName];
  if (!existing) return;
  Object.assign(existing, updates);
  registry.updated_at = Date.now();
  await saveRegistry(registryPath, registry);
}

/**
 * Remove a repo from the registry.
 * Returns true if the repo existed and was removed, false otherwise.
 */
export async function removeRepo(
  registryPath: string,
  name: string,
): Promise<boolean> {
  const registry = await loadRegistry(registryPath);

  if (!(name in registry.repos)) {
    return false;
  }

  delete registry.repos[name];
  registry.updated_at = Date.now();
  await saveRegistry(registryPath, registry);
  return true;
}

/**
 * Derive a repo name from its root path.
 * Format: "local/{folder-name}"
 */
export function getRepoName(repoRoot: string): string {
  return `local/${basename(repoRoot)}`;
}

function emptyRegistry(): Registry {
  return { repos: {}, updated_at: Date.now() };
}

function isValidRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  if (typeof obj["repos"] !== "object" || obj["repos"] === null) return false;
  if (typeof obj["updated_at"] !== "number") return false;

  return true;
}
