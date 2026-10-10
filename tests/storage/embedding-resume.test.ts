// An embedding run that fails part-way keeps what it finished, and the next run starts from there.
//
// The main vector file was written once, at the end, so any failure before it discarded the whole
// run. Measured 2026-10-09: 1,021 failed runs in the daemon log (839 timeouts), none of which saved a
// vector — and on a ~450k-symbol repo one run is hours of model calls.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // The cross-repo cache is keyed by model, so its hits are legitimately reusable — and would hide
  // which vectors came from THIS repo's files, which is what these tests are about.
  process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "0";
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  calls.length = 0;
  failAfterCalls = Number.POSITIVE_INFINITY;
  model = "model-a";
  // Each test is a fresh process as far as the content-hash map is concerned.
  vi.resetModules();
});

afterEach(() => {
  delete process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
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

  it("moves an unrecognised checkpoint aside instead of deleting it", async () => {
    // A complete first line that is not a header is not ours to judge — but resuming from it would be
    // a guess. Kept as a `.tmp.<ts>` tail, which prune reclaims by age.
    writeFileSync(partial(), JSON.stringify({ id: "x", vec: [1, 2] }) + "\n");
    expect(await run()).toBe(true);
    expect(calls.flat()).toHaveLength(6);
    expect(readdirSync(dataDir).some((f) => /\.embeddings\.partial\.ndjson\.tmp\.\d+-[0-9a-f-]+$/.test(f))).toBe(true);
  });

  it("drops a first write that never completed a line — at most one batch", async () => {
    writeFileSync(partial(), '{"model":"mod');
    expect(await run()).toBe(true);
    expect(existsSync(partial())).toBe(false);
  });

  it("leaves an unreadable checkpoint untouched and does not append to it", async () => {
    // A failed read is not a wrong model. The first version deleted the file on ANY read failure —
    // one transient error discarding hours of vectors.
    if (process.getuid?.() === 0) return; // root reads through mode 000
    writeFileSync(partial(), JSON.stringify({ model: "model-a" }) + "\n");
    chmodSync(partial(), 0o000);
    try {
      expect(await run()).toBe(true);
      chmodSync(partial(), 0o600);
      expect(readFileSync(partial(), "utf-8")).toBe(JSON.stringify({ model: "model-a" }) + "\n");
    } finally {
      chmodSync(partial(), 0o600);
    }
  });

  it("cuts a torn last line before appending, so the next batch is not fused to it", async () => {
    failAfterCalls = 1;
    await run();
    const intact = readFileSync(partial(), "utf-8");
    writeFileSync(partial(), intact + '{"id":"local/r:src/zz.ts:zz:1","vec":[1,');

    vi.resetModules();
    calls.length = 0;
    failAfterCalls = 1; // resumes 2, appends one more batch of 2, then fails
    await run();

    // Every line parses: the fragment was cut, not glued to the next batch.
    const lines = readFileSync(partial(), "utf-8").trim().split("\n");
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines).toHaveLength(1 + 2 + 2);
  });

  it("writes the header into an empty checkpoint left by a crash between create and write", async () => {
    writeFileSync(partial(), "");
    failAfterCalls = 1;
    await run();
    expect(JSON.parse(readFileSync(partial(), "utf-8").split("\n")[0] ?? "")).toEqual({ model: "model-a" });
  });

  it("does not touch a checkpoint another live process owns", async () => {
    writeFileSync(partial(), JSON.stringify({ model: "model-a" }) + "\n");
    writeFileSync(`${partial()}.lock`, String(process.ppid));
    failAfterCalls = 1;

    await run();

    // Neither resumed from, appended to, nor deleted — and the owner's lock is left alone.
    expect(readFileSync(partial(), "utf-8")).toBe(JSON.stringify({ model: "model-a" }) + "\n");
    expect(readFileSync(`${partial()}.lock`, "utf-8")).toBe(String(process.ppid));
  });

  it("takes over the lock of a process that is gone, and releases it after the run", async () => {
    writeFileSync(`${partial()}.lock`, "999999");
    expect(await run()).toBe(true);
    expect(existsSync(`${partial()}.lock`)).toBe(false);
  });

  it("does not reuse a vector file whose meta is missing", async () => {
    // A crash between the vector and meta writes leaves vectors of an unknown model — the same
    // incomparability the model check exists for.
    expect(await run()).toBe(true);
    rmSync(main().replace(".ndjson", ".meta.json"));
    vi.resetModules();
    calls.length = 0;

    expect(await run()).toBe(true);
    expect(calls.flat()).toHaveLength(6);
  });
});
