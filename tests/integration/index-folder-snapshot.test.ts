import { mkdtemp, rm, writeFile, mkdir, readFile, utimes, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  indexFolder,
  getCodeIndex,
  resetIndexFolderRedundancyForTesting,
  stopAllWatchersForTesting,
  drainLegacyHashQueue,
} from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { resetSecretCache } from "../../src/tools/secret-tools.js";
import { getIndexPath } from "../../src/storage/index-store.js";
import { getSnapshotPath, type FileHashSnapshot } from "../../src/storage/hash-snapshot.js";

let tmpDir: string;
let fixtureDir: string;

// Saved-and-cleared embedding env so background embedding never fires during
// these tests (keeps them fast + deterministic; snapshot logic is independent).
const EMBED_ENV_KEYS = [
  "CODESIFT_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "CODESIFT_VOYAGE_API_KEY",
  "VOYAGE_API_KEY",
  "CODESIFT_OLLAMA_URL",
  "OLLAMA_URL",
  "CODESIFT_EMBEDDING_PROVIDER",
];
const savedEmbedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of EMBED_ENV_KEYS) {
    savedEmbedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "true";

  tmpDir = await mkdtemp(join(tmpdir(), "codesift-snap-"));
  fixtureDir = join(tmpDir, "test-project");
  await mkdir(fixtureDir, { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  resetSecretCache();
  resetIndexFolderRedundancyForTesting();
  await stopAllWatchersForTesting();
});

afterEach(async () => {
  await stopAllWatchersForTesting();
  delete process.env["CODESIFT_DATA_DIR"];
  delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  for (const k of EMBED_ENV_KEYS) {
    if (savedEmbedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEmbedEnv[k];
  }
  resetConfigCache();
  resetSecretCache();
  resetIndexFolderRedundancyForTesting();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fixtureDir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
}

function snapshotPathFor(): string {
  const dataDir = join(tmpDir, ".codesift");
  const indexPath = getIndexPath(dataDir, fixtureDir);
  return getSnapshotPath(indexPath);
}

async function readSnapshot(): Promise<FileHashSnapshot> {
  const raw = await readFile(snapshotPathFor(), "utf-8");
  return JSON.parse(raw) as FileHashSnapshot;
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

const A_TS = `export function alpha(): number { return 1; }\n`;
const B_TS = `export function beta(): number { return 2; }\n`;
const C_TS = `export function gamma(): number { return 3; }\n`;

describe("indexFolder persistent snapshot diff", () => {
  it("(a) first index creates a snapshot file with sha1 per indexed file", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });

    await indexFolder(fixtureDir, { watch: false });

    const snap = await readSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.repo).toBe("local/test-project");
    expect(typeof snap.created_at).toBe("number");

    // CRITICAL-2: on a fresh full write the snapshot's created_at equals the
    // index's serialized updated_at exactly (not a later Date.now()).
    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);
    const rawIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      updated_at: number;
    };
    expect(snap.created_at).toBe(rawIndex.updated_at);

    // Both files present, keyed by relative path, with their actual sha1.
    expect(snap.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap.files["src/b.ts"]).toBe(sha1(B_TS));
    expect(Object.keys(snap.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("(toctou) snapshot sha1 equals sha1 of the exact on-disk bytes that were parsed", async () => {
    // CRITICAL-1: the snapshot sha must be derived from the same source string
    // parseOneFile fed to the extractor — never a post-parse re-read. We assert
    // the contract structurally: read the bytes back off disk and confirm the
    // snapshot value matches their sha1 for every parsed (new) file. A double
    // read would only diverge under a concurrent modification, but the contract
    // is that the snapshot is hash-of-parsed-source, which this pins down.
    const files = {
      "src/a.ts": A_TS,
      "src/b.ts": B_TS,
      "src/nested/c.ts": C_TS,
    };
    await writeFiles(files);

    await indexFolder(fixtureDir, { watch: false });

    const snap = await readSnapshot();
    for (const rel of Object.keys(files)) {
      const onDisk = await readFile(join(fixtureDir, rel), "utf-8");
      expect(snap.files[rel]).toBe(sha1(onDisk));
    }
  });

  it("(b) second index with no changes reuses everything (stable counts + entry mtimes)", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });

    const r1 = await indexFolder(fixtureDir, { watch: false });
    const idx1 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const symbols1 = idx1!.symbols.map((s) => s.id).sort();
    const lm1 = new Map(idx1!.files.map((f) => [f.path, f.last_modified]));

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, { watch: false });
    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const symbols2 = idx2!.symbols.map((s) => s.id).sort();
    const lm2 = new Map(idx2!.files.map((f) => [f.path, f.last_modified]));

    expect(r2.file_count).toBe(r1.file_count);
    expect(r2.symbol_count).toBe(r1.symbol_count);
    expect(symbols2).toEqual(symbols1);

    // Reused-via-mtime files keep their original FileEntry.last_modified
    // (re-parsed files would have stamped a new Date.now()).
    for (const [path, lm] of lm1) {
      expect(lm2.get(path)).toBe(lm);
    }
  });

  it("(c) modifying one file re-parses only that file", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    const idx1 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const bLm1 = idx1!.files.find((f) => f.path === "src/b.ts")!.last_modified;

    // Change a.ts content (new symbol). Advance mtime deterministically so the
    // change is visible to the mtime-fast-path (same pattern as test d).
    const aPath = join(fixtureDir, "src/a.ts");
    const newAContent = `export function alphaRenamed(): number { return 42; }\n`;
    await writeFile(aPath, newAContent);
    const future = new Date(Date.now() + 60_000);
    await utimes(aPath, future, future);

    resetIndexFolderRedundancyForTesting();
    await indexFolder(fixtureDir, { watch: false });

    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const names = idx2!.symbols.map((s) => s.name);
    expect(names).toContain("alphaRenamed");
    expect(names).not.toContain("alpha");

    // b.ts was untouched → its entry must be reused (last_modified unchanged).
    const bLm2 = idx2!.files.find((f) => f.path === "src/b.ts")!.last_modified;
    expect(bLm2).toBe(bLm1);
  });

  it("(d) touching a file without content change does NOT re-parse it", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    const idx1 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const aLm1 = idx1!.files.find((f) => f.path === "src/a.ts")!.last_modified;
    const bLm1 = idx1!.files.find((f) => f.path === "src/b.ts")!.last_modified;
    const aMtime1 = idx1!.files.find((f) => f.path === "src/a.ts")!.mtime_ms;

    // Touch a.ts into the future WITHOUT changing content — mtime-only logic
    // would have re-parsed it; sha1 short-circuit must keep it.
    const future = new Date(Date.now() + 60_000);
    const futureMtime = Math.round(future.getTime());
    await utimes(join(fixtureDir, "src/a.ts"), future, future);

    resetIndexFolderRedundancyForTesting();
    await indexFolder(fixtureDir, { watch: false });

    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const aLm2 = idx2!.files.find((f) => f.path === "src/a.ts")!.last_modified;
    const bLm2 = idx2!.files.find((f) => f.path === "src/b.ts")!.last_modified;

    // Neither file re-parsed → entries stable.
    expect(aLm2).toBe(aLm1);
    expect(bLm2).toBe(bLm1);

    // Symbols intact.
    const names = idx2!.symbols.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");

    // FIX-2 (touch must not degrade the fast path forever): the sha-match reuse
    // branch reused a.ts's symbols but must have refreshed the persisted
    // mtime_ms to the touched (future) mtime — NOT left the original. If the old
    // mtime were carried, every future run would re-hash a.ts since mtime would
    // never match prevMtime again. Read the SAVED index JSON (not the in-memory
    // FileEntry, which may differ) and assert the touched mtime landed.
    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);
    const savedIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      files: Array<{ path: string; mtime_ms?: number }>;
    };
    const aEntrySaved = savedIndex.files.find((f) => f.path === "src/a.ts")!;
    expect(aEntrySaved.mtime_ms).toBe(futureMtime);
    expect(aEntrySaved.mtime_ms).not.toBe(aMtime1);

    // Strongest signal: a THIRD run now takes the mtime FAST path (mtime ===
    // prevMtime), so a.ts is reused WITHOUT hashing and its entry stays stable.
    // (With the bug, run 3 would again see mtime !== prevMtime and re-hash.)
    resetIndexFolderRedundancyForTesting();
    await indexFolder(fixtureDir, { watch: false });

    const idx3 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const aLm3 = idx3!.files.find((f) => f.path === "src/a.ts")!.last_modified;
    const bLm3 = idx3!.files.find((f) => f.path === "src/b.ts")!.last_modified;
    expect(aLm3).toBe(aLm1);
    expect(bLm3).toBe(bLm1);

    const savedIndex3 = JSON.parse(await readFile(indexPath, "utf-8")) as {
      files: Array<{ path: string; mtime_ms?: number }>;
    };
    const aEntrySaved3 = savedIndex3.files.find((f) => f.path === "src/a.ts")!;
    expect(aEntrySaved3.mtime_ms).toBe(futureMtime);

    const names3 = idx3!.symbols.map((s) => s.name);
    expect(names3).toContain("alpha");
    expect(names3).toContain("beta");
  });

  it("(e) deleting a file drops it from the index on next run", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS, "src/c.ts": C_TS });
    const r1 = await indexFolder(fixtureDir, { watch: false });
    expect(r1.file_count).toBe(3);

    await rm(join(fixtureDir, "src/b.ts"));

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.file_count).toBe(2);

    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const files = idx2!.files.map((f) => f.path);
    expect(files).not.toContain("src/b.ts");
    const names = idx2!.symbols.map((s) => s.name);
    expect(names).not.toContain("beta");

    // Snapshot must no longer reference the deleted file.
    const snap = await readSnapshot();
    expect(snap.files["src/b.ts"]).toBeUndefined();
  });

  it("(f) corrupt snapshot → full re-parse, no throw, snapshot rewritten valid", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    // Corrupt the snapshot file.
    await writeFile(snapshotPathFor(), "{ this is not valid json ");

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.file_count).toBe(2);
    expect(r2.symbol_count).toBeGreaterThan(0);

    // Snapshot rewritten valid afterwards.
    const snap = await readSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap.files["src/b.ts"]).toBe(sha1(B_TS));
  });

  it("(b-branch) new file added between runs is parsed and appears in snapshot", async () => {
    // First index: only a.ts + b.ts
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    const r1 = await indexFolder(fixtureDir, { watch: false });
    expect(r1.file_count).toBe(2);

    const idx1 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const aLm1 = idx1!.files.find((f) => f.path === "src/a.ts")!.last_modified;
    const bLm1 = idx1!.files.find((f) => f.path === "src/b.ts")!.last_modified;

    // Add a new file c.ts — not present in the old snapshot (snapSha undefined).
    await writeFiles({ "src/c.ts": C_TS });

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.file_count).toBe(3);

    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });

    // c.ts was parsed → its symbol is present.
    const names = idx2!.symbols.map((s) => s.name);
    expect(names).toContain("gamma");

    // a.ts and b.ts were reused (last_modified unchanged).
    const aLm2 = idx2!.files.find((f) => f.path === "src/a.ts")!.last_modified;
    const bLm2 = idx2!.files.find((f) => f.path === "src/b.ts")!.last_modified;
    expect(aLm2).toBe(aLm1);
    expect(bLm2).toBe(bLm1);

    // Snapshot contains c.ts with a real sha1.
    const snap = await readSnapshot();
    expect(snap.files["src/c.ts"]).toBe(sha1(C_TS));
    expect(snap.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap.files["src/b.ts"]).toBe(sha1(B_TS));
  });

  it("(c-branch) file missing from saved index mtimeMap is re-parsed cleanly", async () => {
    // First full index.
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    // Surgically remove src/b.ts from the saved index's files[] so mtimeMap
    // has no entry for it on the next run — exercises the "prevMtime undefined"
    // branch where the file falls through to filesToParse.
    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);
    const rawIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      files: Array<{ path: string }>;
      symbols: Array<{ file: string }>;
    };
    rawIndex.files = rawIndex.files.filter((f) => f.path !== "src/b.ts");
    // Leave b.ts symbols untouched (the point is the missing mtimeMap entry)
    await writeFile(indexPath, JSON.stringify(rawIndex));

    resetIndexFolderRedundancyForTesting();
    // Must not throw even though mtimeMap has no entry for src/b.ts.
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.file_count).toBe(2);

    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const files = idx2!.files.map((f) => f.path);
    expect(files).toContain("src/b.ts");

    const names = idx2!.symbols.map((s) => s.name);
    expect(names).toContain("beta");
  });

  it.skipIf(process.getuid?.() === 0)(
    "(a-branch) unreadable file mid-walk is skipped without throwing",
    async () => {
      await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
      await indexFolder(fixtureDir, { watch: false });

      const bPath = join(fixtureDir, "src/b.ts");
      // Advance mtime so mtime-fast-path doesn't reuse b.ts — forces it down
      // the sha1 branch where a read error can surface during sha1OfFile.
      const future = new Date(Date.now() + 60_000);

      try {
        await utimes(bPath, future, future);
        await chmod(bPath, 0o000);

        resetIndexFolderRedundancyForTesting();
        // Must not throw even though src/b.ts is unreadable.
        const r2 = await indexFolder(fixtureDir, { watch: false });
        // a.ts is still indexed (1 file at minimum); b.ts may be 0 or 1
        // depending on whether the walker itself skips it or the parser does.
        expect(r2.file_count).toBeGreaterThanOrEqual(1);
      } finally {
        await chmod(bPath, 0o644);
      }
    },
  );

  it("(d-branch) snapshot write failure is non-fatal and warns", async () => {
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    // Determine the snapshot path and replace it with a DIRECTORY.
    // atomicWriteFile will fail with EISDIR when trying to rename the tmp
    // file over a directory — triggering the catch+warn in index-tools.ts.
    const snapPath = snapshotPathFor();
    await rm(snapPath, { force: true });
    await mkdir(snapPath, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetIndexFolderRedundancyForTesting();
      const r2 = await indexFolder(fixtureDir, { watch: false });

      // Index completes normally — the snapshot failure is non-fatal.
      expect(r2.file_count).toBe(2);
      expect(r2.symbol_count).toBeGreaterThan(0);

      // The warn was emitted with the expected prefix.
      const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
      const hasSnapshotWarn = warnCalls.some((msg) =>
        msg.startsWith("[codesift] hash-snapshot save failed"),
      );
      expect(hasSnapshotWarn).toBe(true);
    } finally {
      warnSpy.mockRestore();
      // Clean up the directory so afterEach rm -rf succeeds cleanly.
      await rm(snapPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("(h) legacy upgrade (no snapshot) reuses mtime-unchanged files AND rebuilds a complete snapshot", async () => {
    // CRITICAL-1: simulate an index produced before snapshots existed by
    // indexing, then DELETING the snapshot. The next run takes the
    // mtime-unchanged fast path for every file and must hash them (deferred,
    // in batches) to converge to a complete snapshot — without re-parsing.
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS, "src/c.ts": C_TS });
    await indexFolder(fixtureDir, { watch: false });

    const idx1 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const lm1 = new Map(idx1!.files.map((f) => [f.path, f.last_modified]));

    // Drop the snapshot → legacy (snapshot-less) index on disk.
    await rm(snapshotPathFor(), { force: true });

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.file_count).toBe(3);

    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const lm2 = new Map(idx2!.files.map((f) => [f.path, f.last_modified]));

    // All files reused via the mtime fast path → last_modified stable
    // (re-parsed files would carry a fresh Date.now() stamp).
    for (const [path, lm] of lm1) {
      expect(lm2.get(path)).toBe(lm);
    }

    // Snapshot rebuilt complete with the correct sha1 per file.
    const snap = await readSnapshot();
    expect(snap.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap.files["src/b.ts"]).toBe(sha1(B_TS));
    expect(snap.files["src/c.ts"]).toBe(sha1(C_TS));
    expect(Object.keys(snap.files).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("(i) snapshot older than the index is rebuilt (stale-snapshot guard) and correctness is preserved", async () => {
    // CRITICAL-2: if the index's updated_at is NEWER than the snapshot's
    // created_at (e.g. an incremental saveIncremental landed but the snapshot
    // save failed afterwards), the on-disk snapshot is stale and may carry
    // wrong SHAs. The load-time guard must discard it and rebuild.
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    // Read the index updated_at, then backdate the snapshot's created_at to
    // 10s BEFORE it → snapshot.created_at < index.updated_at → guard fires.
    const rawIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      updated_at: number;
    };
    const snap = await readSnapshot();
    const staleSnap = { ...snap, created_at: rawIndex.updated_at - 10_000 };
    await writeFile(snapshotPathFor(), JSON.stringify(staleSnap));

    // Touch a.ts (mtime bump, identical content) so it goes down the
    // changed-mtime path. With a TRUSTED stale snapshot the sha could be
    // wrongly carried; with the guard the snapshot is discarded and a.ts is
    // hashed fresh / converged via the legacy hash-now path.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(fixtureDir, "src/a.ts"), future, future);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetIndexFolderRedundancyForTesting();
      const r2 = await indexFolder(fixtureDir, { watch: false });
      expect(r2.file_count).toBe(2);

      // One info/warn line about the stale snapshot was emitted.
      const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
      const hasStaleWarn = warnCalls.some((msg) =>
        msg.includes("hash-snapshot older than index"),
      );
      expect(hasStaleWarn).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    // Symbols for unchanged content stay intact (correctness preserved).
    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const names = idx2!.symbols.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");

    // CRITICAL-2: snapshot rebuilt with created_at EQUAL to the index's
    // updated_at (anchored to the exact serialized timestamp, not a fresh
    // Date.now() that could land before a concurrent saveIncremental). On a
    // fresh full write the two are identical, so any later incremental strictly
    // advances updated_at past created_at and re-arms the staleness guard.
    const rawIndex2 = JSON.parse(await readFile(indexPath, "utf-8")) as {
      updated_at: number;
    };
    const snap2 = await readSnapshot();
    expect(snap2.created_at).toBe(rawIndex2.updated_at);
    expect(snap2.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap2.files["src/b.ts"]).toBe(sha1(B_TS));
  });

  it("(i-future) snapshot with created_at NEWER than the index is also rebuilt", async () => {
    // FIX-3: the staleness guard uses strict inequality (!==), so a snapshot
    // whose created_at is in the FUTURE relative to the index's updated_at is
    // just as untrustworthy as a stale one (e.g. a snapshot written against a
    // later, since-rolled-back index, or clock skew). It must be discarded and
    // rebuilt — the fresh-write contract is created_at === updated_at exactly.
    await writeFiles({ "src/a.ts": A_TS, "src/b.ts": B_TS });
    await indexFolder(fixtureDir, { watch: false });

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    // Forward-date the snapshot's created_at to 10s AFTER the index's
    // updated_at → created_at !== updated_at → guard fires.
    const rawIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      updated_at: number;
    };
    const snap = await readSnapshot();
    const futureSnap = { ...snap, created_at: rawIndex.updated_at + 10_000 };
    await writeFile(snapshotPathFor(), JSON.stringify(futureSnap));

    // Touch a.ts (mtime bump, identical content) so it goes down the
    // changed-mtime path. With a TRUSTED future snapshot the sha could be
    // wrongly carried; with the guard the snapshot is discarded and a.ts is
    // converged via the legacy hash-now path.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(fixtureDir, "src/a.ts"), future, future);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetIndexFolderRedundancyForTesting();
      const r2 = await indexFolder(fixtureDir, { watch: false });
      expect(r2.file_count).toBe(2);

      const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
      const hasStaleWarn = warnCalls.some((msg) =>
        msg.includes("hash-snapshot older than index"),
      );
      expect(hasStaleWarn).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    // Correctness preserved + snapshot rebuilt with created_at === updated_at.
    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const names = idx2!.symbols.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");

    const rawIndex2 = JSON.parse(await readFile(indexPath, "utf-8")) as {
      updated_at: number;
    };
    const snap2 = await readSnapshot();
    expect(snap2.created_at).toBe(rawIndex2.updated_at);
    expect(snap2.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap2.files["src/b.ts"]).toBe(sha1(B_TS));
  });

  // ── drainLegacyHashQueue unit tests ─────────────────────────────────────────
  // These tests exercise the TOCTOU mtime-drift guard directly on the extracted
  // helper, bypassing the full indexFolder pipeline. We use an injectable hashFn
  // so we can simulate a concurrent write (the hashFn writes new content to the
  // file AND returns the sha of the OLD content — exactly what a real race would
  // produce) without needing real inter-process concurrency.

  describe("drainLegacyHashQueue TOCTOU guard", () => {
    it("stable file (mtime unchanged after hash) → entry included in result", async () => {
      const filePath = join(fixtureDir, "stable.ts");
      await writeFile(filePath, A_TS);
      const st = await import("node:fs/promises").then((m) => m.stat(filePath));
      const decisionMtime = Math.round(st.mtimeMs);

      const result = await drainLegacyHashQueue([
        { relPath: "stable.ts", filePath, mtimeMs: decisionMtime },
      ]);

      expect(result["stable.ts"]).toBe(sha1(A_TS));
    });

    it("concurrent write (mtime drifted between decision and hash) → entry OMITTED", async () => {
      const filePath = join(fixtureDir, "racy.ts");
      await writeFile(filePath, A_TS);
      const st = await import("node:fs/promises").then((m) => m.stat(filePath));
      const decisionMtime = Math.round(st.mtimeMs);

      // hashFn simulates a concurrent write: it modifies the file content and
      // bumps its mtime, then returns the sha of the OLD content — exactly what
      // sha1OfFile would return if it read the file just before the write landed
      // and a subsequent stat sees the post-write mtime.
      const oldSha = sha1(A_TS);
      const hashFn = async (p: string): Promise<string | null> => {
        // Write new content + advance mtime so re-stat returns a newer mtime.
        await writeFile(p, B_TS);
        const future = new Date(Date.now() + 5_000);
        const { utimes: ut } = await import("node:fs/promises");
        await ut(p, future, future);
        // Return sha of OLD content — simulates "read before write completed".
        return oldSha;
      };

      const result = await drainLegacyHashQueue(
        [{ relPath: "racy.ts", filePath, mtimeMs: decisionMtime }],
        hashFn,
      );

      // Guard must omit the entry — mtime drifted → no sha stored → next run
      // re-parses rather than reusing old symbols against new-content sha.
      expect(result["racy.ts"]).toBeUndefined();
    });

    it("stat fails after hash (file deleted mid-run) → entry OMITTED", async () => {
      const filePath = join(fixtureDir, "gone.ts");
      await writeFile(filePath, A_TS);
      const st = await import("node:fs/promises").then((m) => m.stat(filePath));
      const decisionMtime = Math.round(st.mtimeMs);

      // hashFn deletes the file so the subsequent stat in drainLegacyHashQueue
      // throws ENOENT → statFn returns null → entry omitted.
      const hashFn = async (p: string): Promise<string | null> => {
        const { rm: rmFile } = await import("node:fs/promises");
        await rmFile(p, { force: true });
        return sha1(A_TS);
      };

      const result = await drainLegacyHashQueue(
        [{ relPath: "gone.ts", filePath, mtimeMs: decisionMtime }],
        hashFn,
      );

      expect(result["gone.ts"]).toBeUndefined();
    });

    it("mixed batch: stable entry included, racy entry omitted", async () => {
      const stablePath = join(fixtureDir, "s.ts");
      const racyPath = join(fixtureDir, "r.ts");
      await writeFile(stablePath, A_TS);
      await writeFile(racyPath, B_TS);
      const { stat: fsStat } = await import("node:fs/promises");
      const stableMtime = Math.round((await fsStat(stablePath)).mtimeMs);
      const racyMtime = Math.round((await fsStat(racyPath)).mtimeMs);

      const racySha = sha1(B_TS);
      const hashFn = async (p: string): Promise<string | null> => {
        if (p === racyPath) {
          // Simulate write + mtime bump on racy file.
          await writeFile(p, C_TS);
          const future = new Date(Date.now() + 5_000);
          const { utimes: ut } = await import("node:fs/promises");
          await ut(p, future, future);
          return racySha; // old sha
        }
        // Stable file: just return real sha without modification.
        const { readFile: rf } = await import("node:fs/promises");
        const content = await rf(p, "utf-8");
        return createHash("sha1").update(content).digest("hex");
      };

      const result = await drainLegacyHashQueue(
        [
          { relPath: "s.ts", filePath: stablePath, mtimeMs: stableMtime },
          { relPath: "r.ts", filePath: racyPath, mtimeMs: racyMtime },
        ],
        hashFn,
      );

      expect(result["s.ts"]).toBe(sha1(A_TS));
      expect(result["r.ts"]).toBeUndefined();
    });
  });

  it("(g) DROP-guard rejection preserves the old snapshot", async () => {
    // Seed a full index + snapshot of >50 files so the sanity guard arms.
    const seed: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      seed[`src/f${i}.ts`] = `export function fn${i}(): number { return ${i}; }\n`;
    }
    await writeFiles(seed);
    const r1 = await indexFolder(fixtureDir, { watch: false });
    expect(r1.file_count).toBe(60);

    const snapBefore = await readFile(snapshotPathFor(), "utf-8");

    // Trigger a genuine shrink WITHOUT using include_paths (which would now skip
    // the guard). Instead, add a .codesiftignore that excludes 59 of the 60
    // src/fN.ts files — leaving only src/f0.ts visible to the walker.
    // All 60 source files remain ON DISK so isExistingIndexStale returns false
    // (most sampled paths still exist) → the guard fires → rejected_partial.
    //
    // walkDirectory reads .codesiftignore via indexFolder's pre-walk read and
    // passes the patterns as excludePatterns to walkDirectory, which uses
    // picomatch to filter them. Excluding src/f[1-9]*.ts + src/f[1-5]?.ts
    // covers f1–f59 while leaving f0.ts (matches none of the patterns).
    const excludeLines = [
      "src/f[1-9].ts",   // f1–f9
      "src/f[1-5]?.ts",  // f10–f59
    ];
    await writeFile(
      join(fixtureDir, ".codesiftignore"),
      excludeLines.join("\n") + "\n",
    );

    resetIndexFolderRedundancyForTesting();
    // Full unrestricted walk — no include_paths, no max_files cap.
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.status).toBe("rejected_partial");

    // Old snapshot left byte-for-byte intact.
    const snapAfter = await readFile(snapshotPathFor(), "utf-8");
    expect(snapAfter).toBe(snapBefore);
  });

  // ── Task 7 guard-skip tests ──────────────────────────────────────────────

  it("(j) capped walk (max_files hit) does NOT trigger rejected_partial", async () => {
    // Seed 4 files, full index baseline.
    await writeFiles({
      "src/a.ts": A_TS,
      "src/b.ts": B_TS,
      "src/c.ts": C_TS,
      "src/d.ts": `export function delta(): number { return 4; }\n`,
    });
    await indexFolder(fixtureDir, { watch: false });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resetIndexFolderRedundancyForTesting();
      // Re-run with max_files:1 — the walker will hit the cap and return only
      // 1 file, far below 50% of the 4-file baseline. The guard MUST be skipped.
      const r2 = await indexFolder(fixtureDir, { max_files: 1, watch: false });

      // Must not be rejected.
      expect(r2.status).not.toBe("rejected_partial");
      expect(r2.status).toBeUndefined();

      // The skip note was logged.
      const errCalls = errSpy.mock.calls.map((args) => String(args[0]));
      const hasSkipNote = errCalls.some((msg) =>
        msg.includes("sanity guard skipped") && msg.includes("max_files"),
      );
      expect(hasSkipNote).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("(k) scoped walk (include_paths) MERGE-preserves out-of-scope files in index + snapshot", async () => {
    // Seed 4 files; the "sub" subdir contains only 1 of them. The other 3 live
    // under src/ and are OUT OF SCOPE for an include_paths=["sub"] walk.
    await writeFiles({
      "src/a.ts": A_TS,
      "src/b.ts": B_TS,
      "sub/c.ts": C_TS,
      "src/d.ts": `export function delta(): number { return 4; }\n`,
    });
    await indexFolder(fixtureDir, { watch: false });

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    // Edit the in-scope file so the scoped walk re-parses it (new symbol).
    const cPath = join(fixtureDir, "sub/c.ts");
    const newC = `export function gammaUpdated(): number { return 33; }\n`;
    await writeFile(cPath, newC);
    const future = new Date(Date.now() + 60_000);
    await utimes(cPath, future, future);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resetIndexFolderRedundancyForTesting();
      // Scoped to "sub" — only sub/c.ts is visited (1 of 4 = 25%), but the guard
      // must be skipped AND out-of-scope files merge-preserved.
      const r2 = await indexFolder(fixtureDir, {
        include_paths: ["sub"],
        watch: false,
      });

      // Not rejected.
      expect(r2.status).not.toBe("rejected_partial");
      expect(r2.status).toBeUndefined();
      // Result reflects the MERGED index — full file count, not the 1 walked.
      expect(r2.file_count).toBe(4);

      // The skip note was logged.
      const errCalls = errSpy.mock.calls.map((args) => String(args[0]));
      const hasSkipNote = errCalls.some((msg) =>
        msg.includes("sanity guard skipped") && msg.includes("include_paths"),
      );
      expect(hasSkipNote).toBe(true);
    } finally {
      errSpy.mockRestore();
    }

    // Saved index: full file count, out-of-scope symbols STILL queryable, the
    // in-scope file refreshed to its new symbol.
    const savedIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      file_count: number;
      files: Array<{ path: string }>;
      symbols: Array<{ name: string; file: string }>;
    };
    expect(savedIndex.file_count).toBe(4);
    const savedPaths = savedIndex.files.map((f) => f.path).sort();
    expect(savedPaths).toEqual(["src/a.ts", "src/b.ts", "src/d.ts", "sub/c.ts"]);
    const savedNames = savedIndex.symbols.map((s) => s.name);
    // Out-of-scope symbols preserved verbatim.
    expect(savedNames).toContain("alpha");
    expect(savedNames).toContain("beta");
    expect(savedNames).toContain("delta");
    // In-scope file refreshed: new symbol present, old gone.
    expect(savedNames).toContain("gammaUpdated");
    expect(savedNames).not.toContain("gamma");

    // getCodeIndex (in-memory path) agrees — out-of-scope still searchable.
    const idx2 = await getCodeIndex("local/test-project", { skipFreshness: true });
    const liveNames = idx2!.symbols.map((s) => s.name);
    expect(liveNames).toContain("alpha");
    expect(liveNames).toContain("gammaUpdated");

    // Snapshot: BOTH out-of-scope OLD shas and new in-scope sha present.
    const snapAfter = await readSnapshot();
    expect(snapAfter.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snapAfter.files["src/b.ts"]).toBe(sha1(B_TS));
    expect(snapAfter.files["src/d.ts"]).toBe(
      sha1(`export function delta(): number { return 4; }\n`),
    );
    expect(snapAfter.files["sub/c.ts"]).toBe(sha1(newC));
    expect(Object.keys(snapAfter.files).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/d.ts",
      "sub/c.ts",
    ]);

    // created_at === updated_at contract holds on the merged write.
    const rawIndex2 = JSON.parse(await readFile(indexPath, "utf-8")) as {
      updated_at: number;
    };
    expect(snapAfter.created_at).toBe(rawIndex2.updated_at);
  });

  it("(k2) scoped walk where an in-scope file was deleted drops it; out-of-scope intact", async () => {
    // Two files in scope (sub/), two out of scope (src/).
    await writeFiles({
      "src/a.ts": A_TS,
      "src/b.ts": B_TS,
      "sub/c.ts": C_TS,
      "sub/d.ts": `export function delta(): number { return 4; }\n`,
    });
    await indexFolder(fixtureDir, { watch: false });

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    // Delete an in-scope file (sub/d.ts). A scoped walk fully enumerates the
    // scope, so sub/d.ts (in-scope, not walked) must be DROPPED.
    //
    // EDGE (scoped-granularity guard threshold): 2 in-scope files existed, 1 was
    // deleted → walked 1 of 2 = 0.5, which is NOT < DROP_THRESHOLD (0.5). So this
    // single-file in-scope deletion sits exactly ON the boundary and PASSES the
    // guard (the guard rejects strictly below 50%). Also existingInScope (2) is
    // not > MIN_GUARD_FILES (50), so the guard wouldn't arm regardless. Pinned so
    // a future tweak to the comparison operator or MIN_GUARD_FILES is caught.
    await rm(join(fixtureDir, "sub/d.ts"));

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, {
      include_paths: ["sub"],
      watch: false,
    });
    expect(r2.status).toBeUndefined();
    // 4 → 3: deleted in-scope file dropped, out-of-scope preserved.
    expect(r2.file_count).toBe(3);

    const savedIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      files: Array<{ path: string }>;
      symbols: Array<{ name: string }>;
    };
    const savedPaths = savedIndex.files.map((f) => f.path).sort();
    expect(savedPaths).toEqual(["src/a.ts", "src/b.ts", "sub/c.ts"]);
    const savedNames = savedIndex.symbols.map((s) => s.name);
    // Deleted in-scope file's symbol is gone.
    expect(savedNames).not.toContain("delta");
    // Out-of-scope intact, surviving in-scope intact.
    expect(savedNames).toContain("alpha");
    expect(savedNames).toContain("beta");
    expect(savedNames).toContain("gamma");

    // Snapshot drops the deleted file, keeps the rest.
    const snap = await readSnapshot();
    expect(snap.files["sub/d.ts"]).toBeUndefined();
    expect(snap.files["src/a.ts"]).toBe(sha1(A_TS));
    expect(snap.files["sub/c.ts"]).toBe(sha1(C_TS));
  });

  it("(k3) capped walk (max_files hit) with existing index MERGE-preserves unseen files", async () => {
    // Seed 4 files, full index baseline.
    await writeFiles({
      "src/a.ts": A_TS,
      "src/b.ts": B_TS,
      "src/c.ts": C_TS,
      "src/d.ts": `export function delta(): number { return 4; }\n`,
    });
    await indexFolder(fixtureDir, { watch: false });

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    resetIndexFolderRedundancyForTesting();
    // max_files:1 — the walker hits the cap and returns just 1 file. With a cap,
    // unseen ≠ deleted, so the other 3 must be merge-preserved → file_count 4.
    const r2 = await indexFolder(fixtureDir, { max_files: 1, watch: false });
    expect(r2.status).toBeUndefined();
    expect(r2.file_count).toBe(4);

    const savedIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      file_count: number;
      files: Array<{ path: string }>;
      symbols: Array<{ name: string }>;
    };
    expect(savedIndex.file_count).toBe(4);
    expect(savedIndex.files.map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
    // All four files' symbols still present (1 refreshed via walk, 3 preserved).
    const names = savedIndex.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta", "delta", "gamma"]);

    // Snapshot still covers all four files.
    const snap = await readSnapshot();
    expect(Object.keys(snap.files).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  it("(k4) include_paths matching zero files is a no-op-ish merge (file_count unchanged, no throw)", async () => {
    await writeFiles({
      "src/a.ts": A_TS,
      "src/b.ts": B_TS,
      "src/c.ts": C_TS,
    });
    await indexFolder(fixtureDir, { watch: false });

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    resetIndexFolderRedundancyForTesting();
    // Scope to a subdir that contains no files — walk returns 0. Everything is
    // out-of-scope (no existing path starts with "does-not-exist"), so all 3
    // files are merge-preserved verbatim. Must not throw, must not shrink.
    const r2 = await indexFolder(fixtureDir, {
      include_paths: ["does-not-exist"],
      watch: false,
    });
    expect(r2.status).toBeUndefined();
    expect(r2.file_count).toBe(3);

    const savedIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      files: Array<{ path: string }>;
      symbols: Array<{ name: string }>;
    };
    expect(savedIndex.files.map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    const names = savedIndex.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);

    // Snapshot unchanged set.
    const snap = await readSnapshot();
    expect(Object.keys(snap.files).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("(k5) first scoped run with NO existing index saves only the scoped slice", async () => {
    // Documented behavior: with no existing index there is nothing to preserve,
    // so a scoped/capped walk saves what it walked.
    await writeFiles({
      "src/a.ts": A_TS,
      "sub/c.ts": C_TS,
    });

    const r1 = await indexFolder(fixtureDir, {
      include_paths: ["sub"],
      watch: false,
    });
    expect(r1.status).toBeUndefined();
    expect(r1.file_count).toBe(1);

    const snap = await readSnapshot();
    expect(Object.keys(snap.files)).toEqual(["sub/c.ts"]);
  });

  it("(m) scoped walk under-enumeration is rejected_partial; old snapshot+index intact", async () => {
    // ROUND-2 FINDING: a scoped walk's sanity guard was fully skipped, so a
    // mid-walk abort (or, here, an exclusion that hides almost the whole scope)
    // silently truncated IN-SCOPE files — the merge treats unwalked in-scope
    // files as deletions and wipes them. The scoped-granularity guard must fire
    // when the walk enumerates < DROP_THRESHOLD of the existing in-scope files
    // AND those files are still on disk (genuine under-enumeration, not a real
    // mass deletion).
    const seed: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      seed[`src/f${i}.ts`] = `export function fn${i}(): number { return ${i}; }\n`;
    }
    await writeFiles(seed);
    const r1 = await indexFolder(fixtureDir, { watch: false });
    expect(r1.file_count).toBe(60);

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);
    const snapBefore = await readFile(snapshotPathFor(), "utf-8");
    const indexBefore = await readFile(indexPath, "utf-8");

    // Exclude 59 of the 60 in-scope (src/) files — all still ON DISK. The
    // include_paths=["src"] walk visits only src/f0.ts → walked 1 of 60
    // in-scope. Because the files remain on disk the in-scope auto-heal sampler
    // sees most paths still present → NOT a legit mass deletion → reject.
    await writeFile(
      join(fixtureDir, ".codesiftignore"),
      ["src/f[1-9].ts", "src/f[1-5]?.ts"].join("\n") + "\n",
    );

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, {
      include_paths: ["src"],
      watch: false,
    });

    expect(r2.status).toBe("rejected_partial");
    expect(r2.reason).toMatch(/scoped walk under-enumerated/i);
    expect(r2.reason).toMatch(/walked 1 of 60/i);
    // Echoes the KEPT old index counts.
    expect(r2.file_count).toBe(60);

    // Old snapshot AND index left byte-for-byte intact — no merge/save happened.
    expect(await readFile(snapshotPathFor(), "utf-8")).toBe(snapBefore);
    expect(await readFile(indexPath, "utf-8")).toBe(indexBefore);
  });

  it("(m2) legit in-scope MASS deletion is accepted (auto-heal); file_count drops", async () => {
    // Counterpart to (m): the same shape (walked 1 of 60 in-scope) but this time
    // the missing files are GENUINELY gone from disk. The in-scope auto-heal
    // sampler must see most in-scope paths missing and ACCEPT the merge — a real
    // mass deletion in scope is not under-enumeration.
    const seed: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      seed[`src/f${i}.ts`] = `export function fn${i}(): number { return ${i}; }\n`;
    }
    await writeFiles(seed);
    const r1 = await indexFolder(fixtureDir, { watch: false });
    expect(r1.file_count).toBe(60);

    const dataDir = join(tmpDir, ".codesift");
    const indexPath = getIndexPath(dataDir, fixtureDir);

    // Physically delete 59 of 60 in-scope files (keep src/f0.ts).
    for (let i = 1; i < 60; i++) {
      await rm(join(fixtureDir, `src/f${i}.ts`));
    }

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      resetIndexFolderRedundancyForTesting();
      const r2 = await indexFolder(fixtureDir, {
        include_paths: ["src"],
        watch: false,
      });

      // Accepted — not rejected. The merge drops the 59 genuinely-deleted files.
      expect(r2.status).toBeUndefined();
      expect(r2.file_count).toBe(1);
    } finally {
      errSpy.mockRestore();
    }

    const savedIndex = JSON.parse(await readFile(indexPath, "utf-8")) as {
      file_count: number;
      files: Array<{ path: string }>;
      symbols: Array<{ name: string }>;
    };
    expect(savedIndex.file_count).toBe(1);
    expect(savedIndex.files.map((f) => f.path)).toEqual(["src/f0.ts"]);
    // Only the surviving file's symbol remains.
    const names = savedIndex.symbols.map((s) => s.name);
    expect(names).toContain("fn0");
    expect(names).not.toContain("fn1");

    // Snapshot reflects the deletion too.
    const snap = await readSnapshot();
    expect(Object.keys(snap.files)).toEqual(["src/f0.ts"]);
  });

  it("(l) regression: genuine shrink with files on disk is still rejected_partial", async () => {
    // Duplicate (g)'s core assertion under the label (l) as the regression guard:
    // after the Task 7 change, unrestricted walks that genuinely shrink (via
    // .codesiftignore excluding most files) must still fire the guard when the
    // old files remain on disk (auto-heal does not kick in).
    const seed: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      seed[`src/f${i}.ts`] = `export function fn${i}(): number { return ${i}; }\n`;
    }
    await writeFiles(seed);
    const r1 = await indexFolder(fixtureDir, { watch: false });
    expect(r1.file_count).toBe(60);

    // Exclude all but one file via .codesiftignore (files stay on disk).
    await writeFile(
      join(fixtureDir, ".codesiftignore"),
      ["src/f[1-9].ts", "src/f[1-5]?.ts"].join("\n") + "\n",
    );

    resetIndexFolderRedundancyForTesting();
    const r2 = await indexFolder(fixtureDir, { watch: false });
    expect(r2.status).toBe("rejected_partial");
    // file_count echoes the kept old index.
    expect(r2.file_count).toBe(60);
  });
});
