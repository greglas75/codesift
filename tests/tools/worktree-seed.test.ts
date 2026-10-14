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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { parsePorcelainZ, seedWorktreeIndexFromParent } from "../../src/tools/index-tools/worktree-seed.js";
import { resetConfigCache } from "../../src/config.js";
import { getRepoName } from "../../src/storage/registry.js";
import { canonicalPath } from "../../src/utils/worktree.js";
import { HAS_NODE_SQLITE } from "../helpers/node-sqlite.js";
import { HAS_OVERLAY_WRITES } from "../helpers/overlay-sqlite.js";

const itWithOverlay = HAS_OVERLAY_WRITES ? it : it.skip;

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

/** Rows of the seeded index as every reader sees them: through the overlay's views. */
async function viewRows<T>(sql: string, dbName = "bbbbbbbbbbbb.index.db"): Promise<T[]> {
  const { loadSqliteCtor } = await import("../../src/storage/sqlite/runtime.js");
  const { attachOverlay } = await import("../../src/storage/sqlite/overlay.js");
  const Ctor = (await loadSqliteCtor())!;
  const path = join(dataDir, dbName);
  const db = new Ctor(path);
  try {
    attachOverlay(db, path);
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function baseFilesPath(): string {
  return join(dataDir, baseFiles()[0]!);
}

function baseFiles(): string[] {
  return readdirSync(dataDir).filter((n) => /^base-[0-9a-f]{16}\.db$/.test(n));
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
  // Bug it catches: the seed copying the donor's whole database again, or an overlay whose reads miss
  // the shared rows.
  itWithOverlay("seeds an overlay that reads the parent's rows through a shared base", async () => {
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
    // Shared rows keep the repository's prefix: rewriting ids in the view stops SQLite merging the
    // two halves in rowid order (overlay.ts). The worktree's own rows carry its name.
    const ids = (await viewRows<{ id: string }>("SELECT id FROM symbols ORDER BY id")).map((r) => r.id);
    expect(ids).toEqual([
      `${PARENT_NAME}:src/PARENT_NAME_MARKER-helpers.ts:helper:1`,
      `${PARENT_NAME}:src/a.ts:a:1`,
    ]);
    const meta = Object.fromEntries(
      (await viewRows<{ key: string; value: string }>("SELECT key, value FROM meta")).map((r) => [r.key, r.value]),
    );
    expect(meta["repo"]).toBe(WT_NAME);
    expect(meta["root"]).toBe(worktreeRoot);
    const own = new DatabaseSync(`file:${join(dataDir, "bbbbbbbbbbbb.index.db")}?mode=ro`, { open: true });
    const ownRows = (own.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    own.close();
    expect(ownRows).toBe(0);
    expect(baseFiles()).toHaveLength(1);
  });

  // Bug it catches: each worktree of one commit taking its own snapshot of the donor — the disk cost
  // the overlay exists to remove, merely moved into base files.
  itWithOverlay("gives a second worktree of the same commit the same base", async () => {
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    const head = git(["rev-parse", "HEAD"], parentRoot).trim();
    registry({
      [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`), last_git_commit: head },
    });
    await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());
    const second = join(parentRoot, "..", `codesift-seed-wt2-${process.pid}`);
    git(["worktree", "add", "-q", "-b", "task2", second], parentRoot);
    try {
      const result = await seedWorktreeIndexFromParent(second, getRepoName(second), join(dataDir, "dddddddddddd.index.json"));
      expect(result.seeded).toBe(true);
      expect(baseFiles()).toHaveLength(1);
      expect((await viewRows<{ name: string }>("SELECT name FROM symbols", "dddddddddddd.index.db")).map((r) => r.name)).toEqual(["a"]);
    } finally {
      try { git(["worktree", "remove", "--force", second], parentRoot); } catch { /* already gone */ }
      rmSync(second, { recursive: true, force: true });
    }
  });

  // Bug it catches: a base reused after its donor cleaned up, with the donor's then-uncommitted
  // content still in it and nothing left to say so — the worktree would search a version of a file
  // that exists in no checkout.
  itWithOverlay("revisits the files the base's donor had uncommitted, even after the donor committed nothing", async () => {
    const head = git(["rev-parse", "HEAD"], parentRoot).trim();
    // The parent's index was taken while src/a.ts held uncommitted work.
    writeFileSync(join(parentRoot, "src", "a.ts"), "export function draft() {}\n");
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "draft"]]);
    registry({
      [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`), last_git_commit: head },
    });
    await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());
    git(["checkout", "--", "src/a.ts"], parentRoot);

    const second = join(parentRoot, "..", `codesift-seed-wt3-${process.pid}`);
    git(["worktree", "add", "-q", "-b", "task3", second], parentRoot);
    try {
      const name = getRepoName(second);
      const seed = await seedWorktreeIndexFromParent(second, name, join(dataDir, "eeeeeeeeeeee.index.json"));
      expect(seed.revisit).toContain("src/a.ts");
      const { catchUpSeededWorktree } = await import("../../src/tools/index-tools/worktree-seed.js");
      const caught = await catchUpSeededWorktree(second, name, seed.seeded_at_commit ?? null, seed.files, seed.donor_root, seed.revisit);
      expect(caught.caught_up).toBe(true);
      const names = (await viewRows<{ name: string }>("SELECT name FROM symbols WHERE file = 'src/a.ts'", "eeeeeeeeeeee.index.db"))
        .map((r) => r.name);
      expect(names).toEqual(["a"]);
    } finally {
      try { git(["worktree", "remove", "--force", second], parentRoot); } catch { /* already gone */ }
      rmSync(second, { recursive: true, force: true });
    }
  });

  // Bug it catches: a seed from a sibling overlay that drops the sibling's own changes, or leaves them
  // under the sibling's name.
  itWithOverlay("copies a sibling overlay's changes under the new worktree's name", async () => {
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    const parentHead = git(["rev-parse", "HEAD"], parentRoot).trim();
    registry({
      [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`), last_git_commit: parentHead },
    });
    writeFileSync(join(worktreeRoot, "src", "b.ts"), "export function b() {}\n");
    git(["add", "-A"], worktreeRoot);
    git(["commit", "-q", "-m", "b"], worktreeRoot);
    const seed = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());
    const { catchUpSeededWorktree } = await import("../../src/tools/index-tools/worktree-seed.js");
    const caught = await catchUpSeededWorktree(worktreeRoot, WT_NAME, seed.seeded_at_commit ?? null, seed.files, seed.donor_root, seed.revisit);
    expect(caught.caught_up).toBe(true);

    const second = join(parentRoot, "..", `codesift-seed-wt4-${process.pid}`);
    git(["worktree", "add", "-q", "-b", "task4", second, "task"], parentRoot);
    try {
      const name = getRepoName(second);
      const result = await seedWorktreeIndexFromParent(second, name, join(dataDir, "ffffffffffff.index.json"));
      expect(result.parent_repo).toBe(WT_NAME);
      expect(baseFiles()).toHaveLength(1);
      const ids = (await viewRows<{ id: string }>("SELECT id FROM symbols WHERE file = 'src/b.ts'", "ffffffffffff.index.db"))
        .map((r) => r.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => id.startsWith(`${name}:`))).toBe(true);
      expect(statSync(join(dataDir, "ffffffffffff.index.db")).size).toBeLessThan(statSync(baseFilesPath()).size * 4);
    } finally {
      try { git(["worktree", "remove", "--force", second], parentRoot); } catch { /* already gone */ }
      rmSync(second, { recursive: true, force: true });
    }
  });

  itWithOverlay("records the PARENT's commit, not the worktree's HEAD", async () => {
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

  it("refuses a worktree that has been DELETED, without copying anything first", async () => {
    // Measured 2026-08-30 on the live daemon: three worktrees of tgm-survey-platform were each
    // copied for 42 SECONDS (15,422 files, 243,870 symbols) and the result thrown away, because the
    // catch-up check ran afterwards. All three had been created by an agent and deleted while
    // indexing was running. The caller then fell back to a FULL index — which is what blew through
    // an agent's 120 s ceiling. The check has to happen before the copy, not after it.
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    registry({
      [PARENT_NAME]: {
        name: PARENT_NAME, root: parentRoot,
        index_path: join(dataDir, `${PARENT_HASH}.index.json`),
        last_git_commit: git(["rev-parse", "HEAD"], parentRoot).trim(),
      },
    });
    rmSync(worktreeRoot, { recursive: true, force: true });

    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result.seeded).toBe(false);
    // The wording is the point: "not a git checkout" sent a reader looking for a git fault that did
    // not exist. A vanished tree and a broken checkout need different answers.
    expect(result.reason).toContain("gone");
    expect(existsSync(join(dataDir, "bbbbbbbbbbbb.index.db"))).toBe(false);
  });

  it("refuses a tree git cannot answer for, before copying", async () => {
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    registry({
      [PARENT_NAME]: {
        name: PARENT_NAME, root: parentRoot,
        index_path: join(dataDir, `${PARENT_HASH}.index.json`),
        last_git_commit: git(["rev-parse", "HEAD"], parentRoot).trim(),
      },
    });
    // Break the gitdir link the worktree needs for `git rev-parse` to answer, keeping the directory
    // itself in place — this is the "not a git checkout" case, distinct from a vanished tree.
    writeFileSync(join(worktreeRoot, ".git"), "gitdir: /nowhere/that/exists\n");

    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result.seeded).toBe(false);
    expect(existsSync(join(dataDir, "bbbbbbbbbbbb.index.db"))).toBe(false);
  });

  itWithOverlay("drops the donor's untracked files from the seed during catch-up", async () => {
    // The donor's index holds its working tree, not its commit: a file it has not committed was
    // copied in, and no commit diff mentions it. Left alone it stays searchable here — a symbol for a
    // file that does not exist in this tree.
    writeFileSync(join(parentRoot, "src", "ghost.ts"), "export function ghost() {}\n");
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"], ["src/ghost.ts", "ghost"]]);
    registry({
      [PARENT_NAME]: {
        name: PARENT_NAME, root: parentRoot,
        index_path: join(dataDir, `${PARENT_HASH}.index.json`),
        last_git_commit: git(["rev-parse", "HEAD"], parentRoot).trim(),
      },
    });

    const seed = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());
    expect(seed.seeded).toBe(true);
    expect(seed.donor_root).toBe(parentRoot);

    const { catchUpSeededWorktree } = await import("../../src/tools/index-tools/worktree-seed.js");
    const caught = await catchUpSeededWorktree(
      worktreeRoot, WT_NAME, seed.seeded_at_commit ?? null, seed.files, seed.donor_root,
    );

    expect(caught.caught_up).toBe(true);
    expect(caught.removed).toBe(1);
    const files = (await viewRows<{ file: string }>("SELECT DISTINCT file FROM symbols ORDER BY file")).map((r) => r.file);
    expect(files).toEqual(["src/a.ts"]);
  });

  // Bug: without -z git QUOTES a path holding a space or a non-ASCII byte, so the donor's untracked
  // file matched nothing in this tree and its symbols stayed in the seeded index.
  itWithOverlay("drops a donor file whose name git would quote", async () => {
    const ghost = "src/ghost file é.ts";
    writeFileSync(join(parentRoot, ghost), "export function ghost() {}\n");
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"], [ghost, "ghost"]]);
    registry({
      [PARENT_NAME]: {
        name: PARENT_NAME, root: parentRoot,
        index_path: join(dataDir, `${PARENT_HASH}.index.json`),
        last_git_commit: git(["rev-parse", "HEAD"], parentRoot).trim(),
      },
    });

    const seed = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());
    const { catchUpSeededWorktree } = await import("../../src/tools/index-tools/worktree-seed.js");
    await catchUpSeededWorktree(worktreeRoot, WT_NAME, seed.seeded_at_commit ?? null, seed.files, seed.donor_root);

    const files = (await viewRows<{ file: string }>("SELECT DISTINCT file FROM symbols ORDER BY file")).map((r) => r.file);
    expect(files).toEqual(["src/a.ts"]);
  });

  itWithOverlay("takes vectors from the nearest checkout that HAS them when the index donor has none", async () => {
    // Measured 2026-10-12: a fresh develop worktree seeded its index from a sibling 0 commits back
    // with no vectors, while one 60 commits back held all 462,980 — and got no vectors at all.
    const prevProvider = process.env["CODESIFT_EMBEDDING_PROVIDER"];
    const prevModel = process.env["CODESIFT_OLLAMA_MODEL"];
    process.env["CODESIFT_EMBEDDING_PROVIDER"] = "ollama";
    // The donor's vectors are embeddinggemma's; only a donor of the configured model is cloned.
    process.env["CODESIFT_OLLAMA_MODEL"] = "embeddinggemma";
    resetConfigCache();
    try {
      const head = git(["rev-parse", "HEAD"], parentRoot).trim();
      makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
      const other = join(dataDir, "cccccccccccc.index.json");
      writeFileSync(other.replace(".index.json", ".embeddings.ndjson"), JSON.stringify({ id: "local/other:src/a.ts:a:1", vec: [1, 0] }) + "\n");
      writeFileSync(other.replace(".index.json", ".embeddings.meta.json"), JSON.stringify({
        model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: 1, updated_at: 1,
      }));
      registry({
        [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`), last_git_commit: head },
        // Counts are how a donor shows its vectors cover its index; an entry without them donates nothing.
        "local/other": { name: "local/other", root: join(dataDir, "other"), index_path: other, last_git_commit: head, symbol_count: 1, file_count: 1 },
      });

      const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

      expect(result.seeded).toBe(true);
      // Either cloned, or — on a filesystem without copy-on-write — declined for THAT reason, not
      // because the index donor had none.
      if (result.embeddings && "vectors" in result.embeddings) expect(result.embeddings.vectors).toBe(1);
      else expect(result.embeddings).toEqual({ skipped: expect.stringMatching(/cannot clone/) });
    } finally {
      if (prevProvider === undefined) delete process.env["CODESIFT_EMBEDDING_PROVIDER"];
      else process.env["CODESIFT_EMBEDDING_PROVIDER"] = prevProvider;
      if (prevModel === undefined) delete process.env["CODESIFT_OLLAMA_MODEL"];
      else process.env["CODESIFT_OLLAMA_MODEL"] = prevModel;
      resetConfigCache();
    }
  });

  itWithOverlay("leaves no half-copied database when the parent index is empty", async () => {
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

  // Bug it catches: a seed on a SQLite that refuses `main.` in a TEMP trigger (3.51, Node 22)
  // writing an overlay no write can reach, or failing with "qualified table names are not allowed".
  it.runIf(HAS_NODE_SQLITE && !HAS_OVERLAY_WRITES)("declines on a SQLite that cannot write through an overlay", async () => {
    makeParentIndex(join(dataDir, `${PARENT_HASH}.index.db`), [["src/a.ts", "a"]]);
    registry({
      [PARENT_NAME]: { name: PARENT_NAME, root: parentRoot, index_path: join(dataDir, `${PARENT_HASH}.index.json`) },
    });

    const result = await seedWorktreeIndexFromParent(worktreeRoot, WT_NAME, WT_INDEX());

    expect(result).toEqual({ seeded: false, reason: expect.stringMatching(/cannot write through an overlay/) });
    expect(existsSync(join(dataDir, "bbbbbbbbbbbb.index.db"))).toBe(false);
  });
});

/**
 * A subdirectory of a linked worktree used to become its own repo, named after the basename:
 * `local/src`, `local/apps`, `local/lib`. Two consequences, both measured on this repo:
 *
 *  - the name collides across every checkout on the machine, and each call adds a registry entry
 *    that outlives the tree (the accumulation that once left 1,585 of 1,895 entries pointing at
 *    directories that no longer exist);
 *  - the parent lookup keys off the WORKTREE ROOT, so a subdirectory missed the seed entirely and
 *    fell through to a full parse — 12.0s against 2.0s for the same content.
 *
 * Redirecting beats refusing: the caller wanted their tree indexed, and the worktree root is a
 * superset of the subdirectory, so nothing they asked for is lost.
 */
describe("indexing a subdirectory of a linked worktree", () => {
  it("resolves to the worktree root, not a basename-named repo", async () => {
    const { indexFolder } = await import("../../src/tools/index-tools/folder-indexer.js");

    const base = mkdtempSync(join(tmpdir(), "cs-subdir-"));
    const parent = join(base, "proj");
    mkdirSync(join(parent, "src"), { recursive: true });
    writeFileSync(join(parent, "src", "a.ts"), "export function alpha(): void {}\n");
    git(["init", "-q", "-b", "main"], base);
    git(["init", "-q", "-b", "main"], parent);
    git(["config", "user.email", "t@t"], parent);
    git(["config", "user.name", "t"], parent);
    git(["add", "-A"], parent);
    git(["commit", "-qm", "init"], parent);

    const wt = join(base, "wt");
    git(["worktree", "add", "-q", "-b", "task", wt], parent);

    try {
      const result = await indexFolder(join(wt, "src"), { watch: false });

      // The name is the worktree's, so it groups under the parent and cannot collide with any
      // other repo's `src/`.
      expect(result.repo).toBe(getRepoName(wt));
      expect(result.repo).not.toMatch(/\/src$/);
      // Indexed the tree, not the subdirectory. Compared CANONICALLY: findWorkingTree resolves
      // symlinks, and on macOS the temp dir lives under /var -> /private/var, so the raw strings
      // differ while naming the same directory — the same trap the seed itself documents.
      expect(canonicalPath(result.root)).toBe(canonicalPath(wt));
      // Never silent: the caller asked for a different directory than the one indexed.
      expect(canonicalPath((result as { redirected_from?: string }).redirected_from ?? "")).toBe(
        canonicalPath(join(wt, "src")),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves a subdirectory of an ORDINARY checkout alone", async () => {
    // Someone indexing `~/DEV/monorepo/packages/foo` may mean exactly that. Widening it to the
    // whole monorepo would be a surprise, not a fix — the redirect is for linked worktrees only.
    const { indexFolder } = await import("../../src/tools/index-tools/folder-indexer.js");

    const base = mkdtempSync(join(tmpdir(), "cs-plain-"));
    mkdirSync(join(base, "packages", "foo"), { recursive: true });
    writeFileSync(join(base, "packages", "foo", "b.ts"), "export function beta(): void {}\n");
    git(["init", "-q", "-b", "main"], base);
    git(["config", "user.email", "t@t"], base);
    git(["config", "user.name", "t"], base);
    git(["add", "-A"], base);
    git(["commit", "-qm", "init"], base);

    try {
      const result = await indexFolder(join(base, "packages", "foo"), { watch: false });
      expect(result.root).toBe(join(base, "packages", "foo"));
      expect((result as { redirected_from?: string }).redirected_from).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("parsePorcelainZ", () => {
  // Bug it catches: a rename read as one path "old -> new", so the old path never left the index.
  it.each([
    ["an untracked file with a space", "?? src/a b.ts\0", [{ code: "??", path: "src/a b.ts" }]],
    ["a rename, source after target", "R  src/new.ts\0src/old.ts\0", [{ code: "R ", path: "src/new.ts", from: "src/old.ts" }]],
    ["a deletion", " D src/gone.ts\0", [{ code: " D", path: "src/gone.ts" }]],
    ["a copy, source after target", "C  src/copy.ts\0src/orig.ts\0", [{ code: "C ", path: "src/copy.ts", from: "src/orig.ts" }]],
    ["a nested checkout directory", "?? .worktrees/x/\0", []],
    ["no output", "", []],
  ])("parses %s", (_case, output, expected) => {
    expect(parsePorcelainZ(output)).toEqual(expected);
  });
});
