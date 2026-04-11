import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { findDeadHonoRoutes } from "../../src/tools/hono-dead-routes.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-dead-"));
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

describe("findDeadHonoRoutes", () => {
  it("flags a server route with no client caller", async () => {
    const repo = await createIndexedFixture({
      "src/server.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users", (c) => c.json([]));
app.get("/deprecatedroute", (c) => c.json([]));
export default app;`,
      "src/client.ts": `import { hc } from "hono/client";
const client = hc("http://localhost:3000");
await client.users.$get();`,
    });
    const r = await findDeadHonoRoutes(repo);
    expect(r.error).toBeUndefined();
    const dead = r.findings?.find((f) => f.route.includes("/deprecatedroute"));
    expect(dead).toBeDefined();
    const users = r.findings?.find((f) => f.route.includes("/users"));
    expect(users).toBeUndefined();
  });

  it("does NOT flag routes whose segments appear in the client (even in strings)", async () => {
    const repo = await createIndexedFixture({
      "src/server.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/posts", (c) => c.json([]));
export default app;`,
      "src/client.ts": `import { hc } from "hono/client";
const client = hc("http://localhost:3000");
// dynamic form
const method = "posts";
await (client as any)[method].$get();`,
    });
    const r = await findDeadHonoRoutes(repo);
    const hit = r.findings?.find((f) => f.route.includes("/posts"));
    expect(hit).toBeUndefined();
  });

  it("skips fully-dynamic routes like `/:id`", async () => {
    const repo = await createIndexedFixture({
      "src/server.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/:id", (c) => c.json({}));
export default app;`,
      "src/client.ts": `// no client calls`,
    });
    const r = await findDeadHonoRoutes(repo);
    // Fully-dynamic routes are not flagged (heuristic can't confirm or deny)
    expect(r.findings?.some((f) => f.route === "GET /:id")).toBe(false);
  });

  it("reports total 0 when all routes are used", async () => {
    const repo = await createIndexedFixture({
      "src/server.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/health", (c) => c.json({}));
app.get("/metrics", (c) => c.json({}));
export default app;`,
      "src/client.ts": `const a = "health";
const b = "metrics";`,
    });
    const r = await findDeadHonoRoutes(repo);
    expect(r.total).toBe(0);
  });

  it("includes a heuristic note in the result", async () => {
    const repo = await createIndexedFixture({
      "src/server.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const r = await findDeadHonoRoutes(repo);
    expect(r.note).toContain("Heuristic");
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await findDeadHonoRoutes(repo);
    expect(r.error).toBeDefined();
  });
});
