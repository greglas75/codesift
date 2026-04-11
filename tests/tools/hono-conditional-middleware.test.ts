import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { traceConditionalMiddleware } from "../../src/tools/hono-conditional-middleware.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-cond-"));
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

describe("traceConditionalMiddleware", () => {
  it("returns entries with applied_when populated for conditional basicAuth", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
const app = new Hono();
app.use("/posts/*", async (c, next) => {
  if (c.req.method !== "GET") {
    const auth = basicAuth({ username: "u", password: "p" });
    return auth(c, next);
  }
  await next();
});
app.get("/posts/:id", (c) => c.json({}));
export default app;`,
    });
    const result = await traceConditionalMiddleware(repo);
    expect(result.error).toBeUndefined();
    expect(result.total).toBeGreaterThanOrEqual(1);
    const basic = result.entries?.find((e) => e.middleware_name === "basicAuth");
    expect(basic).toBeDefined();
    expect(basic?.condition_type).toBe("method");
    expect(basic?.scope).toBe("/posts/*");
    expect(basic?.condition_text).toContain("method");
  });

  it("scopeFilter narrows results to a single chain", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bearerAuth } from "hono/bearer-auth";
const app = new Hono();
app.use("/a/*", async (c, next) => {
  if (c.req.method !== "GET") return basicAuth({ username: "u", password: "p" })(c, next);
  await next();
});
app.use("/b/*", async (c, next) => {
  if (!c.req.header("x-key")) return bearerAuth({ token: "t" })(c, next);
  await next();
});
app.get("/a/x", (c) => c.json({}));
app.get("/b/x", (c) => c.json({}));
export default app;`,
    });
    const all = await traceConditionalMiddleware(repo);
    expect(all.total).toBeGreaterThanOrEqual(2);
    const filtered = await traceConditionalMiddleware(repo, "/a/*");
    expect(filtered.total).toBe(1);
    expect(filtered.entries?.[0]?.middleware_name).toBe("basicAuth");
  });

  it("returns empty entries array when no conditional middleware exists", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
const app = new Hono();
app.use("*", logger());
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const result = await traceConditionalMiddleware(repo);
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const result = await traceConditionalMiddleware(repo);
    expect(result.error).toBeDefined();
  });
});
