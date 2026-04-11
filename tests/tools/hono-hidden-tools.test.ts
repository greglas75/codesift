import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { traceContextFlow } from "../../src/tools/hono-context-flow.js";
import { extractApiContract } from "../../src/tools/hono-api-contract.js";
import { traceRpcTypes } from "../../src/tools/hono-rpc-types.js";
import { auditHonoSecurity } from "../../src/tools/hono-security.js";
import { visualizeHonoRoutes } from "../../src/tools/hono-visualize.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-hidden-"));
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

const BASIC_HONO = `import { Hono } from "hono";
const app = new Hono();
app.use("*", (c, next) => { c.set("userId", "u1"); return next(); });
app.get("/me", (c) => c.json({ id: c.var.userId }));
app.post("/users", async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);
});
export type AppType = typeof app;
export default app;`;

describe("Hono hidden tools smoke tests", () => {
  it("traceContextFlow returns context variables", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await traceContextFlow(repo);
    expect(result.error).toBeUndefined();
    expect(result.context_vars).toBeDefined();
    const userId = result.context_vars?.find((cv) => cv.name === "userId");
    expect(userId).toBeDefined();
  });

  it("extractApiContract summary returns route list", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await extractApiContract(repo, undefined, "summary");
    expect(result.error).toBeUndefined();
    expect(result.summary?.length).toBeGreaterThan(0);
  });

  it("extractApiContract openapi returns paths object", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await extractApiContract(repo);
    expect(result.paths).toBeDefined();
    expect(Object.keys(result.paths ?? {}).length).toBeGreaterThan(0);
  });

  it("traceRpcTypes detects slow pattern (full_app)", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await traceRpcTypes(repo);
    expect(result.error).toBeUndefined();
    expect(result.has_slow_pattern).toBe(true);
    const slow = result.exports?.find((e) => e.is_slow);
    expect(slow?.recommendation).toContain("Split");
  });

  it("auditHonoSecurity flags missing rate limit on POST", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await auditHonoSecurity(repo);
    expect(result.error).toBeUndefined();
    const rlFinding = result.findings?.find((f) => f.rule === "missing-rate-limit");
    expect(rlFinding).toBeDefined();
    expect(rlFinding?.severity).toBe("HIGH");
  });

  it("visualizeHonoRoutes tree format", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await visualizeHonoRoutes(repo, "tree");
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("Hono Application");
    expect(result.output).toContain("GET /me");
  });

  it("visualizeHonoRoutes mermaid format", async () => {
    const repo = await createIndexedFixture({ "src/index.ts": BASIC_HONO });
    const result = await visualizeHonoRoutes(repo, "mermaid");
    expect(result.output).toContain("graph LR");
  });

  it("all hidden tools return error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    expect((await traceContextFlow(repo)).error).toBeDefined();
    expect((await extractApiContract(repo)).error).toBeDefined();
    expect((await traceRpcTypes(repo)).error).toBeDefined();
    expect((await auditHonoSecurity(repo)).error).toBeDefined();
    expect((await visualizeHonoRoutes(repo)).error).toBeDefined();
  });
});
