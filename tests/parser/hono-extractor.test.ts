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

  it("tracks c.set() and c.var access as context flow (AC-C1)", async () => {
    const model = await extractor.parse(subappEntry);
    const userId = model.context_vars.find((cv) => cv.name === "userId");
    expect(userId).toBeDefined();
    expect(userId?.set_points.length).toBeGreaterThanOrEqual(1);
    expect(userId?.get_points.length).toBeGreaterThanOrEqual(1);
    expect(userId?.is_env_binding).toBe(false);
  });

  it("marks conditional c.set() inside if-branch (AC-C2)", async () => {
    const model = await extractor.parse(subappEntry);
    const role = model.context_vars.find((cv) => cv.name === "role");
    expect(role).toBeDefined();
    const condSetPoint = role?.set_points.find(
      (sp) => sp.condition === "conditional",
    );
    expect(condSetPoint).toBeDefined();
  });

  it("detects RPC type exports and classifies slow vs fast pattern (AC-R9 RPC)", async () => {
    const model = await extractor.parse(subappEntry);
    expect(model.rpc_exports.length).toBe(2);
    const appExport = model.rpc_exports.find((e) => e.export_name === "AppType");
    expect(appExport).toBeDefined();
    expect(appExport?.shape).toBe("full_app");
    expect(appExport?.source_var).toBe("app");
    const userExport = model.rpc_exports.find((e) => e.export_name === "UserRoutes");
    expect(userExport).toBeDefined();
    expect(userExport?.shape).toBe("route_group");
    expect(userExport?.source_var).toBe("usersRouter");
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

describe("HonoExtractor — openapi-app", () => {
  const openapiEntry = path.join(FIXTURES, "openapi-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("detects OpenAPIHono as an app variable (AC-R9 partial)", async () => {
    const model = await extractor.parse(openapiEntry);
    expect(model.app_variables.app).toBeDefined();
    expect(model.app_variables.app?.created_via).toBe("OpenAPIHono");
  });

  it("extracts openapi_routes from createRoute() definitions", async () => {
    const model = await extractor.parse(openapiEntry);
    expect(model.openapi_routes.length).toBe(2);
    const methods = model.openapi_routes.map((r) => r.method).sort();
    expect(methods).toEqual(["get", "get"]);
    const openapiPaths = model.openapi_routes.map((r) => r.path).sort();
    expect(openapiPaths).toEqual(["/users", "/users/{id}"]);
  });

  it("converts OpenAPI {param} path to Hono :param path", async () => {
    const model = await extractor.parse(openapiEntry);
    const userRoute = model.openapi_routes.find((r) => r.path === "/users/{id}");
    expect(userRoute).toBeDefined();
    expect(userRoute?.hono_path).toBe("/users/:id");
  });

  it("also registers openapi routes in the main routes array", async () => {
    const model = await extractor.parse(openapiEntry);
    // 2 openapi routes + 1 regular GET /health = 3 total
    expect(model.routes.length).toBe(3);
    const paths = model.routes.map((r) => r.path).sort();
    expect(paths).toContain("/users/:id");
    expect(paths).toContain("/users");
    expect(paths).toContain("/health");
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

  it("marks extraction_status as complete for well-formed app", async () => {
    const model = await extractor.parse(basicEntry);
    expect(model.extraction_status).toBe("complete");
  });

  it("extracts middleware chains with third-party classification (AC-M5)", async () => {
    const model = await extractor.parse(basicEntry);
    const globalChain = model.middleware_chains.find((mc) => mc.scope === "*");
    expect(globalChain).toBeDefined();
    const loggerEntry = globalChain?.entries.find((e) => e.name === "logger");
    expect(loggerEntry?.is_third_party).toBe(true);
    expect(loggerEntry?.imported_from).toBe("hono/logger");
    const corsEntry = globalChain?.entries.find((e) => e.name === "cors");
    expect(corsEntry?.is_third_party).toBe(true);
    expect(corsEntry?.imported_from).toBe("hono/cors");
  });

  it("detects inline arrow middleware as <inline> (AC-M2)", async () => {
    const model = await extractor.parse(basicEntry);
    const globalChain = model.middleware_chains.find((mc) => mc.scope === "*");
    const inlineEntry = globalChain?.entries.find((e) => e.name === "<inline>");
    expect(inlineEntry).toBeDefined();
    expect(inlineEntry?.inline).toBe(true);
  });

  it("expands some() from hono/combine with conditional flag (AC-M1)", async () => {
    const model = await extractor.parse(basicEntry);
    const apiChain = model.middleware_chains.find((mc) => mc.scope === "/api/*");
    expect(apiChain).toBeDefined();
    const expanded = apiChain?.entries.filter((e) => e.expanded_from === "some");
    expect(expanded?.length).toBe(2);
    const names = expanded?.map((e) => e.name).sort();
    expect(names).toEqual(["authMw", "publicMw"]);
    for (const e of expanded ?? []) {
      expect(e.conditional).toBe(true);
    }
  });

  it("expands spread array middleware (AC-M4)", async () => {
    const model = await extractor.parse(basicEntry);
    const adminChain = model.middleware_chains.find((mc) => mc.scope === "/admin/*");
    expect(adminChain).toBeDefined();
    const names = adminChain?.entries.map((e) => e.name);
    expect(names).toContain("authMw");
    expect(names).toContain("tenantMw");
  });

  it("every route references the same owner_var", async () => {
    const model = await extractor.parse(basicEntry);
    for (const route of model.routes) {
      expect(route.owner_var).toBe("app");
    }
  });
});
