// A seeded worktree overlay through `indexFolder` end to end: the seed, its catch-up, and a later
// re-walk — the path agents and `ensureIndexFresh` take. Each test names a defect found by running
// exactly this on a real tree (zuvo/proofs/build-worktree-overlay-AP2.txt).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { getFileEntry, getIndexPath, loadIndex } from "../../src/storage/index-store.js";
import { sqlitePathFor } from "../../src/storage/index-migration.js";
import { closeAllIndexDbs } from "../../src/storage/sqlite/connection.js";
import { OVERLAY_BASE_KEY } from "../../src/storage/sqlite/overlay.js";
import { HAS_NODE_SQLITE } from "../helpers/node-sqlite.js";

const describeWithSqlite = HAS_NODE_SQLITE ? describe : describe.skip;

let work: string;
let dataDir: string;
let parent: string;
let worktree: string;
const saved: Record<string, string | undefined> = {};

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

/** Index the worktree; returns the canonical root `indexFolder` settled on. */
async function indexWorktree(): Promise<string> {
  const result = await indexFolder(worktree, { watch: false }) as { root: string };
  return result.root;
}

async function symbolNames(root: string): Promise<string[]> {
  const index = await loadIndex(getIndexPath(dataDir, root));
  return (index?.symbols ?? []).map((s) => s.name).sort();
}

/** The overlay database as stored, not through its views: what it holds of its own. */
function ownRows(root: string): { base: string | undefined; symbolFiles: string[] } {
  closeAllIndexDbs();
  const db = new DatabaseSync(`file:${sqlitePathFor(getIndexPath(dataDir, root))}?mode=ro`, { open: true });
  try {
    const base = (db.prepare("SELECT value FROM meta WHERE key = ?").get(OVERLAY_BASE_KEY) as { value: string } | undefined)?.value;
    const symbolFiles = (db.prepare("SELECT DISTINCT file FROM symbols ORDER BY file").all() as Array<{ file: string }>).map((r) => r.file);
    return { base, symbolFiles };
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "codesift-rewalk-"));
  dataDir = join(work, "data");
  parent = join(work, "main");
  worktree = join(work, "wt");
  for (const key of ["CODESIFT_DATA_DIR", "CODESIFT_DISABLE_LOCAL_EMBEDDINGS", "CODESIFT_INDEX_EMBEDDINGS"]) saved[key] = process.env[key];
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "true";
  process.env["CODESIFT_INDEX_EMBEDDINGS"] = "0";
  resetConfigCache();

  mkdirSync(join(parent, "src"), { recursive: true });
  // The parent's files are dated in the past, so the worktree's checkout mtimes always differ.
  const past = new Date("2020-01-01T00:00:00Z");
  for (const name of ["a", "b", "c"]) {
    const file = join(parent, "src", `${name}.ts`);
    writeFileSync(file, `export function ${name}() { return 1; }\n`);
    utimesSync(file, past, past);
  }
  git(["init", "-q", "-b", "main"], parent);
  git(["add", "-A"], parent);
  git(["commit", "-q", "-m", "init"], parent);
  await indexFolder(parent, { watch: false });
  git(["worktree", "add", "-q", "-b", "task", worktree], parent);
});

afterEach(() => {
  closeAllIndexDbs();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  rmSync(work, { recursive: true, force: true });
});

describeWithSqlite("a seeded worktree overlay, re-walked", () => {
  // Bug it catches: this tree's mtimes recorded before the catch-up re-read its edits — `index_file`
  // then saw a matching mtime and kept the donor's symbols for a file the worktree had changed.
  it("indexes an uncommitted edit made before the first index", async () => {
    appendFileSync(join(worktree, "src", "a.ts"), "export function editedBeforeSeed() {}\n");
    const root = await indexWorktree();
    expect(await symbolNames(root)).toContain("editedBeforeSeed");
    expect(ownRows(root).base).toBeDefined();
  });

  // Bug it catches: a second index_folder ending in a whole-index write, which masks every base path
  // and turns the overlay back into a full copy of its donor.
  it("writes only the files a re-walk changed and stays an overlay", async () => {
    const root = await indexWorktree();
    appendFileSync(join(worktree, "src", "b.ts"), "export function editedAfterSeed() {}\n");
    await indexWorktree();
    expect(await symbolNames(root)).toEqual(["a", "b", "c", "editedAfterSeed"]);
    expect(ownRows(root)).toEqual({ base: expect.any(String), symbolFiles: ["src/b.ts"] });
  });

  // Bug it catches: the overlay keeping the donor's mtimes, so every walk and every index_file sees
  // every file as modified and re-parses the whole tree.
  it("records this tree's own mtime for a file it did not change", async () => {
    const root = await indexWorktree();
    const entry = await getFileEntry(getIndexPath(dataDir, root), "src/c.ts");
    expect(entry?.mtime_ms).toBe(Math.round(statSync(join(worktree, "src", "c.ts")).mtimeMs));
  });
});
