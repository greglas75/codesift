import { z, zBool, zNum, lazySchema, type ToolCategory, type ToolDefinitionEntry } from "../shared.js";
import { crossRepoFindReferences, crossRepoSearchSymbols, type SymbolKind } from "../deps.js";

export const CROSS_REPO_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  { order: 2267, definition: {
    name: "cross_repo_search",
    category: "cross-repo",
    searchHint: "cross-repo search symbols across all repositories monorepo microservice",
    description: "Search symbols across ALL indexed repositories. Useful for monorepos and microservice architectures.",
    schema: lazySchema(() => ({
      query: z.string().describe("Symbol search query"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern (e.g. 'local/tgm')"),
      kind: z.string().optional().describe("Filter by symbol kind"),
      top_k: zNum().describe("Max results per repo (default: 10)"),
      include_source: zBool().describe("Include source code"),
    })),
    handler: (args) => crossRepoSearchSymbols(args.query as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      kind: args.kind as SymbolKind | undefined,
      top_k: args.top_k as number | undefined,
      include_source: args.include_source as boolean | undefined,
    }),
  } },
  { order: 2286, definition: {
    name: "cross_repo_refs",
    category: "cross-repo",
    searchHint: "cross-repo references symbol across all repositories",
    description: "Find references to a symbol across ALL indexed repositories.",
    schema: lazySchema(() => ({
      symbol_name: z.string().describe("Symbol name to find references for"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern"),
      file_pattern: z.string().optional().describe("Filter files by glob pattern"),
    })),
    handler: (args) => crossRepoFindReferences(args.symbol_name as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      file_pattern: args.file_pattern as string | undefined,
    }),
  } },
];

export const CROSS_REPO_CONTRACT_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  { order: 4859, definition: {
    name: "repo_group",
    category: "architecture" as ToolCategory,
    searchHint: "repo group multi-repo cross-repo service group create list remove register contract",
    description: "Manage named groups of indexed repos for cross-service contract analysis. action='create' (name + repos[] required, optional description), 'list', or 'remove' (name required). Groups are stored in groups.json under the data dir.",
    schema: lazySchema(() => ({
      action: z.enum(["create", "list", "remove"]).describe("create | list | remove"),
      name: z.string().optional().describe("Group name (required for create/remove)"),
      repos: z.array(z.string()).optional().describe("Repo identifiers in the group (required for create)"),
      description: z.string().optional().describe("Optional human description (create only)"),
    })),
    handler: async (args) => {
      const { loadConfig } = await import("../../config.js");
      const reg = await import("../../storage/group-registry.js");
      const registryPath = reg.getGroupRegistryPath(loadConfig().dataDir);
      const action = args.action as string;
      if (action === "list") {
        return { groups: await reg.listGroups(registryPath) };
      }
      if (action === "create") {
        const name = args.name as string | undefined;
        const repos = args.repos as string[] | undefined;
        if (!name || !repos) return { error: "create requires name and repos[]" };
        const input: { name: string; repos: string[]; description?: string } = { name, repos };
        if (typeof args.description === "string") input.description = args.description;
        await reg.registerGroup(registryPath, input);
        const created = await reg.getGroup(registryPath, name);
        if (!created) return { error: "group persisted but read-back failed" };
        return { group: created };
      }
      const name = args.name as string | undefined;
      if (!name) return { error: "remove requires name" };
      return { removed: await reg.removeGroup(registryPath, name) };
    },
  } },
  { order: 4899, definition: {
    name: "match_group_contracts",
    category: "architecture" as ToolCategory,
    searchHint: "cross-repo contract match who calls endpoint producer consumer fetch axios downstream break group",
    description: "Match producer HTTP endpoints to cross-repo consumer calls (fetch/axios/got) across every indexed repo in a group. Returns ContractMatch[] (exact + partial), plus warnings for unindexed/failed repos. Answers 'who calls this endpoint' across services.",
    schema: lazySchema(() => ({
      group: z.string().describe("Repo group name (created via repo_group)"),
    })),
    handler: async (args) => {
      const { matchGroupContracts } = await import("../../tools/cross-repo-contract-tools.js");
      return matchGroupContracts(args.group as string);
    },
  } },
  { order: 4912, definition: {
    name: "find_endpoint_consumers",
    category: "architecture" as ToolCategory,
    searchHint: "who calls endpoint consumers downstream impact contract change break group cross-repo",
    description: "Find every cross-repo consumer of a specific producer endpoint within a group — 'who calls GET /users/{id}'. Method is case-insensitive; path params in any style (:id, {id}, [id]) are normalised. Answers 'what breaks downstream if I change this contract'.",
    schema: lazySchema(() => ({
      group: z.string().describe("Repo group name"),
      method: z.string().describe("HTTP method (GET/POST/...) — case-insensitive"),
      path: z.string().describe("Producer path, any param style (e.g. /users/{id} or /users/:id)"),
    })),
    handler: async (args) => {
      const { findEndpointConsumers } = await import("../../tools/cross-repo-contract-tools.js");
      return findEndpointConsumers(args.group as string, args.method as string, args.path as string);
    },
  } },
];
