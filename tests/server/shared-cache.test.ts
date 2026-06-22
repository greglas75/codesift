import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getEmbeddingCache,
  _embeddingLoadCountForTesting,
  _resetEmbeddingLoadCountForTesting,
} from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

// One `codesift serve` daemon hosts many MCP sessions in one process. They share
// the module-global embedding cache, and concurrent first-access must coalesce to
// a SINGLE disk load — never one load per session (a GB-scale load run N times).
function writeRepo(dir: string, name: string): string {
  const hash = name.replace("/", "_");
  const idxPath = join(dir, `${hash}.index.json`);
  writeFileSync(idxPath, "{}");
  const lines: string[] = [];
  for (let i = 0; i < 16; i++) {
    lines.push(JSON.stringify({ id: `${hash}:s${i}`, vec: [0.1, 0.2, 0.3, 0.4] }));
  }
  writeFileSync(join(dir, `${hash}.embeddings.ndjson`), lines.join("\n") + "\n");
  return idxPath;
}

describe("shared embedding cache across connections (Task 8)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shared-cache-"));
    const repos: Record<string, unknown> = {};
    for (const name of ["local/seq", "local/conc"]) {
      repos[name] = { name, index_path: writeRepo(dir, name) };
    }
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ updated_at: 1, repos }));
    process.env.CODESIFT_DATA_DIR = dir;
    // Neutralize any ambient lite-mode / budget the shell may export.
    delete process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS;
    delete process.env.CODESIFT_MAX_EMBEDDING_MEM_MB;
    resetConfigCache();
    _resetEmbeddingLoadCountForTesting();
  });
  afterEach(() => {
    delete process.env.CODESIFT_DATA_DIR;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("two SEQUENTIAL clients on the same repo load embeddings exactly once", async () => {
    const a = await getEmbeddingCache("local/seq");
    const b = await getEmbeddingCache("local/seq");
    expect(a).not.toBeNull();
    expect(b).toBe(a); // same shared instance — process-global cache
    expect(_embeddingLoadCountForTesting()).toBe(1);
  });

  it("two CONCURRENT clients on the same repo dedupe to a single load", async () => {
    const [a, b] = await Promise.all([
      getEmbeddingCache("local/conc"),
      getEmbeddingCache("local/conc"),
    ]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(_embeddingLoadCountForTesting()).toBe(1); // in-flight dedup: NOT 2
  });
});
