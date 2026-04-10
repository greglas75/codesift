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
