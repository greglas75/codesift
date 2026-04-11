import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { detectMiddlewareEnvRegression } from "../../src/tools/hono-env-regression.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-envreg-"));
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

describe("detectMiddlewareEnvRegression", () => {
  it("flags a chain of 3 where intermediate uses plain createMiddleware", async () => {
    const repo = await createIndexedFixture({
      "src/middleware.ts": `import { createMiddleware } from "hono/factory";
// BAD: no generic — resets Env to BlankEnv for downstream middleware
export const tenantMw = createMiddleware(async (c, next) => {
  await next();
});
// GOOD: typed
export const authMw = createMiddleware<{ Variables: { user: string } }>(async (c, next) => {
  await next();
});
export const loggerMw = createMiddleware<{ Variables: { reqId: string } }>(async (c, next) => {
  await next();
});`,
      "src/index.ts": `import { Hono } from "hono";
import { tenantMw, authMw, loggerMw } from "./middleware";
const app = new Hono();
app.use("*", authMw);
app.use("*", tenantMw);
app.use("*", loggerMw);
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const r = await detectMiddlewareEnvRegression(repo);
    expect(r.error).toBeUndefined();
    expect(r.total).toBeGreaterThanOrEqual(1);
    const finding = r.findings?.find((f) => f.middleware_name === "tenantMw");
    expect(finding).toBeDefined();
    expect(finding?.reason).toBe("plain_createMiddleware_no_generic");
    expect(finding?.chain_length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT flag when all intermediates use typed createMiddleware", async () => {
    const repo = await createIndexedFixture({
      "src/middleware.ts": `import { createMiddleware } from "hono/factory";
export const a = createMiddleware<{ Variables: { x: string } }>(async (c, next) => { await next(); });
export const b = createMiddleware<{ Variables: { y: string } }>(async (c, next) => { await next(); });
export const c2 = createMiddleware<{ Variables: { z: string } }>(async (c, next) => { await next(); });`,
      "src/index.ts": `import { Hono } from "hono";
import { a, b, c2 } from "./middleware";
const app = new Hono();
app.use("*", a);
app.use("*", b);
app.use("*", c2);
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const r = await detectMiddlewareEnvRegression(repo);
    expect(r.total).toBe(0);
  });

  it("does NOT flag chains with fewer than 3 entries", async () => {
    const repo = await createIndexedFixture({
      "src/middleware.ts": `import { createMiddleware } from "hono/factory";
export const plain = createMiddleware(async (c, next) => { await next(); });`,
      "src/index.ts": `import { Hono } from "hono";
import { plain } from "./middleware";
const app = new Hono();
app.use("*", plain);
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const r = await detectMiddlewareEnvRegression(repo);
    expect(r.total).toBe(0);
  });

  it("includes a heuristic note in the result", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const r = await detectMiddlewareEnvRegression(repo);
    expect(r.note).toContain("Heuristic");
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await detectMiddlewareEnvRegression(repo);
    expect(r.error).toBeDefined();
  });
});
