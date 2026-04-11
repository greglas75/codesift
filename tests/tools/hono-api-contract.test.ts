import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { extractApiContract } from "../../src/tools/hono-api-contract.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-api-"));
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

describe("extractApiContract", () => {
  it("summary format lists every route with method, path, source, file", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users", (c) => c.json([]));
app.post("/users", (c) => c.json({}, 201));
export default app;`,
    });
    const r = await extractApiContract(repo, undefined, "summary");
    expect(r.error).toBeUndefined();
    expect(r.format).toBe("summary");
    expect(r.summary?.length).toBe(2);
    const post = r.summary?.find((s) => s.method === "POST");
    expect(post?.path).toBe("/users");
    expect(post?.source).toBe("inferred");
  });

  it("openapi format builds paths object with method keys", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/users/:id", (c) => c.json({ id: 1 }));
export default app;`,
    });
    const r = await extractApiContract(repo);
    expect(r.format).toBe("openapi");
    expect(r.paths?.["/users/:id"]?.["get"]).toBeDefined();
  });

  it("inferred responses use inline_analysis status codes (not generic 200)", async () => {
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
    const r = await extractApiContract(repo);
    const route = r.paths?.["/users/:id"]?.["get"] as {
      responses: Record<string, unknown>;
      "x-hono-source": string;
    };
    expect(route).toBeDefined();
    // Both 200 AND 404 should appear — not just the generic 200 stub
    expect(Object.keys(route.responses).sort()).toEqual(["200", "404"]);
    expect(route["x-hono-source"]).toBe("inline_analysis");
  });

  it("HTTPException throws are surfaced as error responses", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
const app = new Hono();
app.get("/guarded", (c) => {
  if (!c.req.header("auth")) throw new HTTPException(401, { message: "auth required" });
  return c.json({ ok: true });
});
export default app;`,
    });
    const r = await extractApiContract(repo);
    const route = r.paths?.["/guarded"]?.["get"] as {
      responses: Record<string, unknown>;
    };
    expect(Object.keys(route.responses)).toContain("200");
    expect(Object.keys(route.responses)).toContain("401");
  });

  it("falls back to generic 200 when route has no inline_analysis emissions", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/passthrough", (c) => { doSomething(); });
export default app;`,
    });
    const r = await extractApiContract(repo);
    const route = r.paths?.["/passthrough"]?.["get"] as {
      responses: Record<string, { description: string }>;
    };
    expect(route.responses["200"]?.description).toContain("Success");
  });

  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await extractApiContract(repo);
    expect(r.error).toBeDefined();
  });
});
