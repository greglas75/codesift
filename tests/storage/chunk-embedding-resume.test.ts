// The chunk pass keeps what it finished and reuses what it already has, like the symbol pass.
//
// Measured 2026-10-12: no rdesigner checkout had ever finished a chunk pass. Its vectors carried no
// content hash, so a fresh process re-embedded every chunk; it had no checkpoint, so a restart threw
// the pass away; and prune deleted what did get published.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FileEntry } from "../../src/types.js";

const calls: string[][] = [];
let failAfterCalls = Number.POSITIVE_INFINITY;

vi.mock("../../src/search/semantic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/search/semantic.js")>();
  return {
    ...actual,
    createEmbeddingProvider: () => ({
      model: "model-a",
      dimensions: 2,
      embed: async (texts: string[]) => {
        if (calls.length >= failAfterCalls) throw new Error("provider down");
        calls.push(texts);
        return texts.map((_, i) => [calls.length, i + 1]);
      },
    }),
  };
});

let dataDir: string;
let root: string;
let prevDataDir: string | undefined;
// More files than one chunk batch (96), so a run can fail after finishing some batches.
const FILES = Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`);
const embedded = () => calls.reduce((n, batch) => n + batch.length, 0);
const partial = () => join(dataDir, "abcdef012345.chunk-embeddings.partial.ndjson");

async function run(): Promise<boolean> {
  const { embedChunks } = await import("../../src/tools/index-tools/parse.js");
  const { loadConfig } = await import("../../src/config.js");
  const config = { ...loadConfig(), embeddingProvider: "ollama" as const };
  const entries = FILES.map((path) => ({ path }) as FileEntry);
  return embedChunks(entries, root, "local/r", join(dataDir, "abcdef012345.index.json"), config);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cs-chunk-resume-"));
  root = join(dataDir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [i, file] of FILES.entries()) writeFileSync(join(root, file), `export const v${i} = ${i};\n`);
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  // The cross-repo cache would answer repeats by itself and hide what THIS repo's files provide.
  process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "0";
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  calls.length = 0;
  failAfterCalls = Number.POSITIVE_INFINITY;
  // Each run is a fresh process as far as the content-hash map is concerned.
  vi.resetModules();
});

afterEach(() => {
  delete process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("embedChunks", () => {
  // Bug: chunk vector lines had no content hash, so every chunk compared as changed in a new process.
  it("re-embeds nothing in a fresh process when no file changed", async () => {
    expect(await run()).toBe(true);
    calls.length = 0;
    vi.resetModules();

    expect(await run()).toBe(true);

    expect(embedded()).toBe(0);
  });

  it("re-embeds only the chunk whose file changed", async () => {
    expect(await run()).toBe(true);
    calls.length = 0;
    vi.resetModules();
    writeFileSync(join(root, "src/f7.ts"), "export const changed = true;\n");

    expect(await run()).toBe(true);

    expect(calls.flat()).toEqual([expect.stringContaining("changed")]);
  });

  // Bug: the chunk pass had no checkpoint, so a failure or restart discarded every finished batch.
  it("keeps the batches a failed run finished, and the next run embeds only the rest", async () => {
    failAfterCalls = 1;
    expect(await run()).toBe(false);
    const kept = readFileSync(partial(), "utf-8").trim().split("\n");
    expect(JSON.parse(kept[0] ?? "{}")).toEqual({ model: "model-a" });
    expect(kept).toHaveLength(1 + 96);
    calls.length = 0;
    failAfterCalls = Number.POSITIVE_INFINITY;
    vi.resetModules();

    expect(await run()).toBe(true);

    expect(embedded()).toBe(FILES.length - 96);
  });
});
