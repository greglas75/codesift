import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, type DaemonHandle } from "../../src/cli/commands.js";
import {
  getEmbeddingCache,
  _embeddingLoadCountForTesting,
  _resetEmbeddingLoadCountForTesting,
  _cachedEmbeddingReposForTesting,
} from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

// Whole-feature smoke for the shared-server memory work (Phase B + C):
// one `codesift serve` process hosts every editor window, embeddings load once,
// resident RAM stays bounded, and lite mode holds zero embeddings.

function writeRepo(dir: string, name: string, vecs: number, dims: number): string {
  const hash = name.replace("/", "_");
  const idxPath = join(dir, `${hash}.index.json`);
  writeFileSync(idxPath, "{}");
  const lines: string[] = [];
  for (let i = 0; i < vecs; i++) {
    lines.push(JSON.stringify({ id: `${hash}:s${i}`, vec: Array.from({ length: dims }, (_, j) => ((i + j) % 13) / 13) }));
  }
  writeFileSync(join(dir, `${hash}.embeddings.ndjson`), lines.join("\n") + "\n");
  return idxPath;
}

/** Minimal HTTP MCP client: initialize → initialized → tools/list. */
async function mcpToolsList(url: string): Promise<number> {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const readMcp = async (res: Response) => {
    const t = (await res.text()).trim();
    if (t.startsWith("{")) return JSON.parse(t);
    const d = t.split("\n").reverse().find((l) => l.startsWith("data:"));
    return d ? JSON.parse(d.slice(5).trim()) : {};
  };
  const initRes = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
  });
  const sid = initRes.headers.get("mcp-session-id")!;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
  const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sid });
  const json = await readMcp(listRes);
  return ((json.result?.tools as unknown[]) ?? []).length;
}

describe("SMOKE — shared daemon loads once, bounded memory, lite mode", () => {
  let dir: string;
  let handle: DaemonHandle | null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "smoke-shared-"));
    const repos: Record<string, unknown> = {};
    for (const name of ["local/main", "local/r1", "local/r2", "local/r3"]) {
      repos[name] = { name, index_path: writeRepo(dir, name, name === "local/main" ? 16 : 200, name === "local/main" ? 4 : 768) };
    }
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ updated_at: 1, repos }));
    process.env.CODESIFT_DATA_DIR = dir;
    // Force embeddings ON regardless of the runner's RAM. "unset" no longer
    // means "on" — it means "auto-decide by total RAM", and CI runners are
    // ~16 GB so auto-lite would (correctly) disable the local model and this
    // suite (which exercises embedding-cache loading + eviction) needs them on.
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "0";
    delete process.env.CODESIFT_MAX_EMBEDDING_MEM_MB;
    resetConfigCache();
    _resetEmbeddingLoadCountForTesting();
    handle = null;
  });
  afterEach(async () => {
    if (handle) await handle.close();
    delete process.env.CODESIFT_DATA_DIR;
    delete process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS;
    delete process.env.CODESIFT_MAX_EMBEDDING_MEM_MB;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("SMOKE1: two MCP clients on one daemon share the process; same repo loads once", async () => {
    handle = await startDaemon({ dataDir: dir, port: 0 });

    // Two independent HTTP MCP clients both reach the ONE daemon process.
    const [n1, n2] = await Promise.all([mcpToolsList(handle.url), mcpToolsList(handle.url)]);
    expect(n1).toBeGreaterThanOrEqual(50);
    expect(n2).toBeGreaterThanOrEqual(50);
    expect(handle.sessionCount()).toBe(2); // two sessions, one process

    // Both clients querying the same repo trigger exactly one embedding load.
    const [a, b] = await Promise.all([getEmbeddingCache("local/main"), getEmbeddingCache("local/main")]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(_embeddingLoadCountForTesting()).toBe(1);
  });

  it("SMOKE2a: resident embeddings stay bounded under a tight budget (LRU evicts)", async () => {
    process.env.CODESIFT_MAX_EMBEDDING_MEM_MB = "1"; // ~1MB holds <2 of the ~614KB repos
    await getEmbeddingCache("local/r1");
    await getEmbeddingCache("local/r2");
    await getEmbeddingCache("local/r3");
    const resident = _cachedEmbeddingReposForTesting();
    expect(resident).not.toContain("local/r1"); // oldest evicted
    expect(resident).toContain("local/r3");
    expect(resident.length).toBeLessThan(3);
  });

  it("SMOKE2b: lite mode loads zero embeddings but the daemon still serves tools (BM25 path)", async () => {
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "1";
    handle = await startDaemon({ dataDir: dir, port: 0 });

    const emb = await getEmbeddingCache("local/main");
    expect(emb).toBeNull();
    expect(_embeddingLoadCountForTesting()).toBe(0); // never touched disk

    const n = await mcpToolsList(handle.url); // server still answers (symbols/BM25 work)
    expect(n).toBeGreaterThanOrEqual(50);
  });
});
