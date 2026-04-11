import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { traceMiddlewareChain } from "../../src/tools/hono-middleware-chain.js";
import { honoCache } from "../../src/cache/hono-cache.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    delete process.env["CODESIFT_DATA_DIR"];
    resetConfigCache();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  honoCache.clear();
});

async function createIndexedFixture(files: Record<string, string>): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-mw-"));
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

describe("traceMiddlewareChain", () => {
  it("returns ordered middleware chain matching a route's scope", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
const app = new Hono();
app.use("*", logger());
app.use("*", cors());
app.use("/api/*", (c, next) => next());
app.get("/api/users", (c) => c.json({ users: [] }));
export default app;`,
    });
    const result = await traceMiddlewareChain(repo, "/api/users", "GET");
    expect(result.error).toBeUndefined();
    expect(result.route).toBeDefined();
    expect(result.route?.method).toBe("GET");
    expect(result.chain.length).toBeGreaterThanOrEqual(2);
    const names = result.chain.map((e) => e.name);
    expect(names).toContain("logger");
    expect(names).toContain("cors");
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function hello() { return "hi"; }`,
    });
    const result = await traceMiddlewareChain(repo, "/foo");
    expect(result.error).toBeDefined();
    expect(result.chain).toHaveLength(0);
  });

  it("returns error for path with no matching route", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
export default app;`,
    });
    const result = await traceMiddlewareChain(repo, "/nonexistent");
    expect(result.error).toBeDefined();
    expect(result.chain).toHaveLength(0);
  });

  it("filters by HTTP method when specified", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users", (c) => c.json({}));
app.post("/users", (c) => c.json({}, 201));
export default app;`,
    });
    const getResult = await traceMiddlewareChain(repo, "/users", "GET");
    expect(getResult.route?.method).toBe("GET");
    const postResult = await traceMiddlewareChain(repo, "/users", "POST");
    expect(postResult.route?.method).toBe("POST");
  });
});
