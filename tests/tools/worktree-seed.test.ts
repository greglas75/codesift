// Seeding a linked worktree's index from its parent instead of parsing the tree.
//
// Measured on tgm-survey-platform: the parent index holds 14,891 files, a worktree holds 14,405,
// and they differ by eleven — 0.08%. End to end, the seeded path indexed a real worktree in
// **4,300 ms** (2,809 of them the copy) against **over ten minutes** for the full parse it replaces,
// and afterwards zero of its 237,900 symbol ids still named the parent.
//
// These use a REAL git repository and a REAL `git worktree add`, because every hazard here lives in
// that relationship: what `findWorkingTree` reports, what the id prefix looks like, and what git
// does and does not include in a diff. A mocked worktree would test the mock.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { seedWorktreeIndexFromParent } from "../../src/tools/index-tools/worktree-seed.js";
import { resetConfigCache } from "../../src/config.js";
import { getRepoName } from "../../src/storage/registry.js";

let dataDir: string;
let parentRoot: string;
let worktreeRoot: string;
let prevDataDir: string | undefined;

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

// Derived from the real namer, not hard-coded: getRepoName builds the name from the checkout
// basename, and a worktree gets the "@<worktree>" suffix. Guessing it would test the guess.
let PARENT_NAME: string;
let WT_NAME: string;
const PARENT_HASH = "aaaaaaaaaaaa";

/** A minimal but REAL index database, in the shape the seeder copies. */
function makeParentIndex(dbPath: string, symbolFiles: Array<[string, string]>): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (path TEXT PRIMARY KEY, language TEXT NOT NULL, symbol_count INTEGER NOT NULL,
                        last_modified INTEGER NOT NULL, mtime_ms INTEGER, stale INTEGER);
    CREATE TABLE symbols (id TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
                          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_col INTEGER,
                          end_col INTEGER, start_byte INTEGER, end_byte INTEGER, signature TEXT,
                          docstring TEXT, source TEXT, parent TEXT, is_async INTEGER,
                          is_exported INTEGER, extras TEXT);
  `);
  const m = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  m.run("repo", PARENT_NAME);
  m.run("root", parentRoot);
  m.run("schema_version", "2");
  const f = db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?)");
  const s = db.prepare("INSERT INTO symbols (id,file,name,kind,start_line,end_line) VALUES (?,?,?,?,?,?)");
  for (const [path, name] of symbolFiles) {
    f.run(path, "typescript", 1, 0, 0, 0);
    s.run(`${PARENT_NAME}:${path}:${name}:1`, path, name, "function", 1, 2);
  }
  db.close();
}

function registry(repos: Record<string, unknown>): void {
  writeFileSync(join(dataDir, "registry.json"), JSON.stringify({ repos, updated_at: 1 }));
}

function readRegistry(): Record<string, { root?: string; last_git_commit?: string | null; symbol_count?: number }> {
  return JSON.parse(execFileSync("cat", [join(dataDir, "registry.json")], { encoding: "utf-8" })).repos;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "codesift-seed-data-"));
  parentRoot = mkdtempSync(join(tmpdir(), "codesift-seed-parent-"));
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  resetConfigCache();

  git(["init", "-q", "-b", "main"], parentRoot);
  mkdirSync(join(parentRoot, "src"), { recursive: true });
  writeFileSync(join(parentRoot, "src", "a.ts"), "export function a() {}\n");
  git(["add", "-A"], parentRoot);
  git(["commit", "-q", "-m", "init"], parentRoot);

  worktreeRoot = join(parentRoot, "..", `codesift-seed-wt-${process.pid}`);
  git(["worktree", "add", "-q", "-b", "task", worktreeRoot], parentRoot);

  PARENT_NAME = getRepoName(parentRoot);
  WT_NAME = getRepoName(worktreeRoot);
});

afterEach(() => {
  try { git(["worktree", "remove", "--force", worktreeRoot], parentRoot); } catch { /* already gone */ }
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  resetConfigCache();
  for (const d of [dataDir, parentRoot, worktreeRoot]) rmSync(d, { recursive: true, force: true });
});

const WT_INDEX = () => join(dataDir, "bbbbbbbbbbbb.index.json");

describe("seedWorktreeIndexFromParent", () => {
  it("copies the parent's index and makes every symbol id name the WORKTREE", async () => {
    // One path deliberately CONTAINS the parent repo name, which a naive string replace would
    // corrupt in the middle of the id.
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [
      ["src/a.ts", "a"],
      ["src/PARENT_NAME_MARKER-helpers.ts", "helper"],
    ]);
    registry({
      [PARENT_NAME]: {
        name: PARENT_NAME, root: parentRoot,
        index_path: join(dataDir, `${PARENT_HASH}.index.json`),
        last_git_commit: git(["rev-parse", "HEAD"], parentRoot).trim(),
      },
    });

    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result.seeded).toBe(true);
    expect(result.files).toBe(2);
    expect(result.symbols).toBe(2);

    const db = new DatabaseSync(`file:${join(dataDir, "bbbbbbbbbbbb.index.db")}?mode=ro`, { open: true });
    const ids = (db.prepare("SELECT id FROM symbols ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    const meta = Object.fromEntries(
      (db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
    );
    db.close();

    // ORDER BY id, and uppercase sorts before lowercase in ASCII.
    expect(ids).toEqual([
      `${WT_NAME}:src/PARENT_NAME_MARKER-helpers.ts:helper:1`,
      `${WT_NAME}:src/a.ts:a:1`,
    ]);
    expect(ids.some((id) => id.startsWith(`${PARENT_NAME}:`))).toBe(false);
    expect(meta["repo"]).toBe(WT_NAME);
    expect(meta["root"]).toBe(worktreeRoot);
  });

  it("records the PARENT's commit, not the worktree's HEAD", async () => {
    const parentCommit = git(["rev-parse", "HEAD"], parentRoot).trim();
    // Move the worktree on, so the two commits genuinely differ.
    writeFileSync(join(worktreeRoot, "src", "b.ts"), "export function b() {}\n");
    git(["add", "-A"], worktreeRoot);
    git(["commit", "-q", "-m", "work"], worktreeRoot);
    expect(git(["rev-parse", "HEAD"], worktreeRoot).trim()).not.toBe(parentCommit);

    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    registry({
      [PARENT_NAME]: {
        name: PARENT_NAME, root: parentRoot,
        index_path: join(dataDir, `${PARENT_HASH}.index.json`),
        last_git_commit: parentCommit,
      },
    });

    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result.seeded).toBe(true);
    // The copied content describes the parent at that commit. Recording the worktree's HEAD would
    // make every later diff start from a state the index does not match — and silently miss the
    // very files this worktree exists to change.
    expect(result.seeded_at_commit).toBe(parentCommit);
    expect(readRegistry()[WT_NAME]?.last_git_commit).toBe(parentCommit);
  });

  it("declines when the parent is not indexed", async () => {
    registry({});
    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result.seeded).toBe(false);
    expect(result.reason).toMatch(/not indexed/);
    expect(existsSync(join(dataDir, "bbbbbbbbbbbb.index.db"))).toBe(false);
  });

  it("declines for a directory that is not a linked worktree", async () => {
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    registry({
      [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`) },
    });

    // The parent checkout itself is a working tree, but not a LINKED one.
    const result = await seedWorktreeIndexFromParent(parentRoot, PARENT_NAME, WT_INDEX());

    expect(result.seeded).toBe(false);
    expect(result.reason).toMatch(/not a linked worktree/);
  });

  it("declines when the registry entry describes a different directory", async () => {
    // The name resolves, but to some other tree — copying that index would produce exactly the
    // "confidently describes the wrong repo" state this feature exists to end.
    const elsewhere = mkdtempSync(join(tmpdir(), "codesift-elsewhere-"));
    try {
      makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
      registry({
        [PARENT_NAME]: { name: PARENT_NAME, root: elsewhere, index_path: join(dataDir, `${PARENT_HASH}.index.json`) },
      });

      const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

      expect(result.seeded).toBe(false);
      expect(result.reason).toMatch(/points at/);
      expect(existsSync(join(dataDir, "bbbbbbbbbbbb.index.db"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("leaves no half-copied database when the parent index is empty", async () => {
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), []);
    registry({
      [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`) },
    });

    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result.seeded).toBe(false);
    expect(result.reason).toMatch(/empty/);
    expect(existsSync(join(dataDir, "bbbbbbbbbbbb.index.db"))).toBe(false);
    expect(existsSync(`${join(dataDir, "bbbbbbbbbbbb.index.db")}.seeding.${process.pid}`)).toBe(false);
  });
});
