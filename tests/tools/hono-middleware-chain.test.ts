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

describe("traceMiddlewareChain — scope mode (absorbed trace_conditional_middleware)", () => {
  it("scope filter returns only entries from that chain", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
const app = new Hono();
app.use("*", logger());
app.use("/api/*", cors());
app.get("/api/users", (c) => c.json([]));
export default app;`,
    });
    const result = await traceMiddlewareChain(repo, undefined, undefined, {
      scope: "/api/*",
    });
    expect(result.error).toBeUndefined();
    expect(result.route).toBeUndefined();
    expect(result.scopes).toEqual(["/api/*"]);
    expect(result.chain.map((e) => e.name)).toContain("cors");
    expect(result.chain.map((e) => e.name)).not.toContain("logger");
  });

  it("app-wide mode (no path, no scope) returns all chains flattened", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
const app = new Hono();
app.use("*", logger());
app.use("/api/*", cors());
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const result = await traceMiddlewareChain(repo);
    expect(result.error).toBeUndefined();
    expect(result.scopes?.length).toBeGreaterThanOrEqual(2);
    const names = result.chain.map((e) => e.name);
    expect(names).toContain("logger");
    expect(names).toContain("cors");
  });
});

describe("traceMiddlewareChain — only_conditional filter", () => {
  it("returns only entries with applied_when populated (blog-API pattern)", async () => {
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
    const result = await traceMiddlewareChain(repo, undefined, undefined, {
      only_conditional: true,
    });
    expect(result.error).toBeUndefined();
    const basic = result.chain.find((e) => e.name === "basicAuth");
    expect(basic).toBeDefined();
    expect(basic?.applied_when?.condition_type).toBe("method");
    expect(basic?.applied_when?.condition_text).toContain("method");
    // Plain <inline> wrapper entry should NOT be included
    expect(result.chain.some((e) => e.name === "<inline>")).toBe(false);
  });

  it("only_conditional combines with scope filter", async () => {
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
    const all = await traceMiddlewareChain(repo, undefined, undefined, {
      only_conditional: true,
    });
    expect(all.total).toBeGreaterThanOrEqual(2);
    const filtered = await traceMiddlewareChain(repo, undefined, undefined, {
      scope: "/a/*",
      only_conditional: true,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.chain[0]?.name).toBe("basicAuth");
  });

  it("only_conditional returns empty when no conditional middleware exists", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
const app = new Hono();
app.use("*", logger());
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const result = await traceMiddlewareChain(repo, undefined, undefined, {
      only_conditional: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(0);
    expect(result.chain).toEqual([]);
  });

  it("only_conditional works in route mode too", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
const app = new Hono();
app.use("/posts/*", async (c, next) => {
  if (c.req.method !== "GET") return basicAuth({ username: "u", password: "p" })(c, next);
  await next();
});
app.get("/posts/:id", (c) => c.json({}));
export default app;`,
    });
    const result = await traceMiddlewareChain(repo, "/posts/:id", "GET", {
      only_conditional: true,
    });
    expect(result.route?.path).toBe("/posts/:id");
    expect(result.chain.some((e) => e.name === "basicAuth")).toBe(true);
  });
});
