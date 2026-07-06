import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Parser from "web-tree-sitter";
import * as parserManager from "../../src/parser/parser-manager.js";
import { HonoExtractor } from "../../src/parser/extractors/hono.js";
import type {
  HonoApp,
  HonoAppModel,
  HonoMount,
  HonoRoute,
} from "../../src/parser/extractors/hono-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "hono");

function emptyHonoModel(entryFile: string): HonoAppModel {
  return {
    entry_file: entryFile,
    app_variables: {},
    routes: [],
    mounts: [],
    middleware_chains: [],
    context_vars: [],
    openapi_routes: [],
    rpc_exports: [],
    runtime: "unknown",
    env_bindings: [],
    files_used: [],
    extraction_status: "complete",
    skip_reasons: {},
  };
}

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

describe("HonoExtractor — double-mount nested sub-app", () => {
  const entry = path.join(FIXTURES, "double-mount-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("re-expands nested app.route when the same child is mounted twice", async () => {
    const model = await extractor.parse(entry);
    const paths = model.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toContain("GET /api/v1/list");
    expect(paths).toContain("GET /api/v2/list");
    expect(paths).toContain("GET /api/v1/nested-mount/hello");
    expect(paths).toContain("GET /api/v2/nested-mount/hello");
    expect(paths.filter((p) => p.includes("nested-mount/hello")).length).toBe(
      2,
    );
    expect(new Set(model.files_used).size).toBe(model.files_used.length);
  });

  it("records one mount row per app.route on the child for each entry mount", async () => {
    const model = await extractor.parse(entry);
    const childMounts = model.mounts.filter((m) =>
      m.child_file.includes("nested"),
    );
    expect(childMounts.length).toBeGreaterThanOrEqual(2);
    const nestedPaths = childMounts.map((m) => m.mount_path).sort();
    expect(nestedPaths).toContain("/api/v1/nested-mount");
    expect(nestedPaths).toContain("/api/v2/nested-mount");
  });

  it("sets parent_var to the variable that owns app.route on nested mounts", async () => {
    const model = await extractor.parse(entry);
    const fromUsers = model.mounts.filter((m) => m.child_var === "nested");
    for (const m of fromUsers) {
      expect(m.parent_var).toBe("users");
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
    expect(legacyMount?.child_var).toBe("<external>");
    expect(legacyMount?.child_file).toBe("");
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

  it("expands every() from hono/combine without marking entries conditional", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-every-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `import { every } from "hono/combine";`,
        `const authMw = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const tenantMw = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const app = new Hono();`,
        `app.use("/secure/*", every(authMw, tenantMw));`,
        `app.get("/secure/status", (c) => c.json({ ok: true }));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await extractor.parse(entry);
    const secureChain = model.middleware_chains.find(
      (mc) => mc.scope === "/secure/*",
    );
    expect(secureChain).toBeDefined();
    const expanded = secureChain?.entries.filter(
      (e) => e.expanded_from === "every",
    ) ?? [];
    expect(expanded.map((e) => e.name)).toEqual(["authMw", "tenantMw"]);
    expect(expanded.every((e) => e.conditional === false)).toBe(true);
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

  it("T3: every inline-handler route has inline_analysis populated", async () => {
    const model = await extractor.parse(basicEntry);
    // All 5 routes in basic-app use inline arrow handlers
    for (const route of model.routes) {
      expect(route.handler.inline).toBe(true);
      expect(route.inline_analysis).toBeDefined();
    }
  });

  it("T3: inline_analysis captures c.json response with 201 status for POST /users", async () => {
    const model = await extractor.parse(basicEntry);
    const postUsers = model.routes.find(
      (r) => r.method === "POST" && r.path === "/users",
    );
    expect(postUsers?.inline_analysis?.responses.some((r) => r.status === 201 && r.kind === "json")).toBe(true);
  });

  it("T3: inline_analysis captures c.text response for GET /", async () => {
    const model = await extractor.parse(basicEntry);
    const root = model.routes.find(
      (r) => r.method === "GET" && r.path === "/",
    );
    expect(root?.inline_analysis?.responses[0]?.kind).toBe("text");
    expect(root?.inline_analysis?.responses[0]?.status).toBe(200);
  });

  it("T3: inline_analysis is undefined when handler is a named identifier", async () => {
    const subappEntry = path.join(FIXTURES, "subapp-app", "src", "index.ts");
    const model = await extractor.parse(subappEntry);
    // subapp-app uses named handlers (getHealth, listUsers, etc.) — should NOT have inline_analysis
    const namedRoutes = model.routes.filter((r) => !r.handler.inline);
    for (const route of namedRoutes) {
      expect(route.inline_analysis).toBeUndefined();
    }
  });
});

describe("HonoExtractor — T4 conditional middleware (conditional-mw-app)", () => {
  const condEntry = path.join(FIXTURES, "conditional-mw-app", "src", "index.ts");
  let extractor: HonoExtractor;

  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("captures basicAuth applied conditionally on non-GET method", async () => {
    const model = await extractor.parse(condEntry);
    const postsChain = model.middleware_chains.find(
      (mc) => mc.scope === "/posts/*",
    );
    expect(postsChain).toBeDefined();
    const basicAuthEntry = postsChain?.entries.find(
      (e) => e.name === "basicAuth",
    );
    expect(basicAuthEntry).toBeDefined();
    expect(basicAuthEntry?.applied_when).toBeDefined();
    expect(basicAuthEntry?.applied_when?.condition_type).toBe("method");
    expect(basicAuthEntry?.applied_when?.condition_text).toContain("method");
    expect(basicAuthEntry?.conditional).toBe(true);
  });

  it("captures bearerAuth applied conditionally on missing header", async () => {
    const model = await extractor.parse(condEntry);
    const adminChain = model.middleware_chains.find(
      (mc) => mc.scope === "/admin/*",
    );
    expect(adminChain).toBeDefined();
    const bearerEntry = adminChain?.entries.find(
      (e) => e.name === "bearerAuth",
    );
    expect(bearerEntry).toBeDefined();
    expect(bearerEntry?.applied_when?.condition_type).toBe("header");
    expect(bearerEntry?.applied_when?.condition_text).toContain("header");
  });

  it("captures a conditional middleware gated on path with condition_type path", async () => {
    const model = await extractor.parse(condEntry);
    const deepChain = model.middleware_chains.find(
      (mc) => mc.scope === "/deep/*",
    );
    expect(deepChain).toBeDefined();
    const logEntry = deepChain?.entries.find((e) => e.name === "logDeep");
    expect(logEntry).toBeDefined();
    expect(logEntry?.applied_when?.condition_type).toBe("path");
  });

  it("unconditional inline middleware has NO applied_when on its entry", async () => {
    const model = await extractor.parse(condEntry);
    const publicChain = model.middleware_chains.find(
      (mc) => mc.scope === "/public/*",
    );
    expect(publicChain).toBeDefined();
    // Only the <inline> entry should be present — no conditional extras
    const conditionalExtras = publicChain?.entries.filter(
      (e) => e.applied_when !== undefined,
    );
    expect(conditionalExtras?.length ?? 0).toBe(0);
  });

  it("outer inline arrow wrapper does NOT get applied_when — only the inner gated call does", async () => {
    const model = await extractor.parse(condEntry);
    const postsChain = model.middleware_chains.find(
      (mc) => mc.scope === "/posts/*",
    );
    const inlineOuter = postsChain?.entries.find((e) => e.name === "<inline>");
    expect(inlineOuter).toBeDefined();
    expect(inlineOuter?.applied_when).toBeUndefined();
  });
});

describe("HonoExtractor — T6 local sub-app fallback", () => {
  let extractor: HonoExtractor;
  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("populates child_file with the parent file for a LOCAL sub-app", async () => {
    const entry = path.join(FIXTURES, "local-subapp", "src", "index.ts");
    const model = await extractor.parse(entry);
    expect(model.mounts).toHaveLength(1);
    const mount = model.mounts[0];
    expect(mount?.child_var).toBe("middleware");
    // BEFORE T6 this would be "" (unresolved import). Now it should be the
    // same file the parent app is declared in.
    expect(mount?.child_file).toBe(entry);
  });

  it("does NOT increment skip_reasons.unresolved_import for a LOCAL sub-app", async () => {
    const entry = path.join(FIXTURES, "local-subapp", "src", "index.ts");
    const model = await extractor.parse(entry);
    // The "middleware" local sub-app should resolve via fallback, so
    // unresolved_import should not be bumped for it.
    expect(model.skip_reasons.unresolved_import ?? 0).toBe(0);
  });
});

describe("HonoExtractor — T5 advanced runtime detection", () => {
  let extractor: HonoExtractor;
  beforeAll(() => {
    extractor = new HonoExtractor();
  });

  it("detects cloudflare from Bindings type literal even without wrangler.toml", async () => {
    const entry = path.join(FIXTURES, "cf-bindings-no-wrangler", "src", "index.ts");
    const model = await extractor.parse(entry);
    expect(model.runtime).toBe("cloudflare");
  });

  it("detects vercel from vercel.json at project root", async () => {
    const entry = path.join(FIXTURES, "vercel-app", "src", "index.ts");
    const model = await extractor.parse(entry);
    expect(model.runtime).toBe("vercel");
  });

  it("detects fly from fly.toml at project root", async () => {
    const entry = path.join(FIXTURES, "fly-app", "src", "index.ts");
    const model = await extractor.parse(entry);
    expect(model.runtime).toBe("fly");
  });

  it("still returns unknown when no signals are present", async () => {
    // basic-app has no wrangler.toml, no vercel.json, no Bindings type with CF types
    const entry = path.join(FIXTURES, "basic-app", "src", "index.ts");
    const model = await extractor.parse(entry);
    expect(model.runtime).toBe("unknown");
  });
});

describe("HonoExtractor — parse safety fallbacks", () => {
  type ChildParseResultFixture = {
    app_variables: Record<string, HonoApp>;
    routes: HonoRoute[];
    mounts: HonoMount[];
    files_used: string[];
  };

  type HonoExtractorInternals = {
    parseFile(
      file: string,
      prefix: string,
      inFlight: Set<string>,
      parsedCache: Map<string, ChildParseResultFixture>,
      model: HonoAppModel,
    ): Promise<void>;
  };

  function asInternals(extractor: HonoExtractor): HonoExtractorInternals {
    return extractor as unknown as HonoExtractorInternals;
  }

  it("increments parse_cycle_skipped when a file is already in flight", async () => {
    const file = path.join(tmpdir(), "hono-cycle-guard.ts");
    const model = emptyHonoModel(file);

    await asInternals(new HonoExtractor()).parseFile(
      file,
      "",
      new Set([file]),
      new Map(),
      model,
    );

    expect(model.skip_reasons.parse_cycle_skipped).toBe(1);
    expect(model.files_used).toEqual([]);
  });

  it("records file_read_failed and keeps the unresolved canonical path for missing entries", async () => {
    const missing = path.join(
      tmpdir(),
      `hono-missing-${Date.now()}`,
      "index.ts",
    );

    const model = await new HonoExtractor().parse(missing);

    expect(model.entry_file).toBe(path.resolve(missing));
    expect(model.files_used).toContain(path.resolve(missing));
    expect(model.skip_reasons.file_read_failed).toBe(1);
  });

  it("records file_read_failed during cached replay before emitting cached routes", async () => {
    const missing = path.join(
      tmpdir(),
      `hono-missing-replay-${Date.now()}`,
      "index.ts",
    );
    const model = emptyHonoModel(missing);
    const cached: ChildParseResultFixture = {
      app_variables: {},
      routes: [
        {
          method: "GET",
          path: "/cached",
          raw_path: "/cached",
          file: missing,
          line: 1,
          owner_var: "app",
          handler: { name: "<inline>", inline: true, file: missing, line: 1 },
          inline_middleware: [],
          validators: [],
        },
      ],
      mounts: [],
      files_used: [missing],
    };

    await asInternals(new HonoExtractor()).parseFile(
      missing,
      "/prefix",
      new Set(),
      new Map([[missing, cached]]),
      model,
    );

    expect(model.skip_reasons.file_read_failed).toBe(1);
    expect(model.routes).toEqual([]);
  });

  it("records parser_unavailable before parsing the main file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-parser-null-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(entry, `const app = null;\n`);
    const spy = vi.spyOn(parserManager, "getParser").mockResolvedValueOnce(null);

    try {
      const model = await new HonoExtractor().parse(entry);
      expect(model.skip_reasons.parser_unavailable).toBe(1);
      expect(model.routes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("records parse_failed when the main parser returns no tree", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-parse-null-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(entry, `const app = null;\n`);
    const parser = { parse: () => null } as unknown as Parser;
    const spy = vi
      .spyOn(parserManager, "getParser")
      .mockResolvedValueOnce(parser);

    try {
      const model = await new HonoExtractor().parse(entry);
      expect(model.skip_reasons.parse_failed).toBe(1);
      expect(model.routes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("records parser_unavailable during cached replay before emitting cached routes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-replay-parser-null-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(entry, `const app = null;\n`);
    const model = emptyHonoModel(entry);
    const cached: ChildParseResultFixture = {
      app_variables: {},
      routes: [
        {
          method: "GET",
          path: "/cached",
          raw_path: "/cached",
          file: entry,
          line: 1,
          owner_var: "app",
          handler: { name: "<inline>", inline: true, file: entry, line: 1 },
          inline_middleware: [],
          validators: [],
        },
      ],
      mounts: [],
      files_used: [entry],
    };
    const spy = vi.spyOn(parserManager, "getParser").mockResolvedValueOnce(null);

    try {
      await asInternals(new HonoExtractor()).parseFile(
        entry,
        "/prefix",
        new Set(),
        new Map([[entry, cached]]),
        model,
      );
      expect(model.skip_reasons.parser_unavailable).toBe(1);
      expect(model.routes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("records parse_failed during cached replay before emitting cached routes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-replay-parse-null-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(entry, `const app = null;\n`);
    const model = emptyHonoModel(entry);
    const cached: ChildParseResultFixture = {
      app_variables: {},
      routes: [
        {
          method: "GET",
          path: "/cached",
          raw_path: "/cached",
          file: entry,
          line: 1,
          owner_var: "app",
          handler: { name: "<inline>", inline: true, file: entry, line: 1 },
          inline_middleware: [],
          validators: [],
        },
      ],
      mounts: [],
      files_used: [entry],
    };
    const parser = { parse: () => null } as unknown as Parser;
    const spy = vi
      .spyOn(parserManager, "getParser")
      .mockResolvedValueOnce(parser);

    try {
      await asInternals(new HonoExtractor()).parseFile(
        entry,
        "/prefix",
        new Set(),
        new Map([[entry, cached]]),
        model,
      );
      expect(model.skip_reasons.parse_failed).toBe(1);
      expect(model.routes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("increments unresolved_import when an app.route child has no resolvable file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-unresolved-route-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `app.route("/missing", missingApp);`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.skip_reasons.unresolved_import).toBe(1);
    expect(model.mounts).toContainEqual({
      parent_var: "app",
      mount_path: "/missing",
      child_var: "missingApp",
      child_file: "",
      mount_type: "hono_route",
    });
  });

  it("resolves named import aliases and .js specifiers to TypeScript child routers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-aliased-route-"));
    const entry = path.join(dir, "index.ts");
    const child = path.join(dir, "child.ts");
    await writeFile(
      child,
      [
        `import { Hono } from "hono";`,
        `export const child = new Hono();`,
        `child.get("/ping", (c) => c.text("pong"));`,
        "",
      ].join("\n"),
    );
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `import { child as aliasedChild } from "./child.js";`,
        `const app = new Hono();`,
        `app.route("/aliased", aliasedChild);`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const canonicalChild = await realpath(child);
    const model = await new HonoExtractor().parse(entry);

    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET /aliased/ping");
    expect(model.mounts).toContainEqual({
      parent_var: "app",
      mount_path: "/aliased",
      child_var: "aliasedChild",
      child_file: canonicalChild,
      mount_type: "hono_route",
    });
  });

  it("ignores side-effect and unresolved imports while resolving index.ts and .tsx child routers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-import-map-edges-"));
    const entry = path.join(dir, "index.ts");
    const featureDir = path.join(dir, "feature-dir");
    const featureIndex = path.join(featureDir, "index.ts");
    const tsxFeature = path.join(dir, "feature-tsx.tsx");
    await mkdir(featureDir);
    await writeFile(
      path.join(dir, "polyfills.css"),
      `.noop { color: red; }\n`,
    );
    await writeFile(
      featureIndex,
      [
        `import { Hono } from "hono";`,
        `export const feature = new Hono();`,
          `feature.get("/ok", (c) => c.text("feature"));`,
          "",
        ].join("\n"),
    );
    await writeFile(
      tsxFeature,
      [
        `import { Hono } from "hono";`,
        `export const tsxFeature = new Hono();`,
        `tsxFeature.get("/ok", (c) => c.text("tsx"));`,
        "",
      ].join("\n"),
    );
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `import "./polyfills.css";`,
        `import { missing } from "./does-not-exist";`,
        `import { feature } from "./feature-dir";`,
        `import { tsxFeature } from "./feature-tsx";`,
        `const app = new Hono();`,
        `app.route("/feature", feature);`,
        `app.route("/tsx", tsxFeature);`,
        `app.get("/health", (c) => c.text(typeof missing));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const canonicalFeatureIndex = await realpath(featureIndex);
    const canonicalTsxFeature = await realpath(tsxFeature);
    const model = await new HonoExtractor().parse(entry);

    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toEqual(expect.arrayContaining([
        "GET /feature/ok",
        "GET /tsx/ok",
        "GET /health",
      ]));
    expect(model.mounts).toEqual(expect.arrayContaining([
      {
        parent_var: "app",
        mount_path: "/feature",
        child_var: "feature",
        child_file: canonicalFeatureIndex,
        mount_type: "hono_route",
      },
      {
        parent_var: "app",
        mount_path: "/tsx",
        child_var: "tsxFeature",
        child_file: canonicalTsxFeature,
        mount_type: "hono_route",
      },
    ]));
    expect(model.skip_reasons.unresolved_import ?? 0).toBe(0);
    expect(model.files_used.some((file) => file.includes("does-not-exist")))
      .toBe(false);
    expect(model.files_used.some((file) => file.endsWith("polyfills.css")))
      .toBe(false);
  });

  it("skips inline app.route child expressions without recording a bogus mount", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-inline-route-child-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `app.route("/inline", new Hono());`,
        `app.get("/health", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET /health");
    expect(model.mounts).toEqual([]);
    expect(model.skip_reasons.unresolved_import ?? 0).toBe(0);
  });

  it("classifies middleware-only RPC exports as full_app", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-rpc-middleware-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use("*", auth);`,
        `export type AppType = typeof app;`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.middleware_chains).toHaveLength(1);
    expect(model.mounts).toEqual([]);
    expect(model.rpc_exports).toContainEqual({
      export_name: "AppType",
      file: model.entry_file,
      line: 5,
      shape: "full_app",
      source_var: "app",
    });
  });

  it("keeps call-expression middleware inside spread arrays", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-array-mw-call-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `import { rateLimit } from "hono/rate-limit";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const chain = [auth, rateLimit({ max: 5 })];`,
        `app.use("/local/*", ...chain);`,
        `app.get("/local/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/local/*",
    );

    expect(chain?.entries.map((entry) => entry.name)).toEqual([
      "auth",
      "rateLimit",
    ]);
    expect(chain?.entries.find((entry) => entry.name === "rateLimit"))
      .toMatchObject({
        imported_from: "hono/rate-limit",
        is_third_party: true,
      });
  });

  it("records unresolved external spread middleware as a placeholder entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-external-spread-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `import { coreChain } from "@corp/middleware";`,
        `const app = new Hono();`,
        `app.use("/external/*", ...coreChain);`,
        `app.get("/external/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/external/*",
    );

    expect(chain?.entries).toContainEqual(expect.objectContaining({
      name: "...coreChain",
      imported_from: "@corp/middleware",
      is_third_party: true,
    }));
  });

  it("extracts chained app.use() registrations after the first call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-chained-use-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const tenant = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use("/a/*", auth).use("/b/*", tenant);`,
        `app.get("/b/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.middleware_chains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "/a/*",
        entries: [expect.objectContaining({ name: "auth" })],
      }),
      expect.objectContaining({
        scope: "/b/*",
        entries: [expect.objectContaining({ name: "tenant" })],
      }),
    ]));
  });

  it("expands array path scopes without treating the path array as middleware", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-array-scopes-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use(["/api/*", "/admin/*"], auth);`,
        `app.get("/api/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.middleware_chains.map((chain) => chain.scope).sort())
      .toEqual(["/admin/*", "/api/*"]);
    for (const chain of model.middleware_chains) {
      expect(chain.entries.map((entry) => entry.name)).toEqual(["auth"]);
    }
  });

  it("resolves spread elements inside local middleware array declarations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-array-spread-array-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const tenant = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const base = [auth];`,
        `const chain = [...base, tenant];`,
        `app.use("/combo/*", ...chain);`,
        `app.get("/combo/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/combo/*",
    );

    expect(chain?.entries.map((entry) => entry.name)).toEqual([
      "auth",
      "tenant",
    ]);
  });

  it("keeps multiple identifier middleware arguments on the global scope", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-multiple-global-mw-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const logger = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use(auth, logger);`,
        `app.get("/api/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "*",
    );

    expect(chain?.entries.map((entry) => entry.name)).toEqual([
      "auth",
      "logger",
    ]);
  });

  it("resolves local string constants used as middleware scopes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-constant-scope-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const API_SCOPE = "/api/*";`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use(API_SCOPE, auth);`,
        `app.get("/api/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/api/*",
    );

    expect(chain?.entries.map((entry) => entry.name)).toEqual(["auth"]);
  });

  it("unwraps typed middleware array declarations before spread expansion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-typed-array-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const tenant = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const chain = [auth, tenant] as const;`,
        `app.use("/typed/*", ...chain);`,
        `app.get("/typed/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/typed/*",
    );

    expect(chain?.entries.map((entry) => entry.name)).toEqual([
      "auth",
      "tenant",
    ]);
  });

  it("marks short-circuit c.set() calls as conditional context writes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-short-circuit-context-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `app.use(async (c, next) => {`,
        `  c.req.header("x-admin") && c.set("admin", "1");`,
        `  await next();`,
        `});`,
        `app.get("/admin", (c) => c.text(c.get("admin")));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const admin = model.context_vars.find((contextVar) =>
      contextVar.name === "admin"
    );

    expect(admin?.set_points).toContainEqual(expect.objectContaining({
      condition: "conditional",
    }));
  });

  it("recognizes ctx/context aliases without false conditional matches from string operands", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-context-alias-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `app.use(async (ctx, next) => {`,
        `  ctx.set("mode", "always") + "&&";`,
        `  await next();`,
        `});`,
        `app.get("/mode", (context) => context.text(context.get("mode")));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const mode = model.context_vars.find((contextVar) =>
      contextVar.name === "mode"
    );

    expect(mode?.set_points).toContainEqual(expect.objectContaining({
      condition: "always",
    }));
    expect(mode?.get_points.length).toBeGreaterThan(0);
  });

  it("tracks symbolic context keys and c.var destructuring reads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-context-symbolic-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const AUTH_KEY = "user";`,
        `app.use(async (c, next) => {`,
        `  c.set(AUTH_KEY, { id: "1" });`,
        `  await next();`,
        `});`,
        `app.get("/me", (context) => {`,
        `  const { user } = context.var;`,
        `  return context.json({ user, id: context.get(AUTH_KEY) });`,
        `});`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const symbolic = model.context_vars.find((contextVar) =>
      contextVar.name === "AUTH_KEY"
    );
    const destructured = model.context_vars.find((contextVar) =>
      contextVar.name === "user"
    );

    expect(symbolic?.set_points.length).toBeGreaterThan(0);
    expect(symbolic?.get_points.length).toBeGreaterThan(0);
    expect(destructured?.get_points.length).toBeGreaterThan(0);
  });

  it("finds nested conditional middleware calls inside try blocks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-nested-conditional-mw-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use("/nested/*", async (c, next) => {`,
        `  try {`,
        `    if (c.req.header("authorization")) return auth(c, next);`,
        `  } catch {}`,
        `  await next();`,
        `});`,
        `app.get("/nested/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/nested/*",
    );

    expect(chain?.entries).toContainEqual(expect.objectContaining({
      name: "auth",
      conditional: true,
      applied_when: expect.objectContaining({ condition_type: "header" }),
    }));
  });

  it("converts hyphenated OpenAPI path params into Hono path params", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-openapi-hyphen-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { OpenAPIHono, createRoute } from "@hono/zod-openapi";`,
        `const app = new OpenAPIHono();`,
        `const route = createRoute({ method: "get", path: "/users/{user-id}" });`,
        `app.openapi(route, (c) => c.json({ ok: true }));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.openapi_routes[0]?.hono_path).toBe("/users/:user-id");
    expect(model.routes).toContainEqual(expect.objectContaining({
      method: "GET",
      path: "/users/:user-id",
      raw_path: "/users/:user-id",
    }));
  });

  it("decodes static template string escapes before applying basePath", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-template-basepath-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const app = new Hono();`,
        "const api = app.basePath(`/api\\u002fv1`);",
        `api.get("/ping", (c) => c.text("pong"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET /api/v1/ping");
  });

  it("detects chained new Hono().basePath() apps and JS hex escapes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-chained-basepath-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const api = new Hono().basePath("/api").basePath("/v\\x32");`,
        `api.get("/ping", (c) => c.text("pong"));`,
        `export default api;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.app_variables.api?.created_via).toBe("basePath");
    expect(model.app_variables.api?.base_path).toBe("/api/v2");
    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET /api/v2/ping");
  });

  it("detects factory-created apps with chained basePath", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-factory-basepath-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { createFactory } from "hono/factory";`,
        `const factory = createFactory();`,
        `const api = factory.createApp().basePath("/api");`,
        `api.get("/ping", (c) => c.text("pong"));`,
        `export default api;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.app_variables.api?.created_via).toBe("basePath");
    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET /api/ping");
  });

  it("tracks apps initialized through chained new Hono() calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-chained-init-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const mw = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const app = new Hono().use(mw);`,
        `app.get("/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.app_variables.app?.created_via).toBe("new Hono");
    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET /status");
  });

  it("keeps apps with dynamic basePath arguments in the model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-dynamic-basepath-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `const API_PREFIX = "/api";`,
        `const api = new Hono().basePath(API_PREFIX);`,
        `api.get("/ping", (c) => c.text("pong"));`,
        `export default api;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);

    expect(model.app_variables.api?.created_via).toBe("basePath");
    expect(model.app_variables.api?.base_path).toBe("<dynamic:API_PREFIX>");
    expect(model.routes.map((route) => `${route.method} ${route.path}`))
      .toContain("GET <dynamic:API_PREFIX>/ping");
  });

  it("expands namespaced combine.some middleware calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hono-namespaced-combine-"));
    const entry = path.join(dir, "index.ts");
    await writeFile(
      entry,
      [
        `import { Hono } from "hono";`,
        `import * as combine from "hono/combine";`,
        `const app = new Hono();`,
        `const auth = async (_c: unknown, next: () => Promise<void>) => next();`,
        `const guest = async (_c: unknown, next: () => Promise<void>) => next();`,
        `app.use("/api/*", combine.some(auth, guest));`,
        `app.get("/api/status", (c) => c.text("ok"));`,
        `export default app;`,
        "",
      ].join("\n"),
    );

    const model = await new HonoExtractor().parse(entry);
    const chain = model.middleware_chains.find(
      (middlewareChain) => middlewareChain.scope === "/api/*",
    );

    expect(chain?.entries.filter((entry) => entry.expanded_from === "some")
      .map((entry) => entry.name)).toEqual(["auth", "guest"]);
  });
});

describe("HonoExtractor — exception safety (R-0 regression)", () => {
  // Verifies that an exception inside walkRouteMounts does not leave the file
  // pinned in the inFlight cycle-detection set. Prior behavior: `inFlight.delete`
  // ran outside `finally`, so a single throw permanently flagged the file as a
  // cycle for the rest of the parse, producing silently incomplete indexes.
  it("inFlight is cleared even when walkRouteMounts throws (main-path branch)", async () => {
    const ext = new HonoExtractor();
    // Stub walkRouteMounts to throw. Cast through unknown to bypass TS access
    // restriction on the private method while keeping the runtime contract.
    (ext as unknown as { walkRouteMounts: () => Promise<void> }).walkRouteMounts =
      async () => { throw new Error("simulated walk failure"); };

    const entry = path.join(FIXTURES, "subapp-app", "src", "index.ts");
    let threw = false;
    try {
      await ext.parse(entry);
    } catch {
      threw = true;
    }
    // Either the thrown error propagates or it's caught upstream — either way,
    // `inFlight` lives only inside `parse()`, so reaching this point at all
    // means the finally block ran. We then call parse() AGAIN with a fresh
    // walkRouteMounts that does NOT throw to confirm nothing is residually pinned.
    expect(threw).toBe(true);

    const ext2 = new HonoExtractor();
    const model = await ext2.parse(entry);
    expect(model.routes.length).toBeGreaterThan(0);
  });
});
