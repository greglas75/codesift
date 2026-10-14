// A worktree index as an overlay on a shared base (storage/sqlite/overlay.ts), checked against the
// thing it replaces: a full copy of the donor taking the same writes. Every read path must give the
// same answer from both — a difference is a wrong search result, not a cosmetic one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../src/types.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import { saveIndexSqlite, loadIndexSqlite } from "../../src/storage/sqlite/index-io.js";
import {
  applyIndexDeltaSqlite,
  loadIndexSummarySqlite,
  removeFileFromIndexSqlite,
  saveIncrementalSqlite,
  setFileMtimesSqlite,
} from "../../src/storage/sqlite/accessors.js";
import { findSymbolsSqlite, getIndexMetaSqlite, streamSymbolsSqlite } from "../../src/storage/sqlite/queries.js";
import { findSymbolsByRequestedIdsSqlite } from "../../src/storage/sqlite/narrow-queries.js";
import { OVERLAY_ATTACH_SQL, OVERLAY_BASE_KEY, OVERLAY_ROWID_BASE, attachOverlay } from "../../src/storage/sqlite/overlay.js";
import { isIndexStorageError } from "../../src/storage/sqlite/errors.js";
import { baseForDonor, writeOverlayIndex } from "../../src/tools/index-tools/worktree-overlay.js";
import { HAS_OVERLAY_WRITES } from "../helpers/overlay-sqlite.js";

// Node 22's SQLite cannot write through an overlay; the seed declines there instead.
const describeWithOverlay = HAS_OVERLAY_WRITES ? describe : describe.skip;

const FAMILY = "local/fam";
const WT = "local/fam@wt";

function sym(file: string, name: string, line: number, prefix = FAMILY, source = `function ${name}() {}`): CodeSymbol {
  return {
    id: `${prefix}:${file}:${name}:${line}`, repo: FAMILY, name, kind: line % 2 ? "function" : "class",
    file, start_line: line, end_line: line + 1, source,
  };
}

function entry(path: string, symbolCount: number, mtime: number): FileEntry {
  return { path, language: "typescript", symbol_count: symbolCount, last_modified: mtime, mtime_ms: mtime };
}

function donorIndex(): CodeIndex {
  const symbols: CodeSymbol[] = [];
  const files: FileEntry[] = [];
  for (let f = 0; f < 30; f++) {
    const path = `src/f${f}.ts`;
    for (let s = 1; s <= 3; s++) symbols.push(sym(path, `s${f}_${s}`, s));
    files.push(entry(path, 3, 1));
  }
  return {
    repo: FAMILY, root: "/donor", symbols, files, created_at: 1, updated_at: 2,
    symbol_count: symbols.length, file_count: files.length,
  };
}

let dir: string;
let plain: string;
let overlay: string;
let base: string;

/** `highRowids`: a donor whose rows already sit above OVERLAY_ROWID_BASE, as a former overlay's do. */
async function makeOverlay(highRowids = false): Promise<void> {
  const donorDb = join(dir, "aaaaaaaaaaaa.index.db");
  await saveIndexSqlite(donorDb, donorIndex());
  closeAllIndexDbs();
  if (highRowids) {
    const d = new DatabaseSync(donorDb);
    d.prepare("UPDATE symbols SET rowid = rowid + ?").run(OVERLAY_ROWID_BASE);
    d.prepare("UPDATE files SET rowid = rowid + ?").run(OVERLAY_ROWID_BASE);
    d.close();
  }
  const picked = await baseForDonor(donorDb, { name: FAMILY, root: dir, commit: null }, FAMILY, dir);
  base = picked.base.path;
  const temp = `${overlay}.seeding`;
  await writeOverlayIndex(temp, {
    donorDb, donorName: FAMILY, donorIsOverlay: false, base: picked.base, worktreeName: WT, worktreeRoot: "/wt",
  });
  await rename(temp, overlay);
  // The full copy the overlay replaces: same rows, same name.
  const db = new DatabaseSync(donorDb);
  db.exec(`VACUUM INTO '${plain}'`);
  db.close();
  const p = new DatabaseSync(plain);
  p.prepare("UPDATE meta SET value = ? WHERE key = 'repo'").run(WT);
  p.prepare("UPDATE meta SET value = '/wt' WHERE key = 'root'").run();
  p.close();
}

/**
 * One write sequence covering every writer path: rewrite, shrink to zero, delete, add, re-add, a
 * file row alone (a recorded mtime), and a re-walk's delta.
 */
async function applyWrites(dbPath: string): Promise<void> {
  await saveIncrementalSqlite(dbPath, "src/f3.ts", [sym("src/f3.ts", "rewritten", 1, WT), sym("src/f3.ts", "added", 2, WT)], entry("src/f3.ts", 2, 9));
  await saveIncrementalSqlite(dbPath, "src/f7.ts", [], entry("src/f7.ts", 0, 9));
  await removeFileFromIndexSqlite(dbPath, "src/f11.ts");
  await saveIncrementalSqlite(dbPath, "src/new.ts", [sym("src/new.ts", "fresh", 1, WT)], entry("src/new.ts", 1, 9));
  await removeFileFromIndexSqlite(dbPath, "src/f20.ts");
  await saveIncrementalSqlite(dbPath, "src/f20.ts", [sym("src/f20.ts", "back", 4, WT)], entry("src/f20.ts", 1, 10));
  // A symbol write with no file row, as an extractor-only update does.
  await saveIncrementalSqlite(dbPath, "src/f25.ts", [sym("src/f25.ts", "nofile", 7, WT)]);
  await setFileMtimesSqlite(dbPath, [["src/f1.ts", 77], ["src/not-indexed.ts", 5]]);
  await applyIndexDeltaSqlite(dbPath, {
    replaced: [{ path: "src/f4.ts", symbols: [sym("src/f4.ts", "delta", 1, WT)], entry: entry("src/f4.ts", 1, 11) }],
    entries: [entry("src/f5.ts", 3, 12)],
    removed: ["src/f6.ts"],
    updatedAt: 123,
    meta: { extractor_version: { typescript: "9" }, workspaces: null },
  });
}

async function streamed(dbPath: string): Promise<string[]> {
  const out: string[] = [];
  await streamSymbolsSqlite(dbPath, { withSource: false }, (batch) => { out.push(...batch.map((s) => s.id)); });
  return out;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "codesift-overlay-"));
  // The donor's checkout: a base records its uncommitted files, and refuses when git cannot say.
  execFileSync("git", ["init", "-q"], { cwd: dir });
  plain = join(dir, "cccccccccccc.index.db");
  overlay = join(dir, "bbbbbbbbbbbb.index.db");
});

afterEach(() => {
  closeAllIndexDbs();
  rmSync(dir, { recursive: true, force: true });
});

describe("overlay SQL", () => {
  // Bug it catches: the TypeScript and Rust copies drifting apart, so one store merges the base and
  // the other does not (or masks differently) — the same index answering two ways.
  it("is byte-identical in the Rust store", () => {
    const rust = readFileSync(new URL("../../crates/codesift-core/src/overlay.rs", import.meta.url), "utf-8");
    const match = /pub const OVERLAY_ATTACH_SQL: &str = r#"([\s\S]*?)"#;/.exec(rust);
    expect(match?.[1]).toBe(OVERLAY_ATTACH_SQL);
  });
});

describeWithOverlay("an overlay index against the full copy it replaces", () => {
  // Bug it catches: any read path that sees the overlay alone, the base alone, a masked file's old
  // rows, or rows out of the order a plain table keeps them in — and, with a donor whose rowids are
  // already high, a new row given a rowid a base row still holds.
  it.each([{ rowids: "low", high: false }, { rowids: "high", high: true }])("answers every read the same after the same writes ($rowids base rowids)", async ({ high }) => {
    await makeOverlay(high);
    await applyWrites(plain);
    await applyWrites(overlay);

    const [a, b] = [await loadIndexSqlite(plain), await loadIndexSqlite(overlay)];
    expect(b?.symbols).toEqual(a?.symbols);
    expect(b?.files).toEqual(a?.files);
    // Each write stamps its own clock reading; everything else must match.
    const summary = async (p: string) => ({ ...(await loadIndexSummarySqlite(p)), updated_at: 0 });
    const meta = async (p: string) => ({ ...(await getIndexMetaSqlite(p)), updatedAt: 0 });
    expect(await summary(overlay)).toEqual(await summary(plain));
    expect(await meta(overlay)).toEqual(await meta(plain));
    expect(await streamed(overlay)).toEqual(await streamed(plain));
    for (const q of [{ name: "rewritten" }, { kind: "class" }, { file: "src/f3.ts" }, { file: "src/f11.ts" }, { namePrefix: "s2" }]) {
      expect(await findSymbolsSqlite(overlay, { withSource: true, ...q })).toEqual(await findSymbolsSqlite(plain, { withSource: true, ...q }));
    }
  });

  // Bug it catches: a lookup by an id without its repo prefix finding only one of the two prefixes an
  // overlay holds (its base's and its own).
  it("finds a prefix-less id among base rows and the worktree's own rows", async () => {
    await makeOverlay();
    await applyWrites(overlay);
    const got = await findSymbolsByRequestedIdsSqlite(overlay, ["src/f1.ts:s1_1:1", "src/f3.ts:rewritten:1"], false);
    expect(got.map((s) => s.id)).toEqual([`${FAMILY}:src/f1.ts:s1_1:1`, `${WT}:src/f3.ts:rewritten:1`]);
  });

  // Bug it catches: a whole-index write that leaves base rows beside the new ones, or keeps the base
  // pinned after the database no longer needs it.
  it("becomes a plain index on a whole-index write", async () => {
    await makeOverlay();
    const index: CodeIndex = {
      repo: WT, root: "/wt", symbols: [sym("z.ts", "z", 1, WT)], files: [entry("z.ts", 1, 1)],
      created_at: 3, updated_at: 4, symbol_count: 1, file_count: 1,
    };
    await saveIndexSqlite(overlay, index);
    expect((await loadIndexSqlite(overlay))?.symbols.map((s) => s.name)).toEqual(["z"]);
    closeAllIndexDbs();
    const raw = new DatabaseSync(overlay, { open: true });
    const pinned = raw.prepare("SELECT value FROM meta WHERE key = ?").get(OVERLAY_BASE_KEY);
    // Written to the plain tables, not through the triggers (which number rows from OVERLAY_ROWID_BASE).
    const maxRowid = (raw.prepare("SELECT max(rowid) AS m FROM symbols").get() as { m: number }).m;
    raw.close();
    expect(pinned).toBeUndefined();
    expect(maxRowid).toBeLessThan(OVERLAY_ROWID_BASE);
    expect((await loadIndexSqlite(overlay))?.symbols.map((s) => s.name)).toEqual(["z"]);
  });

  // Bug it catches: a deleted base answered as an index holding only the worktree's few changes —
  // or re-created EMPTY by the open (a plain ATTACH creates a missing file), which every later open
  // would then take for the base.
  it("refuses to open when its base is gone, and leaves it gone", async () => {
    await makeOverlay();
    closeAllIndexDbs();
    rmSync(base, { force: true });
    const err = await loadIndexSqlite(overlay).catch((e: unknown) => e);
    expect(isIndexStorageError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("OVERLAY_BASE_MISSING");
    expect(existsSync(base)).toBe(false);
  });

  // Bug it catches: a base attached writable — one stray write changes every worktree built on it,
  // whatever its file mode says (root ignores 0444).
  it("attaches its base read-only", async () => {
    await makeOverlay();
    closeAllIndexDbs();
    chmodSync(base, 0o644); // what root sees whatever the mode: only the attach can keep it read-only
    const db = new DatabaseSync(overlay);
    try {
      attachOverlay(db, overlay);
      expect(() => db.exec("DELETE FROM ovbase.symbols")).toThrow(/readonly/);
    } finally {
      db.close();
    }
  });

  // Bug it catches: the seed still copying the donor — the whole point is that it does not.
  it("stores only the worktree's own rows", async () => {
    await makeOverlay();
    await applyWrites(overlay);
    closeAllIndexDbs();
    const raw = new DatabaseSync(overlay, { open: true });
    const own = (raw.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    raw.close();
    // f3 (2), f20 (1), new (1), f25 (1), f4 (1): the touched files' copied base rows were deleted with
    // them. f1 and f5 had only their file row written, which must not copy their symbols.
    expect(own).toBe(6);
    expect(statSync(base).mode & 0o222).toBe(0);
  });
});
