// The resident-cache budget used to bound the load of a repo's stored vectors in an embedding run, and
// a file over it came back empty — so every symbol was embedded again. Measured 2026-10-15: rdesigner's
// 498k vectors at 1024 dims exceeded the 2,147 MB budget, and each worktree that had cloned them sent
// all of them to OpenRouter (~$1 per worktree).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config.js";
import type { CodeSymbol } from "../../src/types.js";

const KEYS = [
  "CODESIFT_DATA_DIR", "CODESIFT_INDEX_EMBEDDINGS", "CODESIFT_EMBEDDING_PROVIDER", "CODESIFT_OPENAI_API_KEY",
  "CODESIFT_OPENAI_DIMENSIONS", "CODESIFT_MAX_EMBEDDING_MEM_MB", "CODESIFT_MAX_SHARED_CACHE_MB",
] as const;
let dir: string;
let saved: Record<string, string | undefined>;
const origFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "cs-embed-reuse-budget-"));
  process.env["CODESIFT_DATA_DIR"] = dir;
  process.env["CODESIFT_INDEX_EMBEDDINGS"] = "1";
  process.env["CODESIFT_EMBEDDING_PROVIDER"] = "openai";
  process.env["CODESIFT_OPENAI_API_KEY"] = "k";
  process.env["CODESIFT_OPENAI_DIMENSIONS"] = "1024";
  // The cross-repo cache would answer by content and hide whether the repo's own vectors were reused.
  process.env["CODESIFT_MAX_SHARED_CACHE_MB"] = "0";
  vi.resetModules();
  resetConfigCache();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

async function embedInFreshProcess(symbols: CodeSymbol[], indexPath: string): Promise<void> {
  vi.resetModules();
  const { embedSymbols } = await import("../../src/tools/index-tools/parse.js");
  const { loadConfig } = await import("../../src/config.js");
  await embedSymbols(symbols, indexPath, "local/r", loadConfig());
}

describe("an embedding run over stored vectors larger than the cache budget", () => {
  it("reuses them instead of embedding every symbol again", async () => {
    let sent = 0;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const input = (JSON.parse(init.body) as { input: string[] }).input;
      sent += input.length;
      return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: new Array<number>(1024).fill(0.03) })) }) };
    }) as unknown as typeof fetch;
    const indexPath = join(dir, "repo.index.json");
    // 400 vectors of 1,024 floats: ~1.6 MB stored, over a 1 MB budget.
    const symbols = Array.from({ length: 400 }, (_, i) => ({
      id: `local/r:a.ts:f${i}:${i + 1}`, file: "a.ts", name: `f${i}`, kind: "function", start_line: i + 1,
      end_line: i + 1, source: `function f${i}() {}`,
    }) as CodeSymbol);
    await embedInFreshProcess(symbols, indexPath);
    sent = 0;
    process.env["CODESIFT_MAX_EMBEDDING_MEM_MB"] = "1";

    // A new embedding child: nothing of the first run is left in memory.
    await embedInFreshProcess(symbols, indexPath);

    expect(sent).toBe(0);
  });
});
