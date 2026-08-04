import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  closeAllIndexDbs,
  closeIndexDb,
  getFileEntrySqlite,
  isSqliteAvailable,
  loadIndexSummarySqlite,
  loadSqliteCtor,
  openIndexDb,
  setSqliteCtorForTesting,
} from "../../src/storage/sqlite-index-store.js";

/**
 * The precondition that makes splitting this backend safe, asserted rather than assumed.
 *
 * Two module-scope mutable bindings live behind this facade: the memoised `node:sqlite`
 * constructor (`sqlite/runtime.ts`) and the open-connection cache (`sqlite/connection.ts`). Each
 * must exist in EXACTLY ONE module. ESM gives one instance per module, so re-exporting is safe and
 * re-declaring is not — a second copy forks the state, and the resulting bug is invisible to a
 * type-check, a linter, and to any test that only exercises one entry point.
 *
 * What each test can and cannot catch, stated honestly because the first version of this comment
 * claimed more than the tests delivered:
 *
 *   - The CROSS-MODULE tests are the load-bearing ones: they write the state through a function in
 *     one module and observe it through a function in another (`runtime` -> `connection`,
 *     `runtime` -> the read path, `accessors` -> `connection`). A fork makes the two disagree.
 *   - The SAME-MODULE tests (`closeIndexDb` vs `openIndexDb`, both in `connection.ts`) cannot fail
 *     by forking today. They pin the cache's contract so that a LATER split of `connection.ts`
 *     itself has something to break. That is a weaker guarantee, and it is labelled as one.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-modstate-"));
});

afterEach(async () => {
  closeAllIndexDbs();
  // Back to "not yet resolved" so the next test re-imports node:sqlite normally. Leaving a pinned
  // ctor behind would leak through the very shared binding under test.
  setSqliteCtorForTesting(undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("sqlite ctor memo is a single module-scope binding", () => {
  it("hands back the pinned constructor itself, on every call", async () => {
    // Identity, not just reachability. Asserting only that `null` disables sqlite would also pass
    // against an implementation with NO memo at all — one that re-imports `node:sqlite` per call —
    // because the pinned value is checked through the same module's own reader either way. A
    // sentinel proves the stored value is what gets handed out.
    const sentinel = function FakeDatabaseSync() {} as unknown as typeof DatabaseSyncType;
    setSqliteCtorForTesting(sentinel);

    expect((await loadSqliteCtor()) === sentinel).toBe(true);
    expect((await loadSqliteCtor()) === sentinel).toBe(true);
  });

  it("openIndexDb observes a ctor pinned through setSqliteCtorForTesting", async () => {
    // CROSS-MODULE: written via `runtime.ts`, read via `connection.ts`. A forked memo leaves
    // openIndexDb still holding the real constructor, so it would happily open a database.
    setSqliteCtorForTesting(null);
    await expect(openIndexDb(join(dir, "a.index.db"))).rejects.toThrow(/node:sqlite is unavailable/);
  });

  it("the READ path shares that memo too, not a second copy", async () => {
    // CROSS-MODULE, and the gap the first version of this file left open: `openReadConnection` is
    // the sole gate for every snapshot read (`loadIndexSqlite`, `loadIndexSummarySqlite`), and it
    // resolves the ctor independently of `openIndexDb`. Opening first means the cached connection
    // satisfies `openIndexDb` without touching the ctor, so the rejection below can only come from
    // the read path's own lookup.
    const dbPath = join(dir, "read.index.db");
    await openIndexDb(dbPath);

    setSqliteCtorForTesting(null);
    await expect(loadIndexSummarySqlite(dbPath)).rejects.toThrow(/node:sqlite is unavailable/);
  });

  it("isSqliteAvailable reflects the pinned value and recovers when it is cleared", async () => {
    setSqliteCtorForTesting(null);
    expect(await isSqliteAvailable()).toBe(false);

    setSqliteCtorForTesting(undefined);
    expect(await isSqliteAvailable()).toBe(true);
  });
});

describe("open-connection cache is a single module-scope binding", () => {
  it("a handle opened through an accessor is the one closeAllIndexDbs closes", async () => {
    // CROSS-MODULE: `getFileEntrySqlite` lives in `accessors.ts` and opens through the cache;
    // `closeAllIndexDbs` lives in `connection.ts`. If those two ever walked different maps, the
    // accessor's handle would survive the close and `openIndexDb` would keep handing out a CLOSED
    // database — usable-looking, and throwing on its first statement.
    const dbPath = join(dir, "acc.index.db");
    await getFileEntrySqlite(dbPath, "nothing.ts");
    const opened = await openIndexDb(dbPath);

    closeAllIndexDbs();

    const afterClose = await openIndexDb(dbPath);
    // Compared as a boolean rather than `expect(x).not.toBe(y)`: the matcher formats its operands,
    // and formatting a closed DatabaseSync throws "database is not open" from inside the assertion
    // itself — reported as a failure of whichever line it lands on, not of the thing tested.
    expect(afterClose === opened).toBe(false);
    expect(() => afterClose.exec("SELECT 1")).not.toThrow();
  });

  it("returns the same handle for one path (same-module contract)", async () => {
    const dbPath = join(dir, "b.index.db");
    const first = await openIndexDb(dbPath);
    expect((await openIndexDb(dbPath)) === first).toBe(true);
  });

  it("closeIndexDb evicts only the path it was given (same-module contract)", async () => {
    const one = join(dir, "c1.index.db");
    const two = join(dir, "c2.index.db");

    const firstOne = await openIndexDb(one);
    const firstTwo = await openIndexDb(two);

    closeIndexDb(one);

    expect((await openIndexDb(one)) === firstOne).toBe(false);
    expect((await openIndexDb(two)) === firstTwo).toBe(true);
  });
});
