import type { CodeIndex } from "../types.js";
import {
  importLegacyIndexIfEmpty,
  isSqliteAvailable,
  loadIndexSqlite,
} from "./sqlite-index-store.js";

export type IndexBackend = "json" | "sqlite";

/**
 * Which on-disk format to use.
 *
 * The result is cached because backend selection is process-wide. Explicit SQLite mode fails
 * loudly when `node:sqlite` is unavailable; auto mode keeps Node 20 installations on JSON.
 */
let backendPromise: Promise<IndexBackend> | undefined;

export async function resolveIndexBackend(): Promise<IndexBackend> {
  backendPromise ??= computeIndexBackend();
  return backendPromise;
}

async function computeIndexBackend(): Promise<IndexBackend> {
  const explicit = process.env["CODESIFT_INDEX_BACKEND"];
  if (explicit === "json") return "json";
  if (explicit === "sqlite") {
    if (!(await isSqliteAvailable())) {
      throw new Error(
        "CODESIFT_INDEX_BACKEND=sqlite but node:sqlite is unavailable (requires Node >= 22.5)",
      );
    }
    return "sqlite";
  }
  return (await isSqliteAvailable()) ? "sqlite" : "json";
}

export function resetIndexBackendForTesting(): void {
  backendPromise = undefined;
}

/**
 * Keep both formats side by side so the JSON file remains a usable rollback artifact.
 * Throws when given an already-derived SQLite file or sidecar: accepting one would silently
 * derive a second, unrelated database path.
 */
export function sqlitePathFor(indexPath: string): string {
  if (/\.db(?:-(?:wal|shm|journal))?$/i.test(indexPath)) {
    throw new TypeError(
      `Expected a canonical index path, received SQLite database path: ${indexPath}`,
    );
  }
  return indexPath.endsWith(".json")
    ? `${indexPath.slice(0, -".json".length)}.db`
    : `${indexPath}.db`;
}

type LegacyIndexLoader = (indexPath: string) => Promise<CodeIndex | null>;

/** Guards one-time JSON-to-SQLite migration per database path. */
const migrations = new Map<string, Promise<void>>();

/**
 * Bring an existing JSON index across on first touch without deleting the rollback source.
 * The legacy loader is injected by the facade so this module never imports `index-store.ts`
 * and therefore cannot introduce a storage-module cycle.
 */
export async function ensureSqliteMigrated(
  indexPath: string,
  dbPath: string,
  loadLegacyIndex: LegacyIndexLoader,
): Promise<void> {
  const inFlight = migrations.get(dbPath);
  if (inFlight) return inFlight;

  const run = (async () => {
    if ((await loadIndexSqlite(dbPath)) !== null) return;
    const legacy = await loadLegacyIndex(indexPath);
    // The importer re-checks emptiness under its write lock, so racing processes cannot
    // overwrite rows imported by the winner.
    if (legacy) await importLegacyIndexIfEmpty(dbPath, legacy);
  })();

  migrations.set(dbPath, run);
  try {
    await run;
  } catch (err) {
    // Failed migrations are retried. Do not probe the failing database again here: a second
    // error would replace the original one through JavaScript's try/finally semantics.
    migrations.delete(dbPath);
    throw err;
  }
  migrations.set(dbPath, Promise.resolve());
}

export function resetMigrationCacheForTesting(): void {
  migrations.clear();
}
