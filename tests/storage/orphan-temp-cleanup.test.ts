import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupOrphanTempFiles } from "../../src/storage/_shared.js";
import { saveEmbeddings } from "../../src/storage/embedding-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-orphan-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Backdate a file so the age guard treats it as abandoned. */
async function age(path: string, hoursOld: number): Promise<void> {
  const when = new Date(Date.now() - hoursOld * 3600_000);
  await utimes(path, when, when);
}

describe("cleanupOrphanTempFiles", () => {
  // A process killed mid-write (SIGKILL, stdio-disconnect exit, OOM, sleep)
  // never runs the writer's own cleanup, and the temp name carries a timestamp
  // so nothing ever overwrites it: 100 files / 5.0 GB had accumulated in
  // ~/.codesift by 2026-07-30.
  it("removes abandoned temp siblings of the target", async () => {
    const target = join(dir, "abc.embeddings.ndjson");
    await writeFile(target, "live\n");
    const orphan = `${target}.tmp.1780000000000`;
    await writeFile(orphan, "junk\n");
    await age(orphan, 5);

    const removed = await cleanupOrphanTempFiles(target);

    expect(removed).toBe(1);
    expect(await readdir(dir)).toEqual(["abc.embeddings.ndjson"]);
  });

  it("never touches a temp file young enough to belong to a live writer", async () => {
    const target = join(dir, "abc.embeddings.ndjson");
    await writeFile(target, "live\n");
    const inFlight = `${target}.tmp.${Date.now()}`;
    await writeFile(inFlight, "in progress\n");

    expect(await cleanupOrphanTempFiles(target)).toBe(0);
    expect((await readdir(dir)).length).toBe(2);
  });

  it("leaves the real file and other repos' temp files alone", async () => {
    const target = join(dir, "abc.embeddings.ndjson");
    await writeFile(target, "live\n");
    const otherRepo = join(dir, "zzz.embeddings.ndjson.tmp.1780000000000");
    await writeFile(otherRepo, "someone else\n");
    await age(otherRepo, 5);

    await cleanupOrphanTempFiles(target);

    const left = (await readdir(dir)).sort();
    expect(left).toEqual(["abc.embeddings.ndjson", "zzz.embeddings.ndjson.tmp.1780000000000"]);
  });

  it("saveEmbeddings sweeps orphans as part of writing", async () => {
    const target = join(dir, "abc.embeddings.ndjson");
    const orphan = `${target}.tmp.1780000000000`;
    await writeFile(orphan, "junk\n");
    await age(orphan, 5);

    await saveEmbeddings(target, new Map([["sym:1", new Float32Array([0.1, 0.2])]]));

    expect(await readdir(dir)).toEqual(["abc.embeddings.ndjson"]);
  });
});
