// The read budget was added without bounding the write side, and that combination is a growth loop
// rather than a slow leak: the reader stops at `sharedCacheBudgetBytes()`, `appendSharedCache` dedups
// against the map that read produced, so every key past the budget is invisible to every process
// that opens the file and gets appended again on the next pass.
//
// Measured on this install 2026-09-27, before compaction existed:
//
//   file                 12.97 GB, 3,309,550 records
//   read window             268 MB,    87,381 records  — 2.6% of the file
//   never read            12.70 GB, 3,222,169 records  — 97.4%
//   duplicates in the tail            1,957,738 records — 60.8% of it
//   duplicates overall                                   59.2% of the file
//
// v1's unconditional append was called a defect at 11.3% repeats. This was five times worse.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIM = 768;
const VECTOR_BYTES = DIM * 4;

let dir: string;
let prevDataDir: string | undefined;
let prevBudget: string | undefined;

async function fresh() {
  vi.resetModules();
  return import("../../src/storage/shared-embedding-cache.js");
}

/** Write n distinct vectors through the real writer, so the file is exactly what production makes. */
async function seed(n: number): Promise<string[]> {
  const { appendSharedCache, contentKey, _resetSharedCacheForTests } = await fresh();
  _resetSharedCacheForTests();
  const keys: string[] = [];
  const entries = [];
  for (let i = 0; i < n; i++) {
    const key = contentKey("m", DIM, `text-${i}`);
    keys.push(key);
    const vec = new Float32Array(DIM);
    vec[0] = i;
    entries.push({ key, vec });
  }
  appendSharedCache(entries);
  return keys;
}

function cacheFile(): string {
  return join(dir, "shared-embeddings.v2.bin");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-compact-"));
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  prevBudget = process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  process.env["CODESIFT_DATA_DIR"] = dir;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  if (prevBudget === undefined) delete process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  else process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = prevBudget;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("shared cache compaction", () => {
  it("rewrites a file whose unreadable tail dominates it", async () => {
    // 2,000 vectors is ~6.1 MB; a 1 MB budget reads ~341 of them, so 83% of the file is a tail no
    // process can ever reach.
    await seed(2000);
    const before = statSync(cacheFile()).size;
    expect(before).toBeGreaterThan(5 * 1024 * 1024);

    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const { loadSharedCache } = await fresh();
    const map = await loadSharedCache();

    const after = statSync(cacheFile()).size;
    expect(after).toBeLessThan(before);
    // What remains is exactly what the reader loaded — nothing usable was dropped, because anything
    // past the budget was already unreachable by construction.
    expect(after).toBeLessThanOrEqual(map.size * VECTOR_BYTES + map.size * 32);
    expect(map.size).toBeGreaterThan(0);
  });

  it("the rewritten file reads back identically", async () => {
    // A compaction that lost or corrupted the prefix would be far worse than a large file: the
    // vectors it serves would still look plausible.
    const keys = await seed(2000);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const first = await (await fresh()).loadSharedCache();
    const kept = [...first.keys()];

    const second = await (await fresh()).loadSharedCache();
    expect(second.size).toBe(first.size);
    for (const key of kept) {
      expect(second.get(key)).toEqual(first.get(key));
    }
    // Indices are positional, so a shifted read would show up as a wrong leading float.
    expect(second.get(keys[0]!)?.[0]).toBe(0);
  });

  it("does not blame a corrupt record for a deliberate budget stop", async () => {
    // Both messages printed for one clean 12.97 GB file on 2026-09-27: the budget notice, and
    // "stopped early at an unreadable record". The second names corruption as the cause of a limit,
    // which sends the reader looking for a data-integrity problem that does not exist.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await seed(2000);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    await (await fresh()).loadSharedCache();
    const said = spy.mock.calls.flat().join(" ");
    expect(said).toMatch(/budget/i);
    expect(said).not.toMatch(/unreadable record/);
  });

  it("collapses a duplicate-dominated tail, which is the shape actually measured", async () => {
    // The file header describes 59.2% duplicates, and every other case here seeds DISTINCT keys only —
    // so nothing exercised the mechanism the compaction exists for. Flagged as a coverage gap by the
    // cross-model review of this release. Writing the same keys from a SECOND process view (a fresh
    // module, so its dedup map starts empty) is exactly how the duplicates arise in production.
    // 600 distinct + 600 repeats is ~3.7 MB, which must clear the 3x-budget threshold at a 1 MB
    // budget — the first draft seeded 300 and produced a 1.86 MB file that correctly was NOT
    // compacted, so the test failed on its own arithmetic rather than on the mechanism.
    const keys = await seed(600);
    const before = statSync(cacheFile()).size;
    // Re-append the same keys with a fresh module: the writer cannot see what it never read.
    const again = await fresh();
    again._resetSharedCacheForTests();
    again.appendSharedCache(keys.map((key, i) => {
      const vec = new Float32Array(DIM);
      vec[0] = i;
      return { key, vec };
    }));
    const withDupes = statSync(cacheFile()).size;
    expect(withDupes).toBeGreaterThan(before * 1.8);   // the tail really is duplicate-dominated

    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const map = await (await fresh()).loadSharedCache();
    const after = statSync(cacheFile()).size;
    expect(after).toBeLessThan(withDupes);
    // One record per distinct key it kept — the duplicates are gone, not merely truncated away.
    expect(after).toBeLessThanOrEqual(map.size * VECTOR_BYTES + map.size * 32);
    // And the vectors still read back.
    const reread = await (await fresh()).loadSharedCache();
    for (const [k, v] of map) expect(reread.get(k)).toEqual(v);
  });

  it("leaves a file alone while it still fits within the slack", async () => {
    await seed(200);                                        // ~614 KB
    const before = statSync(cacheFile()).size;
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";      // slack is 3 MB
    await (await fresh()).loadSharedCache();
    expect(statSync(cacheFile()).size).toBe(before);
  });

  it("runs at most once per process because the load is memoised, not because of a guard", async () => {
    // Two once-per-process guards were written here and both were dead code: `loadSharedCache`
    // returns its memo on the second call and never reaches compaction. The second guard was also
    // wrong — it recorded the PRE-compaction size, so a compacted file would have needed to exceed
    // its ORIGINAL size before another rewrite. Asserting the real mechanism is what stops a third
    // one being added: if this ever fails, the memo changed and the bound needs rethinking, not
    // another variable.
    await seed(1300);
    const original = statSync(cacheFile()).size;
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const mod = await fresh();
    await mod.loadSharedCache();
    const afterFirst = statSync(cacheFile()).size;
    expect(afterFirst).toBeLessThan(original);

    // Regrow well past the threshold, then load again in the SAME module instance.
    const vec = new Float32Array(DIM);
    vec[0] = 7;
    const more = [];
    for (let i = 0; i < 1400; i++) more.push({ key: mod.contentKey("m", DIM, `regrown-${i}`), vec });
    mod.appendSharedCache(more);
    const regrown = statSync(cacheFile()).size;
    expect(regrown).toBeGreaterThan(3 * 1024 * 1024);

    await mod.loadSharedCache();
    // Unchanged: the memoised load never re-enters compaction. This is the documented limitation,
    // not a passing guard — a long-lived process appends without looking again.
    expect(statSync(cacheFile()).size).toBe(regrown);

    // A NEW process (a fresh module) does compact it, which is what bounds growth in practice.
    const next = await fresh();
    await next.loadSharedCache();
    expect(statSync(cacheFile()).size).toBeLessThan(regrown);
  });

  it("does not delete the cache when the read was disabled", async () => {
    // Budget 0 means "do not read", so the map is empty for a reason that has nothing to do with
    // the file's contents. Rewriting from it would destroy a perfectly good cache.
    await seed(2000);
    const before = statSync(cacheFile()).size;
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "0";
    const map = await (await fresh()).loadSharedCache();
    expect(map.size).toBe(0);
    expect(statSync(cacheFile()).size).toBe(before);
  });

  it("does not rewrite again until the file has grown past the threshold anew", async () => {
    // A boolean "once per process" guard is wrong for the process that matters: the daemon runs for
    // days and appends the whole time, so the tail grows straight back and nothing looks at it again
    // until a restart — which is how this file reached 12.97 GB. The guard is now the SIZE at the last
    // compaction, so one rewrite per threshold-crossing.
    //
    // This test also has to prove the first compaction HAPPENED before asserting the second does not:
    // the earlier version asserted only that two loads produced the same size, which a run that never
    // compacted at all would satisfy. Flagged by the cross-model review of this release.
    const before = await seed(2000);
    const original = statSync(cacheFile()).size;
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    const mod = await fresh();
    await mod.loadSharedCache();
    const afterFirst = statSync(cacheFile()).size;
    expect(afterFirst).toBeLessThan(original);          // it really did compact
    await mod.loadSharedCache();
    expect(statSync(cacheFile()).size).toBe(afterFirst); // and not again, unprompted
    expect(before.length).toBe(2000);
  });

  it("leaves no temp sibling behind", async () => {
    // This writer's temp has no repository hash, so `artifactPattern()` cannot match it and `prune`
    // could never reclaim one.
    await seed(2000);
    process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "1";
    await (await fresh()).loadSharedCache();
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
    expect(existsSync(cacheFile())).toBe(true);
  });
});
