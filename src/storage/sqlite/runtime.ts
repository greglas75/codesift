import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/**
 * Runtime availability of `node:sqlite`.
 *
 * The memoised constructor lives HERE and nowhere else. ESM gives one instance per module, so a
 * second copy of `sqliteCtor` (say, re-declared in the barrel rather than re-exported) would fork
 * the memo: `setSqliteCtorForTesting` would pin one copy while the code under test read the other,
 * and nothing about that failure looks like a wiring bug.
 */

/** `node:sqlite` landed in Node 22.5. The engines floor is still >=20, so its absence is a
 *  supported state, not an error — callers fall back to the JSON backend. */
let sqliteCtor: typeof DatabaseSyncType | null | undefined;

export async function loadSqliteCtor(): Promise<typeof DatabaseSyncType | null> {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const mod = await import("node:sqlite");
    sqliteCtor = mod.DatabaseSync;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

export async function isSqliteAvailable(): Promise<boolean> {
  return (await loadSqliteCtor()) !== null;
}

/** Tests need to prove the JSON fallback still works on a runtime that has sqlite. */
export function setSqliteCtorForTesting(ctor: typeof DatabaseSyncType | null | undefined): void {
  sqliteCtor = ctor;
}
