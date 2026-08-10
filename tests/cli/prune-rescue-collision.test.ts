// `prune` rescues an index database whose registry entry was lost, by reading the database's own
// `meta` table and re-registering it. Two ways that collided with the rest of the command:
//
//  1. `stale[]` — the dead-root entries to de-register — is computed BEFORE the rescue runs. When
//     the rescued database carries the same NAME as one of those dead entries (exactly the state
//     the rescue exists for: a repo re-registered onto a worktree that was later deleted), the
//     de-registration at the end deleted the entry the rescue had just written. Prune reported
//     `rescued_repos: 1` and left nothing behind — and on the NEXT run the artifacts, now
//     unregistered again, were sweepable.
//
//  2. The rescue's guard is keyed by HASH (`live.has(hash)`), but `registerRepo` writes by NAME and
//     replaces the whole entry. A hash absent from the live set says nothing about whether that
//     name is already owned by a healthy repo, so a rescue could repoint a working repo at a
//     different tree and discard its metadata.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { COMMAND_MAP } from "../../src/cli/commands.js";
import { resetConfigCache } from "../../src/config.js";

const HASH_LIVE = "aaaaaaaaaaaa";   // on disk, tree exists, NOT in the registry
const HASH_DEAD = "bbbbbbbbbbbb";   // in the registry, tree deleted
const HASH_OTHER = "cccccccccccc";  // an unrelated live repo, so the "0 repos" guard never fires

function makeDb(path: string, repo: string, root: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  const ins = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  ins.run("repo", repo);
  ins.run("root", root);
  db.close();
}

let dir: string;
let liveRoot: string;
let stdout: string;

function writeRegistry(repos: Record<string, unknown>): void {
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ repos, updated_at: 1 }));
}

async function runPrune(): Promise<Record<string, unknown>> {
  stdout = "";
  await COMMAND_MAP["prune"]!([], { json: true });
  return JSON.parse(stdout) as Record<string, unknown>;
}

const registry = () =>
  JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8")) as {
    repos: Record<string, { root?: string; index_path?: string }>;
  };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-prune-"));
  liveRoot = mkdtempSync(join(tmpdir(), "codesift-livetree-"));
  process.env["CODESIFT_DATA_DIR"] = dir;
  resetConfigCache();
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    stdout += String(c);
    return true;
  });
  writeFileSync(join(dir, `${HASH_OTHER}.index.json`), "{}");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
  rmSync(liveRoot, { recursive: true, force: true });
});

describe("prune rescue vs stale de-registration", () => {
  it("keeps the entry it just rescued, and its artifacts, across two runs", async () => {
    writeRegistry({
      "local/foo": { name: "local/foo", root: join(tmpdir(), "gone-worktree"), index_path: join(dir, `${HASH_DEAD}.index.json`) },
      "local/other": { name: "local/other", root: dir, index_path: join(dir, `${HASH_OTHER}.index.json`) },
    });
    makeDb(join(dir, `${HASH_LIVE}.index.db`), "local/foo", liveRoot);
    makeDb(join(dir, `${HASH_DEAD}.index.db`), "local/foo", join(tmpdir(), "gone-worktree"));
    writeFileSync(join(dir, `${HASH_LIVE}.embeddings.ndjson`), "vectors\n");

    const first = await runPrune();
    expect(first["rescued_repos"]).toBe(1);

    // The rescue must SURVIVE the de-registration in the same run.
    expect(registry().repos["local/foo"]?.root).toBe(liveRoot);

    // And a second run must not undo it — the failure mode was that run 2 saw the artifacts as
    // orphaned and deleted them, which is how a live index becomes garbage.
    await runPrune();
    expect(registry().repos["local/foo"]?.root).toBe(liveRoot);
    expect(existsSync(join(dir, `${HASH_LIVE}.embeddings.ndjson`))).toBe(true);
    expect(existsSync(join(dir, `${HASH_LIVE}.index.db`))).toBe(true);
  });

  it("does not repoint a healthy repo that already owns the rescued name", async () => {
    const healthyRoot = mkdtempSync(join(tmpdir(), "codesift-healthy-"));
    try {
      writeRegistry({
        "local/foo": { name: "local/foo", root: healthyRoot, index_path: join(dir, `${HASH_DEAD}.index.json`) },
        "local/other": { name: "local/other", root: dir, index_path: join(dir, `${HASH_OTHER}.index.json`) },
      });
      // A different database claiming the same name, with a tree that also exists.
      makeDb(join(dir, `${HASH_LIVE}.index.db`), "local/foo", liveRoot);

      await runPrune();

      // The healthy entry keeps its own root; the rescue must not have overwritten it.
      expect(registry().repos["local/foo"]?.root).toBe(healthyRoot);
    } finally {
      rmSync(healthyRoot, { recursive: true, force: true });
    }
  });

  it("does not roll a healthy repo back to an older database for the same root", async () => {
    writeRegistry({
      "local/foo": {
        name: "local/foo",
        root: liveRoot,
        index_path: join(dir, `${HASH_DEAD}.index.json`),
      },
      "local/other": { name: "local/other", root: dir, index_path: join(dir, `${HASH_OTHER}.index.json`) },
    });
    makeDb(join(dir, `${HASH_LIVE}.index.db`), "local/foo", liveRoot);

    await runPrune();

    expect(registry().repos["local/foo"]?.index_path).toBe(join(dir, `${HASH_DEAD}.index.json`));
  });

  it("protects a database whose metadata is incomplete", async () => {
    const path = join(dir, `${HASH_LIVE}.index.db`);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.close();
    writeRegistry({
      "local/other": { name: "local/other", root: dir, index_path: join(dir, `${HASH_OTHER}.index.json`) },
    });

    await runPrune();

    expect(existsSync(path)).toBe(true);
  });

  it("still de-registers a dead entry nobody rescued", async () => {
    writeRegistry({
      "local/dead": { name: "local/dead", root: join(tmpdir(), "gone-for-good"), index_path: join(dir, `${HASH_DEAD}.index.json`) },
      "local/other": { name: "local/other", root: dir, index_path: join(dir, `${HASH_OTHER}.index.json`) },
    });

    const out = await runPrune();

    expect(out["stale_repos"]).toBe(1);
    expect(registry().repos["local/dead"]).toBeUndefined();
    expect(registry().repos["local/other"]).toBeDefined();
  });
});
