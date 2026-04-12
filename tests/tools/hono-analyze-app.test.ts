import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { analyzeHonoApp } from "../../src/tools/hono-analyze-app.js";
import { honoCache } from "../../src/cache/hono-cache.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  honoCache.clear();
});

async function createIndexedFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-analyze-"));
  const projDir = join(tmpDir, "test-project");
  await mkdir(projDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(projDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await indexFolder(projDir, { watch: false });
  return "local/test-project";
}

describe("analyzeHonoApp", () => {
  it("returns complete overview for a single-file Hono app", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
const app = new Hono();
app.use("*", logger());
app.get("/health", (c) => c.json({ ok: true }));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
app.post("/users", (c) => c.json({}, 201));
export default app;`,
    });
    const result = await analyzeHonoApp(repo);
    expect(result.framework).toBe("hono");
    expect(result.error).toBeUndefined();
    expect(result.routes?.total).toBe(3);
    expect(result.routes?.by_method.GET).toBe(2);
    expect(result.routes?.by_method.POST).toBe(1);
    expect(result.middleware?.third_party).toContain("logger");
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const result = await analyzeHonoApp(repo);
    expect(result.error).toBeDefined();
  });

  it("flags full_app RPC exports as slow pattern", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.use("*", (c, next) => next());
app.get("/x", (c) => c.json({}));
export type AppType = typeof app;
export default app;`,
    });
    const result = await analyzeHonoApp(repo);
    expect(result.rpc_exports?.length).toBeGreaterThan(0);
    const appExport = result.rpc_exports?.find((r) => r.name === "AppType");
    expect(appExport?.is_slow_pattern).toBe(true);
  });

  it("force_refresh clears cache before rebuild", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/a", (c) => c.json({}));
export default app;`,
    });
    // Warm cache
    const r1 = await analyzeHonoApp(repo);
    expect(r1.routes?.total).toBe(1);
    // Force refresh should still work
    const r2 = await analyzeHonoApp(repo, undefined, true);
    expect(r2.routes?.total).toBe(1);
  });
});
