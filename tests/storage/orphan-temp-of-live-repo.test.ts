// Abandoned temp halves of a LIVE repo were unreachable by every cleanup path at once, so they
// accumulated for two months: measured 2026-09-27 on this install, 149 files holding 11.15 GB, the
// oldest from 31 July, surviving a prune that had run the day before and reported success.
//
// Three separate gaps produced that, and each of these covers one:
//
//  1. `bm25-store` and `edge-cache` wrote `<target>.tmp.<pid>` and never swept. Together they held
//     6.93 GB of the 7.17 GB of `.tmp.*`, and they were the only large-artifact writers with no
//     sweep — every other one calls `cleanupOrphanTempFiles`.
//  2. `writerPidIsAlive` parsed only `.generation.<pid>.`, so adding a sweep to those two writers
//     would have read a LIVE 1.7 GB bm25 write as dead and deleted it mid-flush. The age guard is
//     not enough on its own: a daemon whose event loop is seconds late takes over an hour.
//  3. `prune`'s sweep skipped any hash in the registry BEFORE looking at the tail, so
//     `artifactPattern()`'s `.tmp.*` arm was reachable only for a repo being de-registered in the
//     same run. 1,507 of 1,511 registry roots were present, so that is ~all of them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cleanupOrphanTempFiles, writerPidIsAlive } from "../../src/storage/_shared.js";

/**
 * A pid that is certainly gone: a process run to completion.
 *
 * A hardcoded low number is not free — pid 2 is `kthreadd` on Linux and answers `kill(pid, 0)`, so
 * the first draft of these tests failed on the farm and passed on the Mac.
 */
const DEAD_PID = (() => {
  const done = spawnSync(process.execPath, ["-e", ""]);
  return done.pid as number;
})();

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-orphantmp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function aged(name: string, bytes = "x"): string {
  const full = join(dir, name);
  writeFileSync(full, bytes);
  utimesSync(full, TWO_HOURS_AGO, TWO_HOURS_AGO);
  return full;
}

describe("writerPidIsAlive", () => {
  it("reads a pid out of the `.tmp.<pid>` shape the stream writers use", () => {
    // Without this arm, a bm25 write still flushing looks like an orphan the moment it is an hour
    // old — which is exactly when a 1.7 GB artifact is still being written on a loaded machine.
    expect(writerPidIsAlive(`a.bm25.ndjson.tmp.${process.pid}`)).toBe(true);
  });

  it("still reads the `.generation.<pid>.<uuid>` shape", () => {
    expect(writerPidIsAlive(`a.chunks.ndjson.generation.${process.pid}.abc-def`)).toBe(true);
  });

  it("reads the pid out of atomicWriteFile's longer `.tmp.<pid>.<ts>.<rand>` tail", () => {
    expect(writerPidIsAlive(`registry.json.tmp.${process.pid}.1790000000000.ab12cd`)).toBe(true);
  });

  it("treats a Date.now() tail as no pid at all, not as a process to ask about", () => {
    // `embedding-store` writes `.tmp.${Date.now()}`. `kill` would answer ESRCH for it anyway, but
    // the range bound states which shape is meant instead of depending on that accident.
    expect(writerPidIsAlive("a.embeddings.ndjson.tmp.1790291196201")).toBe(false);
  });

  it("treats a pid that has exited as dead", () => {
    expect(writerPidIsAlive(`a.bm25.ndjson.tmp.${DEAD_PID}`)).toBe(false);
  });
});

describe("cleanupOrphanTempFiles", () => {
  it("collects an hour-old `.tmp.<pid>` whose writer is gone", async () => {
    const orphan = aged(`a.bm25.ndjson.tmp.${DEAD_PID}`);
    expect(await cleanupOrphanTempFiles(join(dir, "a.bm25.ndjson"))).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it("keeps an hour-old `.tmp.<pid>` whose writer is still running", async () => {
    // The regression this prevents is worse than the leak it replaces: a deleted temp turns a slow
    // save into a lost one, and the saves that are slow are the largest indexes on the machine.
    const inflight = aged(`a.bm25.ndjson.tmp.${process.pid}`);
    expect(await cleanupOrphanTempFiles(join(dir, "a.bm25.ndjson"))).toBe(0);
    expect(existsSync(inflight)).toBe(true);
  });

  it("stops trusting a live pid once the file is a day old", async () => {
    // PIDS RECYCLE — macOS wraps at 99,999 and this machine churns agent processes fast enough to
    // reach that in days. Trusting a matching pid forever would let an unrelated live process pin a
    // dead writer's temp file permanently, reintroducing the leak through the guard against it.
    const full = join(dir, `a.bm25.ndjson.tmp.${process.pid}`);
    writeFileSync(full, "x");
    const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(full, twoDays, twoDays);
    expect(await cleanupOrphanTempFiles(join(dir, "a.bm25.ndjson"))).toBe(1);
    expect(existsSync(full)).toBe(false);
  });

  it("never touches the target itself or another artifact's temp", async () => {
    const target = aged("a.bm25.ndjson");
    const other = aged(`b.bm25.ndjson.tmp.${DEAD_PID}`);
    await cleanupOrphanTempFiles(join(dir, "a.bm25.ndjson"));
    expect(existsSync(target)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
