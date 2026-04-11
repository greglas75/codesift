import { describe, it, expect, vi, beforeEach } from "vitest";
import { HonoCache } from "../../src/cache/hono-cache.js";
import type { HonoAppModel } from "../../src/parser/extractors/hono-model.js";

function mockModel(entryFile: string, filesUsed: string[] = []): HonoAppModel {
  return {
    entry_file: entryFile,
    app_variables: {},
    routes: [],
    mounts: [],
    middleware_chains: [],
    context_vars: [],
    openapi_routes: [],
    rpc_exports: [],
    runtime: "unknown",
    env_bindings: [],
    files_used: filesUsed.length > 0 ? filesUsed : [entryFile],
    extraction_status: "complete",
    skip_reasons: {},
  };
}

describe("HonoCache", () => {
  let cache: HonoCache;

  beforeEach(() => {
    cache = new HonoCache(3); // small max for LRU tests
  });

  it("calls extractor on miss and returns model", async () => {
    const model = mockModel("/repo/src/index.ts");
    const extractor = { parse: vi.fn().mockResolvedValue(model) };
    const result = await cache.get("repo", "/repo/src/index.ts", extractor as never);
    expect(extractor.parse).toHaveBeenCalledOnce();
    expect(result.entry_file).toBe("/repo/src/index.ts");
  });

  it("returns cached model on hit without calling extractor", async () => {
    const model = mockModel("/repo/src/index.ts");
    const extractor = { parse: vi.fn().mockResolvedValue(model) };
    await cache.get("repo", "/repo/src/index.ts", extractor as never);
    const result2 = await cache.get("repo", "/repo/src/index.ts", extractor as never);
    expect(extractor.parse).toHaveBeenCalledOnce();
    expect(result2.entry_file).toBe("/repo/src/index.ts");
  });

  it("peek() returns null on miss, model on hit", async () => {
    expect(cache.peek("repo")).toBeNull();
    const model = mockModel("/repo/src/index.ts");
    const extractor = { parse: vi.fn().mockResolvedValue(model) };
    await cache.get("repo", "/repo/src/index.ts", extractor as never);
    const peeked = cache.peek("repo");
    expect(peeked).not.toBeNull();
    expect(peeked?.entry_file).toBe("/repo/src/index.ts");
  });

  it("invalidate() removes entry whose files_used contains the path", async () => {
    const model = mockModel("/repo/src/index.ts", [
      "/repo/src/index.ts",
      "/repo/src/routes/users.ts",
    ]);
    const extractor = { parse: vi.fn().mockResolvedValue(model) };
    await cache.get("repo", "/repo/src/index.ts", extractor as never);
    expect(cache.peek("repo")).not.toBeNull();
    cache.invalidate("/repo/src/routes/users.ts");
    expect(cache.peek("repo")).toBeNull();
  });

  it("concurrent get() calls share a single in-flight promise", async () => {
    const model = mockModel("/repo/src/index.ts");
    let resolveParser: ((m: HonoAppModel) => void) | null = null;
    const extractor = {
      parse: vi.fn().mockImplementation(
        () => new Promise<HonoAppModel>((resolve) => { resolveParser = resolve; }),
      ),
    };

    const p1 = cache.get("repo", "/repo/src/index.ts", extractor as never);
    const p2 = cache.get("repo", "/repo/src/index.ts", extractor as never);
    expect(extractor.parse).toHaveBeenCalledOnce();
    resolveParser!(model);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.entry_file).toBe("/repo/src/index.ts");
    expect(r2.entry_file).toBe("/repo/src/index.ts");
  });

  it("true LRU eviction — frequently accessed entry survives", async () => {
    const extractor = {
      parse: vi.fn().mockImplementation(
        (f: string) => Promise.resolve(mockModel(f)),
      ),
    };
    // Fill cache to max (3)
    await cache.get("repoA", "/a/index.ts", extractor as never);
    await cache.get("repoB", "/b/index.ts", extractor as never);
    await cache.get("repoC", "/c/index.ts", extractor as never);

    // Hit A repeatedly to make it "most recently used"
    await cache.get("repoA", "/a/index.ts", extractor as never);
    await cache.get("repoA", "/a/index.ts", extractor as never);

    // Insert D — should evict B (oldest accessed), not A
    await cache.get("repoD", "/d/index.ts", extractor as never);

    expect(cache.peek("repoA")).not.toBeNull(); // survived
    expect(cache.peek("repoB")).toBeNull(); // evicted (LRU)
    expect(cache.peek("repoD")).not.toBeNull(); // new
  });

  it("clear(repo) removes only that repo's entries", async () => {
    const extractor = {
      parse: vi.fn().mockImplementation(
        (f: string) => Promise.resolve(mockModel(f)),
      ),
    };
    await cache.get("repoA", "/a/index.ts", extractor as never);
    await cache.get("repoB", "/b/index.ts", extractor as never);
    cache.clear("repoA");
    expect(cache.peek("repoA")).toBeNull();
    expect(cache.peek("repoB")).not.toBeNull();
  });

  it("returned model is frozen (immutable)", async () => {
    const model = mockModel("/repo/src/index.ts");
    model.routes.push({ method: "GET", path: "/", raw_path: "/", file: "", line: 1, owner_var: "app", handler: { name: "h", inline: false, file: "", line: 1 }, inline_middleware: [], validators: [] });
    const extractor = { parse: vi.fn().mockResolvedValue(model) };
    const result = await cache.get("repo", "/repo/src/index.ts", extractor as never);
    expect(() => { (result.routes as any).push({ method: "POST" }); }).toThrow();
    expect(() => { (result as any).runtime = "bun"; }).toThrow();
  });
});
