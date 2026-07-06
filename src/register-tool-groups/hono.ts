import { z, lazySchema, type ToolDefinitionEntry } from "./shared.js";

export const HONO_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Hono framework tools (Task 23) ---
  { order: 4360, definition: {
    name: "trace_middleware_chain",
    category: "graph",
    searchHint: "hono middleware chain trace order scope auth use conditional applied_when if method header path basicAuth gated",
    description: "Hono middleware introspection. Three query modes: (1) route mode — pass path (+optional method) to get the chain effective for that route; (2) scope mode — pass scope literal (e.g. '/posts/*') to get that specific app.use chain; (3) app-wide mode — omit path and scope to get every chain flattened. Any mode supports only_conditional=true to filter to entries with applied_when populated, so the blog-API pattern (basicAuth wrapped in `if (method !== 'GET')`) is surfaced as gated rather than missed. Absorbs the former trace_conditional_middleware tool.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Route path to look up (e.g. '/api/users/:id'). Omit for scope or app-wide query."),
      method: z.string().optional().describe("HTTP method filter (GET, POST, etc.). Only used in route mode."),
      scope: z.string().optional().describe("Exact middleware scope literal (e.g. '/posts/*'). Mutually exclusive with path."),
      only_conditional: z.boolean().optional().describe("Filter entries to those whose applied_when field is populated (conditional middleware)."),
    })),
    handler: async (args) => {
      const { traceMiddlewareChain } = await import("../tools/hono-middleware-chain.js");
      const opts: Record<string, unknown> = {};
      if (args.scope !== undefined) opts.scope = args.scope;
      if (args.only_conditional !== undefined) opts.only_conditional = args.only_conditional;
      return await traceMiddlewareChain(
        args.repo as string,
        args.path as string | undefined,
        args.method as string | undefined,
        Object.keys(opts).length > 0 ? opts : undefined,
      );
    },
  } },
  { order: 4385, definition: {
    name: "analyze_hono_app",
    category: "analysis",
    searchHint: "hono overview analyze app routes middleware runtime env bindings rpc workspace monorepo",
    description: "Complete Hono application overview: routes grouped by method/scope, middleware map, context vars, OpenAPI status, RPC exports (flags Issue #3869 slow pattern), runtime, env bindings. Pass workspace=<name|path> in monorepos to scope to a single workspace.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      entry_file: z.string().optional().describe("Hono entry file (auto-detected if omitted)"),
      workspace: z.string().optional().describe("Monorepo workspace name or path (e.g. '@org/api' or 'apps/api'). Scopes Hono entry resolution to that workspace."),
      force_refresh: z.boolean().optional().describe("Clear cache and rebuild"),
    })),
    handler: async (args) => {
      const { analyzeHonoApp } = await import("../tools/hono-analyze-app.js");
      const { resolveWorkspaceScope } = await import("../tools/workspace-scope-helper.js");
      const repo = args.repo as string;
      const scope = await resolveWorkspaceScope(repo, args.workspace as string | undefined, "hono");
      if ("error" in scope) {
        return { error: scope.error, input: scope.input, available: scope.available };
      }
      // If workspace scoping resolved to a path, prefer it as entry_file root hint.
      let entry = args.entry_file as string | undefined;
      if (!entry && scope.rootPaths.length === 1) {
        // Hono's entry resolver searches src/index.ts under the path provided
        entry = scope.rootPaths[0];
      }
      return await analyzeHonoApp(
        repo,
        entry,
        args.force_refresh as boolean | undefined,
      );
    },
  } },
  { order: 4417, definition: {
    name: "trace_context_flow",
    category: "analysis",
    searchHint: "hono context flow c.set c.get c.var c.env middleware variable unguarded",
    description: "Trace Hono context variable flow (c.set/c.get/c.var/c.env). Detects MISSING_CONTEXT_VARIABLE findings where routes access variables that no middleware in their scope sets.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      variable: z.string().optional().describe("Specific variable name to trace (default: all)"),
    })),
    handler: async (args) => {
      const { traceContextFlow } = await import("../tools/hono-context-flow.js");
      return await traceContextFlow(
        args.repo as string,
        args.variable as string | undefined,
      );
    },
  } },
  { order: 4434, definition: {
    name: "extract_api_contract",
    category: "analysis",
    searchHint: "hono openapi contract api schema createRoute zValidator",
    description: "Extract OpenAPI-style API contract from a Hono app. Uses explicit createRoute() definitions when available, infers from regular routes otherwise. Format: 'openapi' (paths object) or 'summary' (table).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      entry_file: z.string().optional().describe("Hono entry file (auto-detected if omitted)"),
      format: z.enum(["openapi", "summary"]).optional().describe("Output format (default: openapi)"),
    })),
    handler: async (args) => {
      const { extractApiContract } = await import("../tools/hono-api-contract.js");
      return await extractApiContract(
        args.repo as string,
        args.entry_file as string | undefined,
        args.format as "openapi" | "summary" | undefined,
      );
    },
  } },
  { order: 4453, definition: {
    name: "trace_rpc_types",
    category: "analysis",
    searchHint: "hono rpc client type export typeof slow pattern Issue 3869 compile time",
    description: "Analyze Hono RPC type exports. Detects the slow `export type X = typeof app` pattern from Issue #3869 (8-min CI compile time) and recommends splitting into per-route-group types.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { traceRpcTypes } = await import("../tools/hono-rpc-types.js");
      return await traceRpcTypes(args.repo as string);
    },
  } },
  { order: 4466, definition: {
    name: "audit_hono_security",
    category: "security",
    searchHint: "hono security audit rate limit secure headers auth order csrf env regression createMiddleware BlankEnv Issue 3587",
    description: "Security + type-safety audit of a Hono app. Rules: missing-secure-headers (global), missing-rate-limit + missing-auth (mutation routes, conditional-middleware aware via applied_when), auth-ordering (auth after non-auth in chain), env-regression (plain createMiddleware in 3+ chains — Hono Issue #3587, absorbed from the former detect_middleware_env_regression tool). Returns prioritized findings plus heuristic disclaimers via `notes` field for best-effort rules.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { auditHonoSecurity } = await import("../tools/hono-security.js");
      return await auditHonoSecurity(args.repo as string);
    },
  } },
  { order: 4479, definition: {
    name: "visualize_hono_routes",
    category: "reporting",
    searchHint: "hono routes visualize mermaid tree diagram documentation",
    description: "Produce a visualization of Hono routing topology. Supports 'mermaid' (diagram) and 'tree' (ASCII) formats.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      format: z.enum(["mermaid", "tree"]).optional().describe("Output format (default: tree)"),
    })),
    handler: async (args) => {
      const { visualizeHonoRoutes } = await import("../tools/hono-visualize.js");
      return await visualizeHonoRoutes(
        args.repo as string,
        args.format as "mermaid" | "tree" | undefined,
      );
    },
  } },
  // --- Hono Phase 2 tools (T13) ---
  { order: 4498, definition: {
    name: "analyze_inline_handler",
    category: "analysis",
    searchHint: "hono inline handler analyze c.json c.text status response error db fetch context",
    description: "Structured body analysis for each Hono inline handler: responses (c.json/text/html/redirect/newResponse with status + shape_hint), errors (throw new HTTPException/Error), db calls (prisma/db/knex/drizzle/mongoose/supabase), fetch calls, c.set/get/var/env access, inline validators, has_try_catch. Optional method + path filter. Named-handler routes return empty.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      method: z.string().optional().describe("HTTP method filter (case-insensitive)"),
      path: z.string().optional().describe("Route path filter (exact match, e.g. '/users/:id')"),
    })),
    handler: async (args) => {
      const { analyzeInlineHandler } = await import("../tools/hono-inline-analyze.js");
      return await analyzeInlineHandler(
        args.repo as string,
        args.method as string | undefined,
        args.path as string | undefined,
      );
    },
  } },
  { order: 4517, definition: {
    name: "extract_response_types",
    category: "analysis",
    searchHint: "hono response types status codes error paths RPC client InferResponseType Issue 4270",
    description: "Aggregate statically-knowable response types per route: c.json/text/html/body/redirect/newResponse emissions + throw new HTTPException/Error entries with status codes. Closes Hono Issue #4270 — RPC clients can generate types that include error paths. Returns routes[] plus total_statuses across the app.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { extractResponseTypes } = await import("../tools/hono-response-types.js");
      return await extractResponseTypes(args.repo as string);
    },
  } },
  { order: 4530, definition: {
    name: "detect_hono_modules",
    category: "analysis",
    searchHint: "hono modules architecture cluster path prefix middleware bindings enterprise Issue 4121",
    description: "Cluster Hono routes into logical modules by 2-segment path prefix, rolling up middleware chains, env bindings (from inline_analysis context_access), and source files per module. Closes Hono Issue #4121 — surfaces the implicit module structure for architecture review of enterprise apps. No new AST walking; post-processes the existing HonoAppModel.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { detectHonoModules } = await import("../tools/hono-modules.js");
      return await detectHonoModules(args.repo as string);
    },
  } },
  { order: 4543, definition: {
    name: "find_dead_hono_routes",
    category: "analysis",
    searchHint: "hono dead routes unused RPC client caller refactor monorepo cleanup",
    description: "Heuristically flag Hono server routes whose path segments do not appear in any non-server .ts/.tsx/.js/.jsx source file in the repo. Useful in monorepos to identify server endpoints that no Hono RPC client calls after refactors. Fully-dynamic routes (`/:id` only) are skipped. Documented as best-effort via the result note field.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { findDeadHonoRoutes } = await import("../tools/hono-dead-routes.js");
      return await findDeadHonoRoutes(args.repo as string);
    },
  } },
];
