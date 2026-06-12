/**
 * Whole-feature smoke suite (plan T16) — exercises each of the four shipped
 * features end-to-end with mocked network/pg and real filesystem fixtures.
 * Catches cross-feature integration breakage that per-task unit tests cannot:
 * import wiring (SMOKE1), index↔snapshot path agreement (SMOKE2), credential
 * redaction through the real introspect→drift path (SMOKE3), and the group
 * orchestration + match pipeline (SMOKE4).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── SMOKE1 fixture: mock the HF Hub downloader to serve a local model2vec fixture
const fixtureFiles: Record<string, string> = {};
vi.mock("../../src/utils/hf-hub-download.js", () => ({
  MAX_DOWNLOAD_BYTES: 500 * 1024 * 1024,
  DOWNLOAD_TIMEOUT_MS: 30_000,
  ensureModelFile: vi.fn(async (_modelId: string, filename: string) => {
    const p = fixtureFiles[filename];
    if (!p) throw new Error(`smoke fixture missing for ${filename}`);
    return p;
  }),
}));

/** Build a minimal safetensors buffer: one F32 tensor named "embeddings". */
function buildSafetensors(rows: number, cols: number, values: number[]): Uint8Array {
  const header = {
    embeddings: { dtype: "F32", shape: [rows, cols], data_offsets: [0, values.length * 4] },
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
  const out = new Uint8Array(8 + headerJson.length + values.length * 4);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, BigInt(headerJson.length), true);
  out.set(headerJson, 8);
  const payload = new Float32Array(values);
  out.set(new Uint8Array(payload.buffer), 8 + headerJson.length);
  return out;
}

describe("SMOKE1 — static embedding round-trip (F3)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "smoke1-"));
    // 4 tokens × 4 dims; row index = vocab id
    const safetensors = buildSafetensors(4, 4, [
      1, 0, 0, 0, // hello → 0
      0, 1, 0, 0, // world → 1
      0, 0, 1, 0, // [UNK] → 2
      0, 2, 0, 0, // foo   → 3
    ]);
    const stPath = join(dir, "model.safetensors");
    const tokPath = join(dir, "tokenizer.json");
    await writeFile(stPath, safetensors);
    await writeFile(tokPath, JSON.stringify({ model: { vocab: { hello: 0, world: 1, "[UNK]": 2, foo: 3 } } }));
    fixtureFiles["model.safetensors"] = stPath;
    fixtureFiles["tokenizer.json"] = tokPath;
  });
  afterAll(async () => {
    const { _resetStaticProviderForTesting } = await import("../../src/search/static-embedding-provider.js");
    _resetStaticProviderForTesting();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("createEmbeddingProvider routes potion→Static, nomic→Local, and embeds an L2-normalized vector", async () => {
    const { createEmbeddingProvider } = await import("../../src/search/semantic.js");
    const { StaticEmbeddingProvider, _resetStaticProviderForTesting } = await import(
      "../../src/search/static-embedding-provider.js"
    );
    _resetStaticProviderForTesting();

    const potion = createEmbeddingProvider("local", { localModel: "minishlab/potion-code-16M" });
    expect(potion).toBeInstanceOf(StaticEmbeddingProvider);
    expect(potion.dimensions).toBe(256); // KNOWN_LOCAL_DIMS before load

    const nomic = createEmbeddingProvider("local", { localModel: "nomic-ai/nomic-embed-text-v1.5" });
    expect(nomic).not.toBeInstanceOf(StaticEmbeddingProvider);

    // "function foo() {}" → tokens function(OOV, skipped) + foo(id 3 = [0,2,0,0])
    const [vec] = await potion.embed(["function foo() {}"]);
    expect(vec).toBeDefined();
    expect(vec!.length).toBe(4); // real matrix cols after load
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(vec!.some((x) => Number.isNaN(x))).toBe(false);
  });
});

describe("SMOKE2 — snapshot cold-start (F4)", () => {
  let tmpRoot: string;
  let dataDir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["CODESIFT_OPENAI_API_KEY", "CODESIFT_VOYAGE_API_KEY", "CODESIFT_OLLAMA_URL"];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "smoke2-data-"));
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    saved.DISABLE = process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS;
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "true";
    process.env.CODESIFT_DATA_DIR = dataDir;
    const { resetConfigCache } = await import("../../src/config.js");
    const { resetIndexFolderRedundancyForTesting } = await import("../../src/tools/index-tools.js");
    resetConfigCache();
    resetIndexFolderRedundancyForTesting();
    tmpRoot = await mkdtemp(join(tmpdir(), "smoke2-repo-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
    await writeFile(join(tmpRoot, "src/a.ts"), "export function alpha(){return 1;}\n");
    await writeFile(join(tmpRoot, "src/b.ts"), "export function beta(){return 2;}\n");
    await writeFile(join(tmpRoot, "src/c.ts"), "export function gamma(){return 3;}\n");
  });
  afterEach(async () => {
    const { stopAllWatchersForTesting, resetIndexFolderRedundancyForTesting } = await import("../../src/tools/index-tools.js");
    await stopAllWatchersForTesting();
    resetIndexFolderRedundancyForTesting();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (saved.DISABLE === undefined) delete process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS; else process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = saved.DISABLE;
    delete process.env.CODESIFT_DATA_DIR;
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("indexes, writes a v1 snapshot, and reuses unchanged files on the second cold start", async () => {
    const { indexFolder } = await import("../../src/tools/index-tools.js");
    const { getIndexPath } = await import("../../src/storage/index-store.js");
    const { getSnapshotPath } = await import("../../src/storage/hash-snapshot.js");

    const first = await indexFolder(tmpRoot, { watch: false });
    expect(first.file_count).toBe(3);

    const snapPath = getSnapshotPath(getIndexPath(dataDir, tmpRoot));
    const snap1 = JSON.parse(await readFile(snapPath, "utf-8"));
    expect(snap1.version).toBe(1);
    expect(Object.keys(snap1.files).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

    // change only a.ts; bump mtime deterministically
    await writeFile(join(tmpRoot, "src/a.ts"), "export function alphaX(){return 9;}\n");
    const future = new Date(Date.now() + 60_000);
    await utimes(join(tmpRoot, "src/a.ts"), future, future);

    const second = await indexFolder(tmpRoot, { watch: false });
    expect(second.file_count).toBe(3); // stable count, b/c reused
    const snap2 = JSON.parse(await readFile(snapPath, "utf-8"));
    expect(snap2.files["src/a.ts"]).not.toBe(snap1.files["src/a.ts"]); // a re-hashed
    expect(snap2.files["src/b.ts"]).toBe(snap1.files["src/b.ts"]);     // b carried
  });
});

describe("SMOKE3 — pg introspect + drift, no credential leak (F2)", () => {
  const CONN = "postgres://svcuser:sup3rs3cret@db.internal:5432/app";

  function routeQuery(routes: Array<{ match: string; rows: Record<string, unknown>[] }>) {
    return (sql: string) => {
      for (const r of routes) if (sql.includes(r.match)) return Promise.resolve({ rows: r.rows });
      return Promise.resolve({ rows: [] });
    };
  }
  function makeClient(query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) {
    return class {
      connect = vi.fn(async () => undefined);
      end = vi.fn(async () => undefined);
      query = vi.fn(query);
    } as unknown as import("../../src/tools/pg-introspect-tools.js").PgClientCtor["ClientCtor"];
  }

  it("maps live schema, reports drift, and never leaks the connection string", async () => {
    const { introspectPgSchema, pgDriftCheck } = await import("../../src/tools/pg-introspect-tools.js");
    const ctor = makeClient(routeQuery([
      { match: "information_schema.columns", rows: [
        { table_name: "users", column_name: "id", data_type: "integer", is_nullable: "NO" },
        { table_name: "users", column_name: "email", data_type: "text", is_nullable: "YES" },
        { table_name: "posts", column_name: "id", data_type: "integer", is_nullable: "NO" },
      ]},
      { match: "referential_constraints", rows: [
        { from_table: "posts", from_column: "author_id", to_table: "users", to_column: "id" },
      ]},
    ]));

    const live = await introspectPgSchema(CONN, { _clientCtor: ctor });
    expect("error" in live).toBe(false);
    if ("error" in live) return;
    expect(live.tables).toHaveLength(2);
    expect(live.relationships).toHaveLength(1);

    // migration schema is missing users.email → drift must report it
    const symbols = [
      { id: "t:users", kind: "table", name: "users" },
      { id: "f:users.id", kind: "field", name: "id", parent: "t:users", signature: "integer" },
      { id: "t:posts", kind: "table", name: "posts" },
      { id: "f:posts.id", kind: "field", name: "id", parent: "t:posts", signature: "integer" },
    ];
    const drift = pgDriftCheck(live, symbols);
    const driftJson = JSON.stringify(drift);
    expect(driftJson.toLowerCase()).toContain("email");

    // credential redaction: no part of the conn string in any serialized output
    const serialized = JSON.stringify(live) + driftJson;
    for (const needle of ["sup3rs3cret", "svcuser", "db.internal", CONN]) {
      expect(serialized).not.toContain(needle);
    }
  });
});

describe("SMOKE4 — group contract match (F1)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "smoke4-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it("matches a producer endpoint to a real templated consumer call across a group", async () => {
    const { extractOutboundCalls, matchGroupContracts, findEndpointConsumers } =
      await import("../../src/tools/cross-repo-contract-tools.js");
    type RepoResolver = import("../../src/tools/cross-repo-contract-tools.js").RepoResolver;
    const { registerGroup, getGroupRegistryPath } = await import("../../src/storage/group-registry.js");
    const registryPath = getGroupRegistryPath(dir);
    await registerGroup(registryPath, { name: "tgm", repos: ["api", "web"] });

    // real consumer source → real lexer extraction
    const consumerSrc = "const B='http://api'; await fetch(`${B}/users/${id}`);\n";
    const consumerCalls = extractOutboundCalls(consumerSrc, "src/client.ts");
    expect(consumerCalls.length).toBeGreaterThanOrEqual(1);

    const resolver: RepoResolver = async (repo) => {
      if (repo === "api") return {
        indexed: true,
        producers: [{ repo: "api", method: "GET", path: "/users/:id", normalized_path: "/users/{param}", file: "src/users.ts" }],
        consumers: [],
      };
      if (repo === "web") return {
        indexed: true,
        producers: [],
        consumers: consumerCalls.map((c) => ({ ...c, repo: "web" })),
      };
      return { indexed: true, producers: [], consumers: [] };
    };

    const matched = await matchGroupContracts("tgm", { registryPath, resolver });
    expect(matched.matches.length).toBeGreaterThanOrEqual(1);
    const m = matched.matches[0]!;
    expect(m.producer_repo).toBe("api");
    expect(m.consumer_repo).toBe("web");
    expect(m.confidence).toBe("partial");
    expect(m.consumer_file).toBe("src/client.ts");

    const who = await findEndpointConsumers("tgm", "GET", "/users/{param}", { registryPath, resolver });
    expect(who.matches.length).toBeGreaterThanOrEqual(1);
    expect(who.consumers_of_path!.length).toBeGreaterThanOrEqual(1);
  });
});
