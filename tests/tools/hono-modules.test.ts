import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { detectHonoModules } from "../../src/tools/hono-modules.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-modules-"));
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

describe("detectHonoModules", () => {
  it("clusters routes by 2-segment prefix and rolls up middleware", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { cors } from "hono/cors";
const app = new Hono();
app.use("/api/admin/*", basicAuth({ username: "u", password: "p" }));
app.use("/api/public/*", cors());
app.get("/api/admin/users", (c) => c.json([]));
app.get("/api/admin/settings", (c) => c.json({}));
app.post("/api/admin/users", (c) => c.json({}, 201));
app.get("/api/public/health", (c) => c.json({}));
app.get("/api/public/posts", (c) => c.json([]));
export default app;`,
    });
    const r = await detectHonoModules(repo);
    expect(r.error).toBeUndefined();
    expect(r.total).toBeGreaterThanOrEqual(2);

    const admin = r.modules?.find((m) => m.path_prefix === "/api/admin");
    expect(admin).toBeDefined();
    expect(admin?.routes.length).toBe(3);
    expect(admin?.middleware).toContain("basicAuth");
    expect(admin?.middleware).not.toContain("cors");

    const pub = r.modules?.find((m) => m.path_prefix === "/api/public");
    expect(pub?.routes.length).toBe(2);
    expect(pub?.middleware).toContain("cors");
  });

  it("single-segment paths become their own module", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.get("/metrics", (c) => c.text("..."));
export default app;`,
    });
    const r = await detectHonoModules(repo);
    const prefixes = r.modules?.map((m) => m.path_prefix).sort();
    expect(prefixes).toContain("/health");
    expect(prefixes).toContain("/metrics");
  });

  it("rolls up env bindings from inline_analysis per module", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/api/users/:id", (c) => {
  const db = c.env.DATABASE_URL;
  const key = c.env.SECRET_KEY;
  return c.json({ db, key });
});
app.get("/api/users/count", (c) => {
  const db = c.env.DATABASE_URL;
  return c.json({ count: db });
});
export default app;`,
    });
    const r = await detectHonoModules(repo);
    const users = r.modules?.find((m) => m.path_prefix === "/api/users");
    expect(users?.bindings).toContain("DATABASE_URL");
    expect(users?.bindings).toContain("SECRET_KEY");
  });

  it("module name is derived from the path prefix", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/api/admin/users", (c) => c.json([]));
app.get("/webhooks/stripe", (c) => c.json({}));
export default app;`,
    });
    const r = await detectHonoModules(repo);
    const names = r.modules?.map((m) => m.name).sort();
    expect(names).toContain("api-admin");
    expect(names).toContain("webhooks-stripe");
  });

  it("global middleware (scope=*) is rolled up into every module", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { logger } from "hono/logger";
const app = new Hono();
app.use("*", logger());
app.get("/api/a", (c) => c.json({}));
app.get("/api/b", (c) => c.json({}));
export default app;`,
    });
    const r = await detectHonoModules(repo);
    for (const m of r.modules ?? []) {
      expect(m.middleware).toContain("logger");
    }
  });

  it("returns empty modules array when no routes exist", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
export default app;`,
    });
    const r = await detectHonoModules(repo);
    expect(r.total).toBe(0);
    expect(r.modules).toEqual([]);
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await detectHonoModules(repo);
    expect(r.error).toBeDefined();
  });
});
