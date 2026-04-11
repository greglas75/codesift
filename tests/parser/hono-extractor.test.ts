import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HonoExtractor } from "../../src/parser/extractors/hono.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "hono");

describe("HonoExtractor — subapp-app", () => {
  const subappEntry = path.join(FIXTURES, "subapp-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("flattens routes from sub-routers with fully-resolved paths", async () => {
    const model = await extractor.parse(subappEntry);
    const paths = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    // index.ts: GET /health
    // users: GET /api/users, GET /api/users/:id, POST /api/users
    // admin: GET /api/admin/settings, PUT /api/admin/settings, GET /api/admin/users, DELETE /api/admin/users/:id
    expect(paths).toContain("GET /health");
    expect(paths).toContain("GET /api/users");
    expect(paths).toContain("GET /api/users/:id");
    expect(paths).toContain("POST /api/users");
    expect(paths).toContain("GET /api/admin/settings");
    expect(paths).toContain("PUT /api/admin/settings");
    expect(paths).toContain("GET /api/admin/users");
    expect(paths).toContain("DELETE /api/admin/users/:id");
    expect(model.routes.length).toBe(8);
  });

  it("records all three source files in files_used", async () => {
    const model = await extractor.parse(subappEntry);
    expect(model.files_used.length).toBeGreaterThanOrEqual(3);
    const basenames = model.files_used.map((f) => path.basename(f)).sort();
    expect(basenames).toContain("index.ts");
    expect(basenames).toContain("users.ts");
    expect(basenames).toContain("admin.ts");
  });

  it("records mounts for app.route() calls", async () => {
    const model = await extractor.parse(subappEntry);
    expect(model.mounts.length).toBe(2);
    const mountPaths = model.mounts.map((m) => m.mount_path).sort();
    expect(mountPaths).toEqual(["/api/admin", "/api/users"]);
    for (const mount of model.mounts) {
      expect(mount.mount_type).toBe("hono_route");
      expect(mount.parent_var).toBe("app");
    }
  });

  it("sub-router routes reference the sub-router file, not the entry", async () => {
    const model = await extractor.parse(subappEntry);
    const usersRoutes = model.routes.filter((r) =>
      r.path.startsWith("/api/users"),
    );
    for (const r of usersRoutes) {
      expect(path.basename(r.file)).toBe("users.ts");
    }
  });
});

describe("HonoExtractor — factory-app", () => {
  const factoryEntry = path.join(FIXTURES, "factory-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("detects factory.createApp() with non-app variable name (AC-R8)", async () => {
    const model = await extractor.parse(factoryEntry);
    expect(model.app_variables.api).toBeDefined();
    expect(model.app_variables.api?.created_via).toBe("factory.createApp");
    expect(model.app_variables.api?.variable_name).toBe("api");
  });

  it("extracts routes on non-app variable", async () => {
    const model = await extractor.parse(factoryEntry);
    expect(model.routes.length).toBe(3);
    const paths = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual(["GET /env", "GET /ping", "POST /data"]);
    for (const r of model.routes) {
      expect(r.owner_var).toBe("api");
    }
  });

  it("detects Cloudflare Workers runtime from wrangler.toml (AC-A3)", async () => {
    const model = await extractor.parse(factoryEntry);
    expect(model.runtime).toBe("cloudflare");
  });

  it("extracts env bindings from Bindings type literal and c.env destructuring", async () => {
    const model = await extractor.parse(factoryEntry);
    // Should detect at minimum: DATABASE_URL from destructuring
    // Ideally also KV, AUTH_SECRET from the Bindings type
    expect(model.env_bindings).toContain("DATABASE_URL");
  });
});

describe("HonoExtractor — basepath-app", () => {
  const basepathEntry = path.join(FIXTURES, "basepath-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("resolves basePath prefix onto child routes (AC-R6)", async () => {
    const model = await extractor.parse(basepathEntry);
    const paths = model.routes.map((r) => `${r.method} ${r.path}`);
    const appVarNames = Object.keys(model.app_variables);
    // Debug: ensure v1 was detected as basePath-derived variable
    expect(appVarNames).toContain("v1");
    expect(model.app_variables.v1?.created_via).toBe("basePath");
    expect(model.app_variables.v1?.base_path).toBe("/v1");
    expect(paths).toContain("GET /v1/users");
    expect(paths).toContain("POST /v1/users");
  });

  it("detects app.all() as method ALL (AC-R3)", async () => {
    const model = await extractor.parse(basepathEntry);
    const allRoute = model.routes.find((r) => r.method === "ALL");
    expect(allRoute).toBeDefined();
    expect(allRoute?.path).toBe("/api/*");
  });

  it("fans out app.on([methods], path) into multiple routes (AC-R4)", async () => {
    const model = await extractor.parse(basepathEntry);
    const formRoutes = model.routes.filter((r) => r.path === "/form");
    expect(formRoutes).toHaveLength(2);
    const methods = formRoutes.map((r) => r.method).sort();
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("extracts regex constraint from :id{[0-9]+} (AC-R5)", async () => {
    const model = await extractor.parse(basepathEntry);
    const postRoute = model.routes.find((r) =>
      r.path.includes("/posts/"),
    );
    expect(postRoute).toBeDefined();
    expect(postRoute?.regex_constraint).toEqual({ id: "[0-9]+" });
  });

  it("records app.mount() as a hono_mount mount (AC-R7)", async () => {
    const model = await extractor.parse(basepathEntry);
    const legacyMount = model.mounts.find((m) => m.mount_path === "/legacy");
    expect(legacyMount).toBeDefined();
    expect(legacyMount?.mount_type).toBe("hono_mount");
  });
});

describe("HonoExtractor — basic-app", () => {
  const basicEntry = path.join(FIXTURES, "basic-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("detects the `app` variable as a new Hono() instance", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.app_variables.app).toBeDefined();
    expect(model.app_variables.app?.variable_name).toBe("app");
    expect(model.app_variables.app?.created_via).toBe("new Hono");
    expect(model.app_variables.app?.base_path).toBe("");
  });

  it("extracts all 5 routes from the basic app", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.routes).toHaveLength(5);

    const paths = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual([
      "GET /",
      "GET /health",
      "GET /users/:id",
      "PATCH /users/:id",
      "POST /users",
    ]);
  });

  it("records the entry file as absolute path in files_used", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.files_used).toContain(basicEntry);
    expect(model.entry_file).toBe(basicEntry);
  });

  it("marks extraction_status as partial (middleware/context/openapi not yet extracted)", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.extraction_status).toBe("partial");
    expect(model.skip_reasons.middleware_not_extracted).toBe(1);
  });

  it("every route references the same owner_var", async () => {
    const model = await extractor.parse(basicEntry);
    for (const route of model.routes) {
      expect(route.owner_var).toBe("app");
    }
  });
});
