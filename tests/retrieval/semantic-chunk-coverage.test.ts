// semantic_search preferred a repo's chunk index whenever one existed. Measured 2026-10-13: the main
// rdesigner checkout held 461,823 symbol vectors and a chunk index of 163 chunks from 7 of 26,063
// files, cloned from a worktree indexed while git was still writing it — every query answered from
// those 7 files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeChunk } from "../../src/types.js";

const ENV_KEYS = [
  "CODESIFT_DATA_DIR", "CODESIFT_EMBEDDING_PROVIDER", "CODESIFT_OLLAMA_URL", "CODESIFT_OLLAMA_MODEL",
  "CODESIFT_OLLAMA_DIMENSIONS", "CODESIFT_DISABLE_LOCAL_EMBEDDINGS",
] as const;
const FILES = ["a.ts", "b.ts", "c.ts", "d.ts"];

let dir: string;
let saved: Record<string, string | undefined>;
const origFetch = globalThis.fetch;

async function resetConfig(): Promise<void> {
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
}

/**
 * An indexed repo whose symbol vectors point the query at `d.ts` (vectors for `vectorFiles` only),
 * plus chunks for `chunked` only.
 */
async function repoWithChunksFor(chunked: string[], vectorFiles: string[] = FILES): Promise<string> {
  const root = join(dir, "repo");
  mkdirSync(root);
  for (const file of FILES) {
    const name = file.replace(".ts", "");
    writeFileSync(join(root, file), `export function fn_${name}() {\n  return "${name}";\n}\n`);
  }
  const { indexFolder } = await import("../../src/tools/index-tools.js");
  const indexed = await indexFolder(root, { watch: false });
  const repo = (indexed as { repo: string }).repo;

  const { getRepo } = await import("../../src/storage/registry.js");
  const { loadConfig } = await import("../../src/config.js");
  const meta = await getRepo(loadConfig().registryPath, repo);
  if (!meta) throw new Error("repo not registered");

  const { findRepoSymbols } = await import("../../src/tools/index-tools.js");
  const symbols = await findRepoSymbols(repo, { withSource: false }, { skipFreshness: true });
  const { getEmbeddingPath, getEmbeddingMetaPath, saveEmbeddings, saveEmbeddingMeta } =
    await import("../../src/storage/embedding-store.js");
  const vectors = new Map(symbols
    .filter((s) => vectorFiles.includes(s.file))
    .map((s) => [s.id, new Float32Array(s.file === "d.ts" ? [1, 0] : [0, 1])]));
  await saveEmbeddings(getEmbeddingPath(meta.index_path), vectors);
  await saveEmbeddingMeta(getEmbeddingMetaPath(meta.index_path), {
    model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: vectors.size, updated_at: 1,
  });

  const { getChunkPath, getChunkEmbeddingPath, saveChunkIndex } = await import("../../src/storage/chunk-store.js");
  const chunks: CodeChunk[] = chunked.map((file) => ({
    id: `${repo}:${file}:1`, file, startLine: 1, endLine: 3, text: `CHUNK ${file}`, tokenCount: 3,
  }));
  await saveChunkIndex(
    getChunkPath(meta.index_path), chunks, getChunkEmbeddingPath(meta.index_path),
    new Map(chunks.map((c) => [c.id, new Float32Array([1, 0])])),
    { hashes: new Map(), model: "embeddinggemma" },
  );

  process.env["CODESIFT_EMBEDDING_PROVIDER"] = "ollama";
  process.env["CODESIFT_OLLAMA_URL"] = "http://ollama.invalid";
  process.env["CODESIFT_OLLAMA_MODEL"] = "embeddinggemma";
  process.env["CODESIFT_OLLAMA_DIMENSIONS"] = "2";
  // Lite mode would refuse to hold any vectors at all; it was on only so indexing embedded nothing.
  delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  await resetConfig();
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const n = (JSON.parse(init.body).input as string[]).length;
    return { ok: true, json: async () => ({ embeddings: Array.from({ length: n }, () => [1, 0]) }) };
  }) as unknown as typeof fetch;
  return repo;
}

async function search(repo: string): Promise<string> {
  const { handleSemanticQuery } = await import("../../src/retrieval/semantic-handlers.js");
  const result = await handleSemanticQuery(repo, { type: "semantic", query: "which function returns d", top_k: 1 });
  return String(result.data);
}

async function hybrid(repo: string): Promise<string> {
  const { handleHybridQuery } = await import("../../src/retrieval/semantic-handlers.js");
  const result = await handleHybridQuery(repo, { type: "hybrid", query: "which function returns d", top_k: 1 });
  return String(result.data);
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "cs-chunk-coverage-"));
  process.env["CODESIFT_DATA_DIR"] = join(dir, "data");
  delete process.env["CODESIFT_EMBEDDING_PROVIDER"];
  delete process.env["CODESIFT_OLLAMA_URL"];
  // No provider while indexing, so nothing embeds in the background.
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "1";
  await resetConfig();
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("semantic search with a chunk index", () => {
  it("answers from the symbol vectors when the chunks cover a fragment of the repo", async () => {
    const repo = await repoWithChunksFor(["a.ts"]);

    const text = await search(repo);

    expect(text).toContain("d.ts");
    expect(text).not.toContain("CHUNK a.ts");
  });

  // The fallback must not trade one fragment for another: symbol vectors for 1 of 4 files are no
  // better than chunks for 1 of 4.
  it("keeps the chunks when the symbol vectors are a fragment too", async () => {
    const repo = await repoWithChunksFor(["a.ts"], ["d.ts"]);

    const text = await search(repo);

    expect(text).toContain("CHUNK a.ts");
  });

  // A hybrid answer that silently lost its text-match fusion would read like a full one.
  it("answers a hybrid query from the symbol vectors and says the fusion was skipped", async () => {
    const repo = await repoWithChunksFor(["a.ts"]);

    const text = await hybrid(repo);

    expect(text).toContain("without text-match fusion");
    expect(text).toContain("d.ts");
  });

  it("still answers from the chunks when they cover the repo", async () => {
    const repo = await repoWithChunksFor(FILES);

    const text = await search(repo);

    expect(text).toContain("CHUNK");
  });
});
