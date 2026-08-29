import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openIndexDb, closeIndexDb } from "../../src/storage/sqlite/connection.js";
import { saveIndexSqlite } from "../../src/storage/sqlite/index-io.js";
import type { CodeIndex, CodeSymbol } from "../../src/types.js";

/**
 * `node:sqlite` is entirely synchronous, so writing an index used to hold the thread for the whole
 * table. Measured on the largest real index here (372,949 symbols, 732 MB): 3.8 s during which a
 * 50 ms timer fired ZERO times — the shared daemon could not answer anybody, `/health` included,
 * and a sample put 41% of main-thread time inside StatementSync::Run.
 */
describe("index writes do not monopolise the event loop", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function index(symbolCount: number): CodeIndex {
    const symbols: CodeSymbol[] = Array.from({ length: symbolCount }, (_, i) => ({
      id: `local/t:src/f${i % 50}.ts:s${i}:${i}`,
      name: `s${i}`,
      kind: "function",
      file: `src/f${i % 50}.ts`,
      start_line: i,
      end_line: i + 3,
      source: `function s${i}() { return ${i}; }`,
    })) as CodeSymbol[];
    return {
      repo: "local/t", root: "/tmp/t", files: [], symbols,
      symbol_count: symbols.length, created_at: Date.now(), updated_at: Date.now(),
    } as CodeIndex;
  }

  it("lets timers fire while a large index is being written", async () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-yield-"));
    const dbPath = join(dir, "t.index.db");
    await openIndexDb(dbPath);

    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      await saveIndexSqlite(dbPath, index(6000));
    } finally {
      clearInterval(timer);
    }

    // The property that was missing. Before the change this was exactly 0, however long the write
    // took — which is what "the daemon stopped responding" meant in practice.
    expect(ticks).toBeGreaterThan(0);
    closeIndexDb(dbPath);
  }, 60_000);

  it("still writes every row — yielding must not lose data", async () => {
    dir = mkdtempSync(join(tmpdir(), "codesift-yield-"));
    const dbPath = join(dir, "t.index.db");
    const db = await openIndexDb(dbPath);

    // Deliberately not a multiple of the batch size, so the tail after the last yield is covered.
    await saveIndexSqlite(dbPath, index(1234));

    const row = db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number };
    expect(row.n).toBe(1234);
    closeIndexDb(dbPath);
  }, 60_000);

  it("replaces rather than appends across successive saves", async () => {
    // The write opens with DELETE FROM symbols; yielding inside the same transaction must not let
    // a second save see a half-emptied table.
    dir = mkdtempSync(join(tmpdir(), "codesift-yield-"));
    const dbPath = join(dir, "t.index.db");
    const db = await openIndexDb(dbPath);

    await saveIndexSqlite(dbPath, index(900));
    await saveIndexSqlite(dbPath, index(400));

    const row = db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number };
    expect(row.n).toBe(400);
    closeIndexDb(dbPath);
  }, 60_000);
});
