import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { COMMAND_MAP } from "../../src/cli/commands.js";
import { resetConfigCache } from "../../src/config.js";

const LIVE = "aaaaaaaaaaaa";   // hash present in registry
const ORPH = "bbbbbbbbbbbb";   // hash NOT in registry
const INDETERMINATE = "cccccccccccc";
// A pid that is certainly gone. Pid 2 is `kthreadd` on Linux and answers `kill(pid, 0)`, so a
// hardcoded low number passes on macOS and fails on the farm.
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid as number;

function writeIndexDb(path: string, repo: string, root: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  insert.run("repo", repo);
  insert.run("root", root);
  db.close();
}

describe("codesift prune", () => {
  let dir: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prune-"));
    process.env.CODESIFT_DATA_DIR = dir;
    resetConfigCache();
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { stdout += String(c); return true; });
    // registry lists only the LIVE repo
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: { "local/live": { name: "local/live", index_path: join(dir, `${LIVE}.index.json`) } },
    }));
    // live artifacts
    writeFileSync(join(dir, `${LIVE}.index.json`), "{}");
    writeFileSync(join(dir, `${LIVE}.embeddings.ndjson`), "x\n");
    // orphan artifacts (hash not in registry)
    writeFileSync(join(dir, `${ORPH}.index.json`), "{}");
    writeFileSync(join(dir, `${ORPH}.embeddings.ndjson`), "y\n".repeat(100));
    writeFileSync(join(dir, `${ORPH}.bm25.json`), "{}");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    for (const suffix of ["index.json", "embeddings.ndjson", "bm25.json"]) {
      utimesSync(join(dir, `${ORPH}.${suffix}`), old, old);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODESIFT_DATA_DIR;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes orphan artifacts and keeps live ones", async () => {
    await COMMAND_MAP["prune"]!([], { json: true });
    // orphans gone
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(false);
    expect(existsSync(join(dir, `${ORPH}.index.json`))).toBe(false);
    expect(existsSync(join(dir, `${ORPH}.bm25.json`))).toBe(false);
    // live kept
    expect(existsSync(join(dir, `${LIVE}.embeddings.ndjson`))).toBe(true);
    expect(existsSync(join(dir, `${LIVE}.index.json`))).toBe(true);
    const out = JSON.parse(stdout);
    expect(out.orphan_files).toBe(3);
    expect(out.kept_live_artifacts).toBe(2);
    expect(out.pruned).toBe(true);
  });

  it("collects an abandoned temp half of a LIVE repo", async () => {
    // The gap that let 11.15 GB accumulate here by 2026-09-27. `artifactPattern()` grew a `.tmp.*`
    // arm so these could be reclaimed, and the live-hash check above it made that arm unreachable
    // for any repo still on disk — which was 1,507 of 1,511 registry entries. A temp file is never
    // live data: readers open the target name, never the tail.
    const orphan = join(dir, `${LIVE}.bm25.ndjson.tmp.${DEAD_PID}`);
    writeFileSync(orphan, "z".repeat(1000));
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphan, twoHours, twoHours);
    await COMMAND_MAP["prune"]!([], { json: true });
    expect(existsSync(orphan)).toBe(false);
    // the repo's real artifacts are untouched
    expect(existsSync(join(dir, `${LIVE}.embeddings.ndjson`))).toBe(true);
    expect(existsSync(join(dir, `${LIVE}.index.json`))).toBe(true);
  });

  it("keeps a live repo's temp half while its writer is still running", async () => {
    const inflight = join(dir, `${LIVE}.bm25.ndjson.tmp.${process.pid}`);
    writeFileSync(inflight, "z".repeat(1000));
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(inflight, twoHours, twoHours);
    await COMMAND_MAP["prune"]!([], { json: true });
    expect(existsSync(inflight)).toBe(true);
  });

  it("gives a temp half the sweeper's hour, not the 5-minute artifact grace", async () => {
    // Ten minutes is past the artifact grace and well inside the hour a large write can take.
    const recent = join(dir, `${LIVE}.bm25.ndjson.tmp.${DEAD_PID}`);
    writeFileSync(recent, "z".repeat(1000));
    const tenMin = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(recent, tenMin, tenMin);
    await COMMAND_MAP["prune"]!([], { json: true });
    expect(existsSync(recent)).toBe(true);
  });

  it("checkpoints an oversized write-ahead log that has no writer", async () => {
    // SQLite truncates a `-wal` only when the last connection closes cleanly, and this server's
    // connections often do not — a stdio server exits on disconnect, the daemon has OOM'd, a
    // `launchctl unload` is a signal. Measured 2026-09-27: 1,488 logs holding 4.17 GB that nothing
    // would ever have folded back in.
    const dbPath = join(dir, `${LIVE}.index.db`);
    writeIndexDb(dbPath, "local/live", dir);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE bulk (id INTEGER PRIMARY KEY, blob TEXT)");
    const insert = db.prepare("INSERT INTO bulk (blob) VALUES (?)");
    // One transaction per batch: 4000 autocommits are 4000 fsyncs, past the timeout on a slow farm
    // disk (hz4). The log grows the same either way.
    db.exec("BEGIN");
    for (let i = 0; i < 4000; i++) insert.run("x".repeat(400));
    db.exec("COMMIT");
    db.close();
    // A clean close truncates it, so grow the log with the database closed to get the shape a killed
    // writer leaves: reopen, write without checkpointing, and abandon the handle.
    const second = new DatabaseSync(dbPath);
    second.exec("PRAGMA journal_mode = WAL");
    second.exec("PRAGMA wal_autocheckpoint = 0");
    const more = second.prepare("INSERT INTO bulk (blob) VALUES (?)");
    second.exec("BEGIN");
    for (let i = 0; i < 4000; i++) more.run("y".repeat(400));
    second.exec("COMMIT");
    const wal = `${dbPath}-wal`;
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).size).toBeGreaterThan(64 * 1024);
    second.close();

    await COMMAND_MAP["prune"]!([], { json: true });
    const out = JSON.parse(stdout);
    // Either the abandoned log was folded in here, or SQLite's own close already did it. What must
    // hold is that prune leaves no large orphan log behind, and that the database still reads.
    expect(existsSync(wal) ? statSync(wal).size : 0).toBeLessThan(64 * 1024);
    expect(out.wal_reclaimed_gb).toBeGreaterThanOrEqual(0);
    const check = new DatabaseSync(dbPath);
    expect((check.prepare("SELECT COUNT(*) AS n FROM bulk").get() as { n: number }).n).toBe(8000);
    check.close();
  });

  it("reclaims a BM25 cache written by a superseded format", async () => {
    // A format bump strands every existing file: the loader rejects the old header and rebuilds, but
    // the bytes only go away when that repo is indexed again — never, for a repo nobody touches.
    // Measured at the v1 -> v2 bump: 47.78 GB on this machine, unreadable the moment it changed.
    const stale = join(dir, `${LIVE}.bm25.ndjson`);
    writeFileSync(stale, `${JSON.stringify({ v: 1, docCount: 1 })}\n${"x".repeat(2000)}\n`);
    const old = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(stale, old, old);

    await COMMAND_MAP["prune"]!([], { json: true });
    expect(existsSync(stale)).toBe(false);
    expect(JSON.parse(stdout).bm25_superseded_format).toBe(1);
  });

  it("keeps a BM25 cache in the current format, and one whose header it cannot read", async () => {
    const { bm25FormatVersion } = await import("../../src/search/bm25-store.js");
    const current = join(dir, `${LIVE}.bm25.ndjson`);
    writeFileSync(current, `${JSON.stringify({ v: bm25FormatVersion(), docCount: 1 })}\ndata\n`);
    const garbled = join(dir, `${ORPH.replace("b", "d")}.bm25.ndjson`);
    // Not JSON at all: mid-write, or something this code does not understand. Neither is a reason to
    // delete — and this hash is not in the registry, so only the header check can save it.
    writeFileSync(garbled, "not json at all\n");
    const old = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(current, old, old);
    utimesSync(garbled, old, old);

    await COMMAND_MAP["prune"]!([], { json: true });
    expect(existsSync(current)).toBe(true);
    expect(JSON.parse(stdout).bm25_superseded_format).toBe(0);
  });

  it("--dry-run reports but deletes nothing", async () => {
    await COMMAND_MAP["prune"]!([], { json: true, "dry-run": true });
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(true);
    const out = JSON.parse(stdout);
    expect(out.dry_run).toBe(true);
    expect(out.orphan_files).toBe(3);
  });

  it("removes only older recognized shared-cache versions", async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const v1 = join(dir, "shared-embeddings.v1.ndjson");
    const v2 = join(dir, "shared-embeddings.v2.bin");
    const v3 = join(dir, "shared-embeddings.v3.bin");
    const lock = join(dir, "shared-embeddings.writer.lock");
    for (const path of [v1, v2, v3, lock]) writeFileSync(path, "cache");
    utimesSync(v1, old, old);

    await COMMAND_MAP["prune"]!([], { json: true });

    expect(existsSync(v1)).toBe(false);
    expect(existsSync(v2)).toBe(true);
    expect(existsSync(v3)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  it("preserves live artifacts when stat fails for a reason other than absence", async () => {
    const loop = join(dir, "loop");
    symlinkSync(loop, loop);
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: {
        "local/live": { name: "local/live", root: loop, index_path: join(dir, `${LIVE}.index.json`) },
      },
    }));

    await COMMAND_MAP["prune"]!([], { json: true });

    expect(existsSync(join(dir, `${LIVE}.embeddings.ndjson`))).toBe(true);
    expect(JSON.parse(stdout).stale_repos).toBe(0);
  });

  it("aborts when the registry lists 0 repos (never treats all as orphans)", async () => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ repos: {} }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("die"); }) as never);
    await expect(COMMAND_MAP["prune"]!([], { json: true })).rejects.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      "prune: registry lists 0 repos — aborting (refusing to treat all artifacts as orphans).",
    ));
    // orphan still present — nothing was deleted
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(true);
    exit.mockRestore();
  });

  it("aborts with a specific error when registry.json is unreadable", async () => {
    writeFileSync(join(dir, "registry.json"), "not-json");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("die"); }) as never);

    await expect(COMMAND_MAP["prune"]!([], { json: true })).rejects.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      "prune: cannot read registry.json — aborting so live data is never deleted.",
    ));
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(true);
  });

  it("protects an unregistered database without replacing a live same-name repo", async () => {
    const registeredRoot = join(dir, "registered-root");
    const orphanRoot = join(dir, "orphan-root");
    mkdirSync(registeredRoot);
    mkdirSync(orphanRoot);
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: {
        "local/live": {
          name: "local/live",
          root: registeredRoot,
          index_path: join(dir, `${LIVE}.index.json`),
        },
      },
    }));
    writeIndexDb(join(dir, `${ORPH}.index.db`), "local/live", orphanRoot);

    await COMMAND_MAP["prune"]!([], { json: true });

    const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
    expect(registry.repos["local/live"].root).toBe(registeredRoot);
    expect(existsSync(join(dir, `${ORPH}.index.db`))).toBe(true);
  });

  it("keeps a rescued replacement when the previous same-name root is stale", async () => {
    const rescuedRoot = join(dir, "rescued-root");
    mkdirSync(rescuedRoot);
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: {
        "local/live": {
          name: "local/live",
          root: join(dir, "deleted-worktree"),
          index_path: join(dir, `${LIVE}.index.json`),
        },
      },
    }));
    writeIndexDb(join(dir, `${ORPH}.index.db`), "local/live", rescuedRoot);

    await COMMAND_MAP["prune"]!([], { json: true });

    const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"));
    expect(registry.repos["local/live"]).toMatchObject({
      root: rescuedRoot,
      index_path: join(dir, `${ORPH}.index.json`),
    });
  });

  it("keeps an unreadable database instead of deleting data it cannot classify", async () => {
    writeFileSync(join(dir, `${INDETERMINATE}.index.db`), "not a sqlite database");

    await COMMAND_MAP["prune"]!([], { json: true });

    expect(existsSync(join(dir, `${INDETERMINATE}.index.db`))).toBe(true);
    expect(JSON.parse(stdout).indeterminate_databases).toBe(1);
  });
});
