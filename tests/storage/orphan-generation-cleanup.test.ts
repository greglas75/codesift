// Abandoned writes come in TWO shapes and only one was ever swept.
//
// `atomicWriteFile` writes `<target>.tmp.<timestamp>`; `chunk-store` writes
// `<target>.generation.<pid>.<uuid>`. The sweeper matched the first prefix only, and `prune`'s
// artifact pattern allowed a `.tmp.` tail but not a `.generation.` one — so the second shape was
// invisible to both. Measured 2026-09-05 in ~/.codesift: 164 such files holding 19.6 GB, across 26
// process ids of which 24 were long dead, in a directory that had reached 82.3 GB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupOrphanTempFiles, artifactPattern } from "../../src/storage/_shared.js";

let dir: string;
let target: string;
const HOUR = 60 * 60 * 1000;

function makeOld(path: string, ageMs: number): void {
  writeFileSync(path, "x");
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-orphan-")); target = join(dir, "abc123.chunks.ndjson"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("orphaned generation files", () => {
  it("sweeps a generation file whose writer is gone", () => {
    // A pid that cannot exist: 2^22 is above every platform's pid_max.
    const orphan = `${target}.generation.4194304.11111111-2222-3333-4444-555555555555`;
    makeOld(orphan, 2 * HOUR);
    return cleanupOrphanTempFiles(target).then((removed) => {
      expect(removed).toBe(1);
      expect(existsSync(orphan)).toBe(false);
    });
  });

  it("still sweeps the .tmp. shape it always did", async () => {
    const tmp = `${target}.tmp.1700000000000`;
    makeOld(tmp, 2 * HOUR);
    expect(await cleanupOrphanTempFiles(target)).toBe(1);
  });

  it("leaves a generation file alone while its writer is STILL RUNNING", async () => {
    // The age guard alone would eventually delete one: a large embedding batch can outlive the
    // hour, and deleting it mid-write turns a slow save into a corrupt one.
    const live = `${target}.generation.${process.pid}.11111111-2222-3333-4444-555555555555`;
    makeOld(live, 5 * HOUR);
    expect(await cleanupOrphanTempFiles(target)).toBe(0);
    expect(existsSync(live)).toBe(true);
  });

  // Bug: the published chunk index IS a generation file, so it looked abandoned once its writer exited.
  it("leaves the generation file a chunk manifest points at", async () => {
    const published = `${target}.generation.4194304.11111111-2222-3333-4444-555555555555`;
    makeOld(published, 2 * HOUR);
    writeFileSync(join(dir, "abc123.chunk-index.json"), JSON.stringify({
      version: 1, chunks: published.slice(dir.length + 1), embeddings: "abc123.chunk-embeddings.ndjson.generation.x",
    }));
    expect(await cleanupOrphanTempFiles(target)).toBe(0);
    expect(existsSync(published)).toBe(true);
  });

  it.each([
    ["does not parse", "{ torn"],
    ["names no file", JSON.stringify({ version: 1 })],
  ])("leaves every generation of a hash whose manifest %s", async (_case, manifest) => {
    // Fails closed: deleting a live generation costs hours of embedding, keeping an orphan costs disk.
    const published = `${target}.generation.4194304.11111111-2222-3333-4444-555555555555`;
    makeOld(published, 2 * HOUR);
    writeFileSync(join(dir, "abc123.chunk-index.json"), manifest);
    expect(await cleanupOrphanTempFiles(target)).toBe(0);
    expect(existsSync(published)).toBe(true);
  });

  it("leaves a recent orphan alone, so a concurrent writer is never raced", async () => {
    const fresh = `${target}.generation.4194304.11111111-2222-3333-4444-555555555555`;
    writeFileSync(fresh, "x");
    expect(await cleanupOrphanTempFiles(target)).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it("does not touch the real artifact it is named after", async () => {
    writeFileSync(target, "real");
    makeOld(`${target}.generation.4194304.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, 2 * HOUR);
    await cleanupOrphanTempFiles(target);
    expect(existsSync(target)).toBe(true);
  });

  it("prune's artifact pattern now recognises both abandoned-write tails", () => {
    // Without this, prune walks past 19.6 GB it is supposed to be reclaiming and reports success.
    const p = artifactPattern();
    expect(p.test("abc12345.chunks.ndjson")).toBe(true);
    expect(p.test("abc12345.chunks.ndjson.tmp.1700000000000")).toBe(true);
    expect(p.test("abc12345.chunks.ndjson.generation.999.11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(p.test("abc12345.chunk-embeddings.ndjson.generation.999.a-b-c-d-e")).toBe(true);
    // …and still refuses something that is not ours.
    expect(p.test("notahash.chunks.ndjson")).toBe(false);
  });
});
