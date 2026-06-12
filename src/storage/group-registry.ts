import { readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GroupRegistry, RepoGroup } from "../types.js";
import { atomicWriteFile } from "./_shared.js";

/**
 * Return the canonical path for the group registry file inside a data directory.
 */
export function getGroupRegistryPath(dataDir: string): string {
  return join(dataDir, "groups.json");
}

// ---------------------------------------------------------------------------
// CRITICAL-3: per-path promise chain to serialize R-M-W mutations
// (mirrors writeLocks pattern from index-store.ts)
// ---------------------------------------------------------------------------
const writeLocks = new Map<string, Promise<unknown>>();

function chainMutation<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  // FIX-A: normalize path so "./x/groups.json" and "x/groups.json" share a lock
  const lockKey = resolve(registryPath);
  const prev = writeLocks.get(lockKey) ?? Promise.resolve();
  const next = prev.then(fn);
  // Swallow errors from the chain link so future callers aren't blocked
  writeLocks.set(lockKey, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------------------
// CRITICAL-2: reserved name guard
// ---------------------------------------------------------------------------
const RESERVED_NAMES = /^(__proto__|constructor|prototype)$/;

function assertValidName(name: string): void {
  if (name.trim() === "") {
    throw new Error(`Invalid group name: name must not be empty or whitespace-only.`);
  }
  if (RESERVED_NAMES.test(name)) {
    throw new Error(
      `Invalid group name "${name}": reserved prototype/constructor names are not allowed.`,
    );
  }
}

// ---------------------------------------------------------------------------
// CRITICAL-1: split load semantics
//   ENOENT           → empty registry (legit first run)
//   JSON/struct bad  → quarantine (rename to .corrupt-<ts>), return empty
//   other read error → THROW (prevents silent wipe on EACCES/EMFILE)
// ---------------------------------------------------------------------------

/**
 * Load the group registry from disk.
 *
 * - ENOENT → returns empty registry (first run)
 * - Corrupt JSON or invalid structure → renames file to groups.json.corrupt-<ts>,
 *   logs a warning, and returns empty registry (data is never silently destroyed)
 * - Other I/O error (EACCES, EMFILE, …) → throws so callers can propagate
 */
export async function loadGroupRegistry(registryPath: string): Promise<GroupRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyGroupRegistry();
    }
    // EACCES, EMFILE, etc. — throw so mutations don't overwrite with empty state
    throw err;
  }

  // File exists — try to parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorrupt(registryPath);
    return emptyGroupRegistry();
  }

  if (isValidGroupRegistry(parsed)) {
    return parsed;
  }

  // Structurally invalid (valid JSON but wrong shape)
  await quarantineCorrupt(registryPath);
  return emptyGroupRegistry();
}

/**
 * Rename the corrupt file to a timestamped sibling so data is never lost.
 * Best-effort — if renaming fails we swallow the error (we already know the
 * data is unusable).
 */
async function quarantineCorrupt(registryPath: string): Promise<void> {
  const dest = `${registryPath}.corrupt-${Date.now()}`;
  try {
    await rename(registryPath, dest);
    console.warn(
      `[codesift] group-registry: corrupt file quarantined as ${dest}`,
    );
  } catch {
    console.warn(
      `[codesift] group-registry: failed to quarantine corrupt file at ${registryPath}`,
    );
  }
}

/**
 * Save the group registry atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveGroupRegistry(
  registryPath: string,
  registry: GroupRegistry,
): Promise<void> {
  const data = JSON.stringify(registry);
  await atomicWriteFile(registryPath, data);
}

/**
 * Register or update a group. Duplicate repos are deduplicated.
 * On overwrite: preserves created_at, updates updated_at.
 *
 * Mutations are serialized per registry path (CRITICAL-3 R-M-W race fix).
 * Invalid/reserved names are rejected immediately (CRITICAL-2).
 */
export async function registerGroup(
  registryPath: string,
  input: { name: string; repos: string[]; description?: string },
): Promise<void> {
  assertValidName(input.name);

  // FIX-B: runtime input validation
  if (!Array.isArray(input.repos)) {
    throw new Error(`Invalid repos: expected an array of strings, got ${typeof input.repos}.`);
  }
  for (const r of input.repos) {
    if (typeof r !== "string" || r === "") {
      throw new Error(
        `Invalid repos: every element must be a non-empty string (got ${JSON.stringify(r)}).`,
      );
    }
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new Error(
      `Invalid description: expected a string, got ${typeof input.description}.`,
    );
  }

  return chainMutation(registryPath, async () => {
    const registry = await loadGroupRegistry(registryPath);
    const now = Date.now();
    const existing = Object.hasOwn(registry.groups, input.name)
      ? registry.groups[input.name]
      : undefined;

    const deduped = [...new Set(input.repos)];

    const group: RepoGroup = existing
      ? {
          name: input.name,
          repos: deduped,
          ...(input.description !== undefined ? { description: input.description } : {}),
          created_at: existing.created_at,
          updated_at: now,
        }
      : {
          name: input.name,
          repos: deduped,
          ...(input.description !== undefined ? { description: input.description } : {}),
          created_at: now,
          updated_at: now,
        };

    registry.groups[input.name] = group;
    registry.updated_at = now;
    await saveGroupRegistry(registryPath, registry);
  });
}

/**
 * Get a single group by name. Returns null if not found.
 *
 * Read-only: catches non-fatal load errors and returns null with a warning.
 */
export async function getGroup(
  registryPath: string,
  name: string,
): Promise<RepoGroup | null> {
  let registry: GroupRegistry;
  try {
    registry = await loadGroupRegistry(registryPath);
  } catch {
    console.warn(`[codesift] group-registry: could not read registry at ${registryPath}`);
    return null;
  }
  return Object.hasOwn(registry.groups, name) ? registry.groups[name]! : null;
}

/**
 * List all registered groups.
 *
 * Read-only: catches non-fatal load errors and returns empty array with a warning.
 */
export async function listGroups(registryPath: string): Promise<RepoGroup[]> {
  let registry: GroupRegistry;
  try {
    registry = await loadGroupRegistry(registryPath);
  } catch {
    console.warn(`[codesift] group-registry: could not read registry at ${registryPath}`);
    return [];
  }
  return Object.keys(registry.groups)
    .filter((k) => Object.hasOwn(registry.groups, k))
    .map((k) => registry.groups[k]!);
}

/**
 * Remove a group by name.
 * Returns true if it existed and was removed, false otherwise (idempotent).
 *
 * Mutations are serialized per registry path (CRITICAL-3 R-M-W race fix).
 */
export async function removeGroup(
  registryPath: string,
  name: string,
): Promise<boolean> {
  return chainMutation(registryPath, async () => {
    const registry = await loadGroupRegistry(registryPath);

    if (!Object.hasOwn(registry.groups, name)) {
      return false;
    }

    delete registry.groups[name];
    registry.updated_at = Date.now();
    await saveGroupRegistry(registryPath, registry);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyGroupRegistry(): GroupRegistry {
  return { groups: {}, updated_at: Date.now() };
}

/**
 * Deep structural guard for a raw parsed GroupRegistry value.
 * Mirrors the Array.isArray improvements from hash-snapshot.ts.
 */
function isValidGroupRegistry(value: unknown): value is GroupRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj["updated_at"] !== "number") return false;

  const groups = obj["groups"];
  if (typeof groups !== "object" || groups === null || Array.isArray(groups)) {
    return false;
  }

  // FIX-C: validate each group entry, guarding against prototype pollution,
  // key/name mismatch, and reserved keys crafted on disk
  for (const key of Object.keys(groups)) {
    if (!Object.hasOwn(groups as object, key)) continue;
    // Reject reserved keys even if they somehow appear in the JSON
    if (RESERVED_NAMES.test(key)) return false;
    const entry = (groups as Record<string, unknown>)[key];
    if (!isValidRepoGroup(entry)) return false;
    // key must equal the group's own name field — mismatch = tampered file
    if ((entry as unknown as Record<string, unknown>)["name"] !== key) return false;
  }

  return true;
}

function isValidRepoGroup(value: unknown): value is RepoGroup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj["name"] !== "string") return false;
  if (typeof obj["created_at"] !== "number") return false;
  if (typeof obj["updated_at"] !== "number") return false;

  const repos = obj["repos"];
  if (!Array.isArray(repos)) return false;
  for (const r of repos) {
    if (typeof r !== "string") return false;
  }

  // description is optional — if present it must be a string
  if (Object.hasOwn(obj, "description") && typeof obj["description"] !== "string") return false;

  return true;
}
