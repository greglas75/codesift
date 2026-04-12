import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { analyzeInlineHandler } from "../../src/tools/hono-inline-analyze.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-inline-"));
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

describe("analyzeInlineHandler", () => {
  it("returns reports for all inline handlers when no filter is given", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("hi"));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
app.post("/users", (c) => c.json({}, 201));
export default app;`,
    });
    const r = await analyzeInlineHandler(repo);
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(3);
    expect(r.reports?.map((x) => x.route).sort()).toEqual([
      "GET /",
      "GET /users/:id",
      "POST /users",
    ]);
  });

  it("filters by method", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.json({}));
app.post("/", (c) => c.json({}, 201));
app.delete("/", (c) => c.json({}, 204));
export default app;`,
    });
    const r = await analyzeInlineHandler(repo, "POST");
    expect(r.total).toBe(1);
    expect(r.reports?.[0]?.route).toBe("POST /");
    expect(r.reports?.[0]?.analysis.responses[0]?.status).toBe(201);
  });

  it("filters by method + path combo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/a", (c) => c.json({ which: "a" }));
app.get("/b", (c) => c.json({ which: "b" }));
export default app;`,
    });
    const r = await analyzeInlineHandler(repo, "GET", "/b");
    expect(r.total).toBe(1);
    expect(r.reports?.[0]?.analysis.responses[0]?.shape_hint).toContain('"b"');
  });

  it("reports DB + fetch + context access from a realistic handler", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/user/:id", async (c) => {
  const user = await prisma.user.findUnique({ where: { id: c.req.param("id") } });
  const avatar = await fetch("https://avatars.com/" + user.id);
  c.set("user", user);
  return c.json(user);
});
export default app;`,
    });
    const r = await analyzeInlineHandler(repo);
    const report = r.reports?.[0];
    expect(report).toBeDefined();
    expect(report?.analysis.db_calls.some((x) => x.callee === "prisma.user.findUnique")).toBe(true);
    expect(report?.analysis.fetch_calls.some((x) => x.callee === "fetch")).toBe(true);
    expect(report?.analysis.context_access.some((a) => a.type === "set" && a.key === "user")).toBe(true);
  });

  it("does NOT return reports for named-handler routes", async () => {
    // Named handlers appear when the route references an identifier defined
    // elsewhere; for this test we use a local const so the handler node
    // classified by buildHandler is the identifier.
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
const getUsers = (c: any) => c.json([]);
app.get("/users", getUsers);
export default app;`,
    });
    const r = await analyzeInlineHandler(repo);
    expect(r.total).toBe(0);
  });

  it("empty filter returns empty (no routes match)", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.json({}));
export default app;`,
    });
    const r = await analyzeInlineHandler(repo, "GET", "/does-not-exist");
    expect(r.total).toBe(0);
    expect(r.reports).toEqual([]);
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await analyzeInlineHandler(repo);
    expect(r.error).toBeDefined();
  });
});
