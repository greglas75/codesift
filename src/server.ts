import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { indexFolder, listAllRepos, invalidateCache } from "./tools/index-tools.js";
import { searchSymbols, searchText } from "./tools/search-tools.js";
import { getFileTree, getFileOutline, getRepoOutline } from "./tools/outline-tools.js";
import { getSymbol, getSymbols, findAndShow, findReferences } from "./tools/symbol-tools.js";
import { traceCallChain, impactAnalysis } from "./tools/graph-tools.js";
import { assembleContext, getKnowledgeMap } from "./tools/context-tools.js";
import { diffOutline, changedSymbols } from "./tools/diff-tools.js";
import { generateClaudeMd } from "./tools/generate-tools.js";
import { codebaseRetrieval } from "./retrieval/codebase-retrieval.js";
import type { SymbolKind, Direction } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notImplemented() {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: "not implemented" }) },
    ],
  };
}

function jsonResult(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}

function wrapTool<T>(fn: () => Promise<T>) {
  return async () => {
    try {
      return jsonResult(await fn());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

loadConfig();

const server = new McpServer({
  name: "codesift-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// 1. index_folder
// ---------------------------------------------------------------------------
server.tool(
  "index_folder",
  "Index a local folder, extracting symbols and building the search index",
  {
    path: z.string().describe("Absolute path to the folder to index"),
    incremental: z.boolean().optional().describe("Only re-index changed files"),
    include_paths: z.array(z.string()).optional().describe("Glob patterns to include"),
    use_ai_summaries: z.boolean().optional().describe("Generate AI summaries for symbols"),
  },
  async (args) => wrapTool(() =>
    indexFolder(args.path, {
      incremental: args.incremental,
      include_paths: args.include_paths,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 2. index_repo (stub — Phase 4)
// ---------------------------------------------------------------------------
server.tool(
  "index_repo",
  "Clone and index a remote git repository",
  {
    url: z.string().describe("Git clone URL"),
    branch: z.string().optional().describe("Branch to checkout"),
    include_paths: z.array(z.string()).optional().describe("Glob patterns to include"),
    use_ai_summaries: z.boolean().optional().describe("Generate AI summaries for symbols"),
  },
  async () => notImplemented(),
);

// ---------------------------------------------------------------------------
// 3. list_repos
// ---------------------------------------------------------------------------
server.tool(
  "list_repos",
  "List all indexed repositories with metadata",
  {},
  async () => wrapTool(() => listAllRepos())(),
);

// ---------------------------------------------------------------------------
// 4. invalidate_cache
// ---------------------------------------------------------------------------
server.tool(
  "invalidate_cache",
  "Clear the index cache for a repository, forcing full re-index on next use",
  {
    repo: z.string().describe("Repository identifier (e.g. local/my-project)"),
  },
  async (args) => wrapTool(() => invalidateCache(args.repo))(),
);

// ---------------------------------------------------------------------------
// 5. search_symbols
// ---------------------------------------------------------------------------
server.tool(
  "search_symbols",
  "Search for code symbols (functions, classes, types) by name or signature",
  {
    repo: z.string().describe("Repository identifier"),
    query: z.string().describe("Search query string"),
    kind: z.string().optional().describe("Filter by symbol kind (function, class, etc.)"),
    file_pattern: z.string().optional().describe("Glob pattern to filter files"),
    include_source: z.boolean().optional().describe("Include full source code of each symbol"),
    top_k: z.number().optional().describe("Maximum number of results to return"),
  },
  async (args) => wrapTool(() =>
    searchSymbols(args.repo, args.query, {
      kind: args.kind as SymbolKind | undefined,
      file_pattern: args.file_pattern,
      include_source: args.include_source,
      top_k: args.top_k,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 6. search_text
// ---------------------------------------------------------------------------
server.tool(
  "search_text",
  "Full-text search across all files in a repository",
  {
    repo: z.string().describe("Repository identifier"),
    query: z.string().describe("Search query or regex pattern"),
    regex: z.boolean().optional().describe("Treat query as a regex pattern"),
    context_lines: z.number().optional().describe("Number of context lines around each match"),
    file_pattern: z.string().optional().describe("Glob pattern to filter files"),
  },
  async (args) => wrapTool(() =>
    searchText(args.repo, args.query, {
      regex: args.regex,
      context_lines: args.context_lines,
      file_pattern: args.file_pattern,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 7. get_file_tree
// ---------------------------------------------------------------------------
server.tool(
  "get_file_tree",
  "Get the file tree of a repository with symbol counts per file",
  {
    repo: z.string().describe("Repository identifier"),
    path_prefix: z.string().optional().describe("Filter to a subtree by path prefix"),
    name_pattern: z.string().optional().describe("Glob pattern to filter file names"),
    depth: z.number().optional().describe("Maximum directory depth to traverse"),
  },
  async (args) => wrapTool(() =>
    getFileTree(args.repo, {
      path_prefix: args.path_prefix,
      name_pattern: args.name_pattern,
      depth: args.depth,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 8. get_file_outline
// ---------------------------------------------------------------------------
server.tool(
  "get_file_outline",
  "Get the symbol outline of a single file (functions, classes, exports)",
  {
    repo: z.string().describe("Repository identifier"),
    file_path: z.string().describe("Relative file path within the repository"),
  },
  async (args) => wrapTool(() => getFileOutline(args.repo, args.file_path))(),
);

// ---------------------------------------------------------------------------
// 9. get_repo_outline
// ---------------------------------------------------------------------------
server.tool(
  "get_repo_outline",
  "Get a high-level outline of the entire repository grouped by directory",
  {
    repo: z.string().describe("Repository identifier"),
  },
  async (args) => wrapTool(() => getRepoOutline(args.repo))(),
);

// ---------------------------------------------------------------------------
// 10. get_symbol
// ---------------------------------------------------------------------------
server.tool(
  "get_symbol",
  "Retrieve a single symbol by its unique ID with full source code",
  {
    repo: z.string().describe("Repository identifier"),
    symbol_id: z.string().describe("Unique symbol identifier"),
  },
  async (args) => wrapTool(() => getSymbol(args.repo, args.symbol_id))(),
);

// ---------------------------------------------------------------------------
// 11. get_symbols
// ---------------------------------------------------------------------------
server.tool(
  "get_symbols",
  "Retrieve multiple symbols by ID in a single batch call",
  {
    repo: z.string().describe("Repository identifier"),
    symbol_ids: z.array(z.string()).describe("Array of symbol identifiers"),
  },
  async (args) => wrapTool(() => getSymbols(args.repo, args.symbol_ids))(),
);

// ---------------------------------------------------------------------------
// 12. find_and_show
// ---------------------------------------------------------------------------
server.tool(
  "find_and_show",
  "Find a symbol by name and show its source, optionally including references",
  {
    repo: z.string().describe("Repository identifier"),
    query: z.string().describe("Symbol name or query to search for"),
    include_refs: z.boolean().optional().describe("Include locations that reference this symbol"),
  },
  async (args) => wrapTool(() =>
    findAndShow(args.repo, args.query, args.include_refs),
  )(),
);

// ---------------------------------------------------------------------------
// 13. find_references
// ---------------------------------------------------------------------------
server.tool(
  "find_references",
  "Find all references to a symbol across the codebase",
  {
    repo: z.string().describe("Repository identifier"),
    symbol_name: z.string().describe("Name of the symbol to find references for"),
    file_pattern: z.string().optional().describe("Glob pattern to filter files"),
  },
  async (args) => wrapTool(() =>
    findReferences(args.repo, args.symbol_name, args.file_pattern),
  )(),
);

// ---------------------------------------------------------------------------
// 14. trace_call_chain
// ---------------------------------------------------------------------------
server.tool(
  "trace_call_chain",
  "Trace the call chain of a symbol — who calls it (callers) or what it calls (callees)",
  {
    repo: z.string().describe("Repository identifier"),
    symbol_name: z.string().describe("Name of the symbol to trace"),
    direction: z.enum(["callers", "callees"]).describe("Trace direction"),
    depth: z.number().optional().describe("Maximum depth to traverse the call graph"),
  },
  async (args) => wrapTool(() =>
    traceCallChain(args.repo, args.symbol_name, args.direction as Direction, args.depth),
  )(),
);

// ---------------------------------------------------------------------------
// 15. impact_analysis
// ---------------------------------------------------------------------------
server.tool(
  "impact_analysis",
  "Analyze the blast radius of recent git changes — which symbols and files are affected",
  {
    repo: z.string().describe("Repository identifier"),
    since: z.string().describe("Git ref to compare from (e.g. HEAD~3, commit SHA, branch)"),
    depth: z.number().optional().describe("Depth of dependency traversal"),
    until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
  },
  async (args) => wrapTool(() =>
    impactAnalysis(args.repo, args.since, args.depth, args.until),
  )(),
);

// ---------------------------------------------------------------------------
// 16. assemble_context
// ---------------------------------------------------------------------------
server.tool(
  "assemble_context",
  "Assemble a focused code context for a query within a token budget",
  {
    repo: z.string().describe("Repository identifier"),
    query: z.string().describe("Natural language query describing what context is needed"),
    token_budget: z.number().optional().describe("Maximum tokens for the assembled context"),
  },
  async (args) => wrapTool(() =>
    assembleContext(args.repo, args.query, args.token_budget),
  )(),
);

// ---------------------------------------------------------------------------
// 17. get_knowledge_map
// ---------------------------------------------------------------------------
server.tool(
  "get_knowledge_map",
  "Get the module dependency map showing how files and directories relate",
  {
    repo: z.string().describe("Repository identifier"),
    focus: z.string().optional().describe("Focus on a specific module or directory"),
    depth: z.number().optional().describe("Maximum depth of the dependency graph"),
  },
  async (args) => wrapTool(() =>
    getKnowledgeMap(args.repo, args.focus, args.depth),
  )(),
);

// ---------------------------------------------------------------------------
// 18. diff_outline
// ---------------------------------------------------------------------------
server.tool(
  "diff_outline",
  "Get a structural outline of what changed between two git refs",
  {
    repo: z.string().describe("Repository identifier"),
    since: z.string().describe("Git ref to compare from"),
    until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
  },
  async (args) => wrapTool(() =>
    diffOutline(args.repo, args.since, args.until),
  )(),
);

// ---------------------------------------------------------------------------
// 19. changed_symbols
// ---------------------------------------------------------------------------
server.tool(
  "changed_symbols",
  "List symbols that were added, modified, or removed between two git refs",
  {
    repo: z.string().describe("Repository identifier"),
    since: z.string().describe("Git ref to compare from"),
    until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
  },
  async (args) => wrapTool(() =>
    changedSymbols(args.repo, args.since, args.until),
  )(),
);

// ---------------------------------------------------------------------------
// 20. generate_claude_md
// ---------------------------------------------------------------------------
server.tool(
  "generate_claude_md",
  "Generate a CLAUDE.md project summary file from the repository index",
  {
    repo: z.string().describe("Repository identifier"),
    output_path: z.string().optional().describe("Custom output file path"),
  },
  async (args) => wrapTool(() =>
    generateClaudeMd(args.repo, args.output_path),
  )(),
);

// ---------------------------------------------------------------------------
// 21. codebase_retrieval
// ---------------------------------------------------------------------------
server.tool(
  "codebase_retrieval",
  "Batch multiple search and retrieval queries into a single call with shared token budget",
  {
    repo: z.string().describe("Repository identifier"),
    queries: z
      .array(z.object({ type: z.string() }).passthrough())
      .describe("Array of sub-queries (symbols, text, file_tree, outline, references, call_chain, impact, context, knowledge_map)"),
    token_budget: z.number().optional().describe("Maximum total tokens across all sub-query results"),
  },
  async (args) => wrapTool(() =>
    codebaseRetrieval(args.repo, args.queries, args.token_budget),
  )(),
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CodeSift MCP server started");
}

main().catch((err: unknown) => {
  console.error("Fatal error starting CodeSift MCP server:", err);
  process.exit(1);
});
