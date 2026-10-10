// An embedding run that fails part-way keeps what it finished, and the next run starts from there.
//
// The main vector file was written once, at the end, so any failure before it discarded the whole
// run. Measured 2026-10-09: 1,021 failed runs in the daemon log (839 timeouts), none of which saved a
// vector — and on a ~450k-symbol repo one run is hours of model calls.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeSymbol } from "../../src/types.js";

const calls: string[][] = [];
let failAfterCalls = Number.POSITIVE_INFINITY;
let model = "model-a";

vi.mock("../../src/search/semantic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/search/semantic.js")>();
  return {
    ...actual,
    createEmbeddingProvider: () => ({
      model,
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
let prevDataDir: string | undefined;

const sym = (name: string): CodeSymbol => ({
  id: `local/r:src/${name}.ts:${name}:1`, repo: "local/r", name, kind: "function",
  file: `src/${name}.ts`, start_line: 1, end_line: 2, source: `function ${name}() {}`,
}) as CodeSymbol;
const SYMBOLS = ["a", "b", "c", "d", "e", "f"].map(sym);

async function run(): Promise<boolean> {
  const { embedSymbols } = await import("../../src/tools/index-tools/parse.js");
  const { loadConfig } = await import("../../src/config.js");
  const config = { ...loadConfig(), embeddingProvider: "ollama" as const, embeddingBatchSize: 2 };
  return embedSymbols(SYMBOLS, join(dataDir, "abcdef012345.index.json"), "local/r", config);
}
const partial = () => join(dataDir, "abcdef012345.embeddings.partial.ndjson");
const main = () => join(dataDir, "abcdef012345.embeddings.ndjson");

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cs-embed-resume-"));
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  calls.length = 0;
  failAfterCalls = Number.POSITIVE_INFINITY;
  model = "model-a";
  // Each test is a fresh process as far as the content-hash map is concerned.
  vi.resetModules();
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("embedSymbols checkpoints and resumes", () => {
  it("keeps the batches a failed run finished, and the next run embeds only the rest", async () => {
    failAfterCalls = 2; // two batches of two succeed, the third fails
    expect(await run()).toBe(false);
    expect(existsSync(main())).toBe(false);
    const kept = readFileSync(partial(), "utf-8").trim().split("\n");
    expect(JSON.parse(kept[0] ?? "{}")).toEqual({ model: "model-a" });
    expect(kept).toHaveLength(1 + 4);

    vi.resetModules();
    calls.length = 0;
    failAfterCalls = Number.POSITIVE_INFINITY;
    expect(await run()).toBe(true);

    // Only the two symbols the failed run never reached.
    expect(calls.flat()).toHaveLength(2);
    expect(readFileSync(main(), "utf-8").trim().split("\n")).toHaveLength(6);
    // Folded into the main file, so the checkpoint is gone.
    expect(existsSync(partial())).toBe(false);
  });

  it("does not resume a checkpoint written by another model", async () => {
    failAfterCalls = 2;
    await run();
    vi.resetModules();
    calls.length = 0;
    failAfterCalls = Number.POSITIVE_INFINITY;
    model = "model-b";

    expect(await run()).toBe(true);
    expect(calls.flat()).toHaveLength(6);
  });

  it("re-embeds a stored file built by another model instead of keeping it as current", async () => {
    expect(await run()).toBe(true);
    vi.resetModules();
    calls.length = 0;
    model = "model-b";

    expect(await run()).toBe(true);

    // Same text, so the content hashes all match — only the model check catches it.
    expect(calls.flat()).toHaveLength(6);
    expect(JSON.parse(readFileSync(main().replace(".ndjson", ".meta.json"), "utf-8")).model).toBe("model-b");
  });

  it("re-runs over an unchanged corpus without calling the model", async () => {
    expect(await run()).toBe(true);
    vi.resetModules();
    calls.length = 0;
    expect(await run()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("ignores a checkpoint whose header cannot be read", async () => {
    writeFileSync(partial(), "not json\n");
    expect(await run()).toBe(true);
    expect(calls.flat()).toHaveLength(6);
  });
});
