import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { extractResponseTypes } from "../../src/tools/hono-response-types.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-respt-"));
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

describe("extractResponseTypes", () => {
  it("aggregates 200/404 responses for a route with conditional branches", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users/:id", (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing" }, 404);
  return c.json({ id, name: "alice" }, 200);
});
export default app;`,
    });
    const r = await extractResponseTypes(repo);
    expect(r.error).toBeUndefined();
    expect(r.total_routes).toBe(1);
    const route = r.routes?.[0];
    expect(route?.route).toBe("GET /users/:id");
    const statuses = route?.status_codes ?? [];
    expect(statuses).toContain(200);
    expect(statuses).toContain(404);
  });

  it("captures HTTPException errors as separate error entries", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
const app = new Hono();
app.get("/guarded", (c) => {
  if (!c.req.header("auth")) {
    throw new HTTPException(401, { message: "unauthorized" });
  }
  return c.json({ ok: true });
});
export default app;`,
    });
    const r = await extractResponseTypes(repo);
    const route = r.routes?.[0];
    expect(route?.errors.some((e) => e.exception_class === "HTTPException" && e.status === 401)).toBe(true);
    expect(route?.status_codes).toContain(401);
    expect(route?.status_codes).toContain(200);
  });

  it("deduplicates status codes across branches", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => {
  if (a) return c.json({}, 200);
  if (b) return c.json({ other: true }, 200);
  return c.json({ fallback: true }, 200);
});
export default app;`,
    });
    const r = await extractResponseTypes(repo);
    // Three emissions, one distinct status
    expect(r.routes?.[0]?.responses).toHaveLength(3);
    expect(r.routes?.[0]?.status_codes).toEqual([200]);
  });

  it("reports empty responses when handler has no c.* emissions", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/passthrough", (c) => { doSomething(); });
export default app;`,
    });
    const r = await extractResponseTypes(repo);
    expect(r.routes?.[0]?.responses).toHaveLength(0);
    expect(r.routes?.[0]?.status_codes).toEqual([]);
  });

  it("total_statuses counts distinct codes across the whole app", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/a", (c) => c.json({}, 200));
app.post("/b", (c) => c.json({}, 201));
app.delete("/c", (c) => c.json({}, 204));
app.get("/d", (c) => c.json({}, 200));
export default app;`,
    });
    const r = await extractResponseTypes(repo);
    expect(r.total_statuses).toBe(3); // 200, 201, 204
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await extractResponseTypes(repo);
    expect(r.error).toBeDefined();
  });
});
