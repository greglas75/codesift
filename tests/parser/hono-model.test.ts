import { describe, it, expect } from "vitest";
import type {
  HonoAppModel,
  HonoApp,
  HonoRoute,
  HonoMount,
  MiddlewareChain,
  MiddlewareEntry,
  ContextVariable,
  ContextAccessPoint,
  HonoValidator,
  OpenAPIRoute,
  RPCExport,
  InlineHandlerAnalysis,
  ResponseEmission,
  ErrorEmission,
  ExternalCall,
  ContextAccess,
  ConditionalApplication,
  HonoModule,
} from "../../src/parser/extractors/hono-model.js";

describe("HonoAppModel types", () => {
  it("constructs a minimal valid HonoAppModel that round-trips through JSON", () => {
    const app: HonoApp = {
      variable_name: "app",
      file: "/repo/src/index.ts",
      line: 3,
      created_via: "new Hono",
      base_path: "",
    };

    const route: HonoRoute = {
      method: "GET",
      path: "/health",
      raw_path: "/health",
      file: "/repo/src/index.ts",
      line: 5,
      owner_var: "app",
      handler: {
        name: "<inline>",
        inline: true,
        file: "/repo/src/index.ts",
        line: 5,
      },
      inline_middleware: [],
      validators: [],
    };

    const entry: MiddlewareEntry = {
      name: "logger",
      order: 1,
      line: 4,
      file: "/repo/src/index.ts",
      inline: false,
      is_third_party: true,
      imported_from: "hono/logger",
      conditional: false,
    };

    const chain: MiddlewareChain = {
      scope: "global",
      scope_pattern: "*",
      owner_var: "app",
      entries: [entry],
    };

    const getPoint: ContextAccessPoint = {
      file: "/repo/src/index.ts",
      line: 5,
      scope: "handler",
      via_context_storage: false,
      condition: "always",
    };

    const contextVar: ContextVariable = {
      name: "userId",
      set_points: [],
      get_points: [getPoint],
      is_env_binding: false,
    };

    const validator: HonoValidator = {
      target: "json",
      schema_file: "/repo/src/schemas.ts",
      line: 10,
      kind: "zValidator",
    };
    // use validator to satisfy type contract
    expect(validator.target).toBe("json");

    const openapi: OpenAPIRoute = {
      id: "op1",
      method: "get",
      path: "/users/{id}",
      hono_path: "/users/:id",
      request_schemas: {},
      response_schemas: {},
      middleware: [],
      hidden: false,
      file: "/repo/src/index.ts",
      line: 20,
    };

    const rpcExport: RPCExport = {
      export_name: "AppType",
      file: "/repo/src/index.ts",
      line: 30,
      shape: "full_app",
      source_var: "app",
    };

    const mount: HonoMount = {
      parent_var: "app",
      mount_path: "/api",
      child_var: "apiRouter",
      child_file: "/repo/src/routes/api.ts",
      mount_type: "hono_route",
    };

    const model: HonoAppModel = {
      entry_file: "/repo/src/index.ts",
      app_variables: { app },
      routes: [route],
      mounts: [mount],
      middleware_chains: [chain],
      context_vars: [contextVar],
      openapi_routes: [openapi],
      rpc_exports: [rpcExport],
      runtime: "node",
      env_bindings: [],
      files_used: ["/repo/src/index.ts"],
      extraction_status: "complete",
      skip_reasons: {},
    };

    // Round-trip through JSON — critical because HIGH-2 in spec review required
    // Record<> instead of Map<> to ensure JSON serialization works.
    const json = JSON.stringify(model);
    const parsed = JSON.parse(json) as HonoAppModel;

    expect(parsed.entry_file).toBe("/repo/src/index.ts");
    expect(parsed.app_variables.app.variable_name).toBe("app");
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0]?.method).toBe("GET");
    expect(parsed.middleware_chains[0]?.entries[0]?.name).toBe("logger");
    expect(parsed.context_vars[0]?.name).toBe("userId");
    expect(parsed.openapi_routes[0]?.hono_path).toBe("/users/:id");
    expect(parsed.rpc_exports[0]?.shape).toBe("full_app");
    expect(parsed.mounts[0]?.mount_type).toBe("hono_route");
    expect(parsed.extraction_status).toBe("complete");
  });
});

describe("Phase 2 extensions — HonoRoute.inline_analysis", () => {
  it("accepts a HonoRoute with fully-populated inline_analysis that round-trips", () => {
    const responses: ResponseEmission[] = [
      { kind: "json", status: 200, shape_hint: "{ ok: true }", line: 12 },
      { kind: "json", status: 404, shape_hint: "{ error: 'not found' }", line: 15 },
    ];
    const errors: ErrorEmission[] = [
      { status: 500, exception_class: "HTTPException", message_hint: "boom", line: 18 },
    ];
    const dbCalls: ExternalCall[] = [
      { callee: "prisma.user.findMany", line: 10, kind: "db" },
    ];
    const fetchCalls: ExternalCall[] = [
      { callee: "fetch", line: 11, kind: "fetch" },
    ];
    const contextAccess: ContextAccess[] = [
      { type: "get", key: "userId", line: 13 },
      { type: "env", key: "DATABASE_URL", line: 14 },
    ];
    const analysis: InlineHandlerAnalysis = {
      responses,
      errors,
      db_calls: dbCalls,
      fetch_calls: fetchCalls,
      context_access: contextAccess,
      validators_inline: ["zValidator"],
      has_try_catch: true,
      truncated: false,
    };
    const route: HonoRoute = {
      method: "GET",
      path: "/users/:id",
      raw_path: "/users/:id",
      file: "/repo/src/index.ts",
      line: 10,
      owner_var: "app",
      handler: { name: "<inline>", inline: true, file: "/repo/src/index.ts", line: 10 },
      inline_middleware: [],
      validators: [],
      inline_analysis: analysis,
    };

    const json = JSON.stringify(route);
    const parsed = JSON.parse(json) as HonoRoute;
    expect(parsed.inline_analysis?.responses).toHaveLength(2);
    expect(parsed.inline_analysis?.responses[0]?.status).toBe(200);
    expect(parsed.inline_analysis?.errors[0]?.exception_class).toBe("HTTPException");
    expect(parsed.inline_analysis?.db_calls[0]?.kind).toBe("db");
    expect(parsed.inline_analysis?.fetch_calls[0]?.callee).toBe("fetch");
    expect(parsed.inline_analysis?.context_access).toHaveLength(2);
    expect(parsed.inline_analysis?.has_try_catch).toBe(true);
  });

  it("HonoRoute without inline_analysis is still valid (field is optional)", () => {
    const route: HonoRoute = {
      method: "POST",
      path: "/named",
      raw_path: "/named",
      file: "/repo/src/r.ts",
      line: 1,
      owner_var: "app",
      handler: { name: "createUser", inline: false, file: "/repo/src/h.ts", line: 5 },
      inline_middleware: [],
      validators: [],
    };
    expect(route.inline_analysis).toBeUndefined();
  });
});

describe("Phase 2 extensions — MiddlewareEntry.applied_when", () => {
  it("accepts MiddlewareEntry with applied_when populated and round-trips", () => {
    const applied: ConditionalApplication = {
      condition_type: "method",
      condition_text: "c.req.method !== 'GET'",
    };
    const entry: MiddlewareEntry = {
      name: "basicAuth",
      order: 1,
      line: 14,
      file: "/repo/src/mw.ts",
      inline: true,
      is_third_party: true,
      imported_from: "hono/basic-auth",
      conditional: true,
      applied_when: applied,
    };
    const parsed = JSON.parse(JSON.stringify(entry)) as MiddlewareEntry;
    expect(parsed.applied_when?.condition_type).toBe("method");
    expect(parsed.applied_when?.condition_text).toContain("!== 'GET'");
  });

  it("MiddlewareEntry without applied_when is still valid (field is optional)", () => {
    const entry: MiddlewareEntry = {
      name: "logger",
      order: 0,
      line: 3,
      file: "/repo/src/index.ts",
      inline: false,
      is_third_party: true,
      conditional: false,
    };
    expect(entry.applied_when).toBeUndefined();
  });
});

describe("Phase 2 extensions — HonoAppModel.modules", () => {
  it("accepts HonoAppModel with modules field and round-trips", () => {
    const adminModule: HonoModule = {
      name: "admin",
      routes: ["GET /admin/users", "POST /admin/users"],
      middleware: ["basicAuth", "adminOnly"],
      bindings: ["ADMIN_KEY"],
      path_prefix: "/admin",
      files: ["/repo/src/routes/admin.ts"],
    };
    const publicModule: HonoModule = {
      name: "public-api",
      routes: ["GET /api/posts"],
      middleware: ["cors"],
      bindings: [],
      path_prefix: "/api",
      files: ["/repo/src/routes/api.ts"],
    };
    const model: HonoAppModel = {
      entry_file: "/repo/src/index.ts",
      app_variables: {},
      routes: [],
      mounts: [],
      middleware_chains: [],
      context_vars: [],
      openapi_routes: [],
      rpc_exports: [],
      runtime: "cloudflare",
      env_bindings: ["ADMIN_KEY"],
      files_used: [],
      extraction_status: "complete",
      skip_reasons: {},
      modules: [adminModule, publicModule],
    };
    const parsed = JSON.parse(JSON.stringify(model)) as HonoAppModel;
    expect(parsed.modules).toHaveLength(2);
    expect(parsed.modules?.[0]?.name).toBe("admin");
    expect(parsed.modules?.[0]?.path_prefix).toBe("/admin");
    expect(parsed.modules?.[0]?.middleware).toContain("basicAuth");
    expect(parsed.modules?.[1]?.routes).toContain("GET /api/posts");
  });

  it("HonoAppModel without modules is still valid (field is optional)", () => {
    const model: HonoAppModel = {
      entry_file: "/repo/src/index.ts",
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
    expect(model.modules).toBeUndefined();
  });
});
