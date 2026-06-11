import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexFolder,
  indexFile,
  clearLastIndexedStateForTesting,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../src/tools/index-tools.js";

describe("indexFile in-process short-circuit (mtime + content hash)", () => {
  let tmpRoot: string;
  let dataDir: string;
  let filePath: string;
  const originalDataDir = process.env["CODESIFT_DATA_DIR"];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "codesift-idxsc-data-"));
    process.env["CODESIFT_DATA_DIR"] = dataDir;
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "idx-short-circuit-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
    filePath = join(tmpRoot, "src/service.ts");
    await writeFile(filePath, "export function alpha() { return 1; }\n");
    await indexFolder(tmpRoot, { watch: false });
  });

  beforeEach(() => {
    clearLastIndexedStateForTesting();
  });

  afterAll(async () => {
    await stopAllWatchersForTesting();
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
    else process.env["CODESIFT_DATA_DIR"] = originalDataDir;
  });

  it("skips an immediate duplicate call via the in-process mtime check", async () => {
    await writeFile(filePath, "export function alpha() { return 2; }\n");
    const first = await indexFile(filePath);
    expect(first.skipped).toBeUndefined();

    const second = await indexFile(filePath);
    expect(second.skipped).toBe(true);
    expect(second.symbol_count).toBe(first.symbol_count);
    expect(second.duration_ms).toBeLessThan(first.duration_ms + 1);
  });

  it("skips when mtime changed but content is identical (touch / no-op rewrite)", async () => {
    await writeFile(filePath, "export function alpha() { return 3; }\n");
    const first = await indexFile(filePath);
    expect(first.skipped).toBeUndefined();

    // Same content, forced new mtime
    const future = new Date(Date.now() + 5_000);
    await utimes(filePath, future, future);

    const second = await indexFile(filePath);
    expect(second.skipped).toBe(true);

    // And a third call now hits the refreshed in-memory mtime
    const third = await indexFile(filePath);
    expect(third.skipped).toBe(true);
  });

  it("re-indexes when content actually changes", async () => {
    await writeFile(filePath, "export function alpha() { return 4; }\n");
    const first = await indexFile(filePath);
    expect(first.symbol_count).toBe(1);

    await writeFile(
      filePath,
      "export function alpha() { return 4; }\nexport function beta() { return 5; }\n",
    );
    const second = await indexFile(filePath);
    expect(second.skipped).toBeUndefined();
    expect(second.symbol_count).toBe(2);
  });
});
