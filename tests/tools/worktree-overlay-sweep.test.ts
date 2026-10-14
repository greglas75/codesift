// `prune` and overlay bases: a base goes only when no overlay points at it — a base deleted under a
// live overlay turns that worktree's index into one that refuses to open.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { sweepUnreferencedBases } from "../../src/tools/index-tools/worktree-overlay.js";
import { OVERLAY_BASE_KEY } from "../../src/storage/sqlite/overlay.js";

let dir: string;
const HOUR = 60 * 60 * 1000;

function overlayIndex(name: string, base: string): void {
  const db = new DatabaseSync(join(dir, name));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES (?, ?)").run(OVERLAY_BASE_KEY, base);
  db.close();
}

function base(name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x");
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codesift-bases-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sweepUnreferencedBases", () => {
  // Bug it catches: removing a base an overlay still reads, keeping unreferenced bases forever, or
  // removing one a seed published seconds ago (before the overlay that points at it).
  it("removes only old bases no overlay points at", async () => {
    const used = base("base-0000000000000001.db", 2 * HOUR);
    const unused = base("base-0000000000000002.db", 2 * HOUR);
    const young = base("base-0000000000000003.db", 60_000);
    overlayIndex("aaaaaaaaaaaa.index.db", used);

    const result = await sweepUnreferencedBases(dir, false);

    expect([existsSync(used), existsSync(unused), existsSync(young)]).toEqual([true, false, true]);
    expect(result).toMatchObject({ kept: 2, removed: 1 });
  });

  // Bug it catches: an unreadable index database read as "references nothing", deleting the base of
  // the very overlay that could not be read.
  it("removes nothing when an index database cannot be read", async () => {
    const unused = base("base-0000000000000002.db", 2 * HOUR);
    writeFileSync(join(dir, "bbbbbbbbbbbb.index.db"), "not a database");

    const result = await sweepUnreferencedBases(dir, false);

    expect(existsSync(unused)).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.skipped_reason).toMatch(/could not be read/);
  });

  // Bug it catches: a dry run that deletes.
  it("only reports in a dry run", async () => {
    const unused = base("base-0000000000000002.db", 2 * HOUR);
    const result = await sweepUnreferencedBases(dir, true);
    expect(existsSync(unused)).toBe(true);
    expect(result.removed).toBe(1);
  });
});
