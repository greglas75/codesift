import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { auditHonoSecurity } from "../../src/tools/hono-security.js";
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
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-hono-sec-"));
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

describe("auditHonoSecurity — baseline checks", () => {
  it("flags missing secure-headers middleware globally", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.json({ ok: true }));
export default app;`,
    });
    const r = await auditHonoSecurity(repo);
    expect(r.error).toBeUndefined();
    expect(r.findings?.some((f) => f.rule === "missing-secure-headers")).toBe(true);
  });

  it("does NOT flag when secureHeaders middleware is globally registered", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
const app = new Hono();
app.use("*", secureHeaders());
app.get("/", (c) => c.json({ ok: true }));
export default app;`,
    });
    const r = await auditHonoSecurity(repo);
    expect(r.findings?.some((f) => f.rule === "missing-secure-headers")).toBe(false);
  });

  it("flags POST route without rate limiting", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const app = new Hono();
app.post("/users", (c) => c.json({}, 201));
export default app;`,
    });
    const r = await auditHonoSecurity(repo);
    const rl = r.findings?.filter((f) => f.rule === "missing-rate-limit");
    expect(rl?.length).toBeGreaterThanOrEqual(1);
    expect(rl?.[0]?.severity).toBe("HIGH");
  });

  it("does NOT flag rate limit when rateLimit middleware is in scope", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
const rateLimit = () => async (c: any, next: any) => next();
const app = new Hono();
app.use("*", rateLimit());
app.post("/users", (c) => c.json({}, 201));
export default app;`,
    });
    const r = await auditHonoSecurity(repo);
    const rl = r.findings?.filter((f) => f.rule === "missing-rate-limit");
    expect(rl?.length ?? 0).toBe(0);
  });
});

describe("auditHonoSecurity — Phase 2 conditional middleware awareness", () => {
  it("does NOT false-positive `missing-auth` when conditional basicAuth wraps mutations", async () => {
    // This is the honojs/examples/blog pattern that Phase 2 T4 was built to handle.
    // Note: scope "/posts/*" in Hono matches sub-paths like /posts/:id, NOT /posts bare.
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
app.post("/posts/:id", (c) => c.json({}, 201));
app.get("/posts/:id", (c) => c.json({}));
export default app;`,
    });
    const r = await auditHonoSecurity(repo);
    // POST /posts/:id is gated by the conditional basicAuth — not a finding
    const authFindings = r.findings?.filter(
      (f) => f.rule === "missing-auth" && f.message.includes("POST /posts/:id"),
    );
    expect(authFindings?.length ?? 0).toBe(0);
  });

  it("DOES flag `missing-auth` when the conditional middleware would NOT run for that method", async () => {
    // This middleware gates GET requests but not POSTs — POSTs are unprotected.
    const repo = await createIndexedFixture({
      "src/index.ts": `import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
const app = new Hono();
app.use("/posts/*", async (c, next) => {
  if (c.req.method === "GET") {
    return basicAuth({ username: "u", password: "p" })(c, next);
  }
  await next();
});
app.post("/posts/:id", (c) => c.json({}, 201));
export default app;`,
    });
    const r = await auditHonoSecurity(repo);
    const authFindings = r.findings?.filter(
      (f) => f.rule === "missing-auth" && f.message.includes("POST /posts/:id"),
    );
    expect(authFindings?.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag auth-ordering on inline wrapper middleware (false positive fix)", async () => {
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
    const r = await auditHonoSecurity(repo);
    const ordering = r.findings?.filter((f) => f.rule === "auth-ordering");
    expect(ordering?.length ?? 0).toBe(0);
  });
});

describe("auditHonoSecurity — env-regression rule (absorbed from detect_middleware_env_regression)", () => {
  it("flags intermediate plain createMiddleware in a 3+ chain", async () => {
    const repo = await createIndexedFixture({
      "src/middleware.ts": `import { createMiddleware } from "hono/factory";
// BAD: no generic — resets Env to BlankEnv for downstream middleware
export const tenantMw = createMiddleware(async (c, next) => {
  await next();
});
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
    const r = await auditHonoSecurity(repo);
    const envFinding = r.findings?.find(
      (f) => f.rule === "env-regression" && f.message.includes("tenantMw"),
    );
    expect(envFinding).toBeDefined();
    expect(envFinding?.severity).toBe("MEDIUM");
    expect(r.notes?.["env-regression"]).toContain("heuristic");
  });

  it("does NOT flag when all intermediates are typed", async () => {
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
    const r = await auditHonoSecurity(repo);
    const envFindings = r.findings?.filter((f) => f.rule === "env-regression");
    expect(envFindings?.length ?? 0).toBe(0);
    // notes.env-regression only present when at least one finding fires
    expect(r.notes?.["env-regression"]).toBeUndefined();
  });

  it("does NOT flag chains of fewer than 3 entries", async () => {
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
    const r = await auditHonoSecurity(repo);
    const envFindings = r.findings?.filter((f) => f.rule === "env-regression");
    expect(envFindings?.length ?? 0).toBe(0);
  });
});

describe("auditHonoSecurity — error paths", () => {
  it("returns error for non-Hono repo", async () => {
    const repo = await createIndexedFixture({
      "src/index.ts": `export function x() { return 1; }`,
    });
    const r = await auditHonoSecurity(repo);
    expect(r.error).toBeDefined();
  });

  it("returns error for unknown repo identifier", async () => {
    const r = await auditHonoSecurity("local/nonexistent");
    expect(r.error).toBeDefined();
  });
});
