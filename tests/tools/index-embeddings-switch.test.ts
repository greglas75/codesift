// CODESIFT_INDEX_EMBEDDINGS=0 must stop indexing from embedding anything while a provider stays
// configured for queries. Measured 2026-10-13: eight ~480k-symbol embedding runs held the Mac at load
// 150-250, and the query embeddings semantic search needed timed out behind them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { embedChunks, embedSymbols } from "../../src/tools/index-tools/parse.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";
import type { CodeSymbol } from "../../src/types.js";

const KEYS = ["CODESIFT_DATA_DIR", "CODESIFT_INDEX_EMBEDDINGS", "CODESIFT_EMBEDDING_PROVIDER", "CODESIFT_OLLAMA_URL"] as const;
let dir: string;
let saved: Record<string, string | undefined>;
const origFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "cs-index-embed-off-"));
  process.env["CODESIFT_DATA_DIR"] = dir;
  process.env["CODESIFT_EMBEDDING_PROVIDER"] = "ollama";
  process.env["CODESIFT_OLLAMA_URL"] = "http://ollama.invalid";
  process.env["CODESIFT_INDEX_EMBEDDINGS"] = "0";
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

describe("CODESIFT_INDEX_EMBEDDINGS=0", () => {
  it("embeds neither symbols nor chunks during indexing, and reports success", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("indexing must not call the provider");
    }) as unknown as typeof fetch;
    const indexPath = join(dir, "repo.index.json");
    const symbol = { id: "local/r:a.ts:a:1", file: "a.ts", name: "a", kind: "function", start_line: 1, end_line: 1, source: "a" } as CodeSymbol;

    const symbolsOk = await embedSymbols([symbol], indexPath, "local/r", loadConfig());
    const chunksOk = await embedChunks([{ path: "a.ts" } as never], dir, "local/r", indexPath, loadConfig(), [symbol]);

    expect([symbolsOk, chunksOk, requests]).toEqual([true, true, 0]);
    expect(existsSync(join(dir, "repo.embeddings.ndjson"))).toBe(false);
  });
});
