import { z, zBool, lazySchema, type ToolDefinitionEntry } from "../shared.js";

export const WORKSPACE_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  { order: 2452, definition: {
    name: "list_workspaces",
    category: "analysis",
    searchHint: "monorepo workspace list packages turbo pnpm yarn npm",
    description: "List workspace packages for a JS/TS monorepo (Turbo / pnpm / yarn / npm / Nx). Returns shape-stable empty result on flat repos.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { listWorkspacesHandler } = await import("../../tools/workspace-tools.js");
      return listWorkspacesHandler(args.repo ? { repo: args.repo as string } : {});
    },
  } },
  { order: 2465, definition: {
    name: "workspace_graph",
    category: "analysis",
    searchHint: "monorepo workspace dependency graph turbo nx mermaid dot",
    description: "Build the workspace-to-workspace dependency DAG of a monorepo. Output formats: json (default), mermaid, dot.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      format: z.enum(["json", "mermaid", "dot"]).optional().describe("Output format (default: json)"),
    })),
    handler: async (args) => {
      const { workspaceGraphHandler } = await import("../../tools/workspace-tools.js");
      const opts: Parameters<typeof workspaceGraphHandler>[0] = {};
      if (args.repo) opts.repo = args.repo as string;
      if (args.format) opts.format = args.format as "json" | "mermaid" | "dot";
      return workspaceGraphHandler(opts);
    },
  } },
  { order: 2482, definition: {
    name: "affected_workspaces",
    category: "analysis",
    searchHint: "monorepo affected workspaces git diff impact transitive turbo nx",
    description: "Compute affected workspaces for a git diff. File changes -> containing workspace -> reverse-dep walk. Lockfile-only commits surface separately and never fan out.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to diff against (e.g. HEAD~1, main, <sha>)"),
      include_transitive: zBool().describe("Include transitive reverse-deps (default: true)"),
    })),
    handler: async (args) => {
      const { affectedWorkspacesHandler } = await import("../../tools/workspace-tools.js");
      const opts: Parameters<typeof affectedWorkspacesHandler>[0] = {
        since: args.since as string,
      };
      if (args.repo) opts.repo = args.repo as string;
      if (args.include_transitive !== undefined) opts.include_transitive = args.include_transitive as boolean;
      return affectedWorkspacesHandler(opts);
    },
  } },
  { order: 2502, definition: {
    name: "workspace_boundaries",
    category: "analysis",
    searchHint: "monorepo boundary rules workspace import violations enforce",
    description: "Enforce workspace-level import boundaries. Walks ALL cross-workspace import edges (relative + bare/tsconfig-alias) and reports rule violations.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      rules: z
        .array(
          z.object({
            from_workspace: z.string().describe("Workspace name OR glob (e.g. 'apps/*')"),
            cannot_import_workspaces: z.array(z.string()).describe("Names, globs, or negation entries"),
          }),
        )
        .describe("Workspace boundary rules"),
    })),
    handler: async (args) => {
      const { workspaceBoundariesHandler } = await import("../../tools/workspace-tools.js");
      const opts: Parameters<typeof workspaceBoundariesHandler>[0] = {
        rules: args.rules as Array<{ from_workspace: string; cannot_import_workspaces: string[] }>,
      };
      if (args.repo) opts.repo = args.repo as string;
      return workspaceBoundariesHandler(opts);
    },
  } },
];
