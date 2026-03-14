import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { indexFolder, indexRepo, listAllRepos, invalidateCache } from "./tools/index-tools.js";
import { searchSymbols, searchText } from "./tools/search-tools.js";
import { getFileTree, getFileOutline, getRepoOutline } from "./tools/outline-tools.js";
import { getSymbol, getSymbols, findAndShow, findReferences } from "./tools/symbol-tools.js";
import { traceCallChain, impactAnalysis } from "./tools/graph-tools.js";
import { assembleContext, getKnowledgeMap } from "./tools/context-tools.js";
import { diffOutline, changedSymbols } from "./tools/diff-tools.js";
import { generateClaudeMd } from "./tools/generate-tools.js";
import { codebaseRetrieval } from "./retrieval/codebase-retrieval.js";
import { trackToolCall } from "./storage/usage-tracker.js";
import { getUsageStats, formatUsageReport } from "./storage/usage-stats.js";
import type { SymbolKind, Direction } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}

function wrapTool<T>(toolName: string, args: Record<string, unknown>, fn: () => Promise<T>) {
  return async () => {
    const start = performance.now();
    try {
      const data = await fn();
      const text = JSON.stringify(data, null, 2);
      const elapsed = performance.now() - start;
      trackToolCall(toolName, args, text, data, elapsed);
      return { content: [{ type: "text" as const, text }] };
    } catch (err: unknown) {
      const elapsed = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      trackToolCall(toolName, args, message, { error: message }, elapsed);
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
  },
  async (args) => wrapTool("index_folder", args, () =>
    indexFolder(args.path, {
      incremental: args.incremental,
      include_paths: args.include_paths,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 2. index_repo
// ---------------------------------------------------------------------------
server.tool(
  "index_repo",
  "Clone and index a remote git repository",
  {
    url: z.string().describe("Git clone URL"),
    branch: z.string().optional().describe("Branch to checkout"),
    include_paths: z.array(z.string()).optional().describe("Glob patterns to include"),
  },
  async (args) => wrapTool("index_repo", args, () =>
    indexRepo(args.url, {
      branch: args.branch,
      include_paths: args.include_paths,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 3. list_repos
// ---------------------------------------------------------------------------
server.tool(
  "list_repos",
  "List all indexed repositories with metadata",
  {},
  async () => wrapTool("list_repos", {}, () => listAllRepos())(),
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
  async (args) => wrapTool("invalidate_cache", args, () => invalidateCache(args.repo))(),
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
    top_k: z.number().optional().describe("Maximum number of results to return (default 50)"),
    source_chars: z.number().optional().describe("Truncate each symbol's source to N characters (reduces output size)"),
  },
  async (args) => wrapTool("search_symbols", args, () =>
    searchSymbols(args.repo, args.query, {
      kind: args.kind as SymbolKind | undefined,
      file_pattern: args.file_pattern,
      include_source: args.include_source,
      top_k: args.top_k,
      source_chars: args.source_chars,
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
    max_results: z.number().optional().describe("Maximum number of matching lines to return (default 500)"),
  },
  async (args) => wrapTool("search_text", args, () =>
    searchText(args.repo, args.query, {
      regex: args.regex,
      context_lines: args.context_lines,
      file_pattern: args.file_pattern,
      max_results: args.max_results,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 7. get_file_tree
// ---------------------------------------------------------------------------
server.tool(
  "get_file_tree",
  "Get the file tree of a repository with symbol counts per file. Use compact=true for a flat list of paths (10-50x less output).",
  {
    repo: z.string().describe("Repository identifier"),
    path_prefix: z.string().optional().describe("Filter to a subtree by path prefix"),
    name_pattern: z.string().optional().describe("Glob pattern to filter file names"),
    depth: z.number().optional().describe("Maximum directory depth to traverse"),
    compact: z.boolean().optional().describe("Return flat list of {path, symbols} instead of nested tree (much less output)"),
    min_symbols: z.number().optional().describe("Only include files with at least this many symbols"),
  },
  async (args) => wrapTool("get_file_tree", args, () =>
    getFileTree(args.repo, {
      path_prefix: args.path_prefix,
      name_pattern: args.name_pattern,
      depth: args.depth,
      compact: args.compact,
      min_symbols: args.min_symbols,
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
  async (args) => wrapTool("get_file_outline", args, () => getFileOutline(args.repo, args.file_path))(),
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
  async (args) => wrapTool("get_repo_outline", args, () => getRepoOutline(args.repo))(),
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
  async (args) => wrapTool("get_symbol", args, () => getSymbol(args.repo, args.symbol_id))(),
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
  async (args) => wrapTool("get_symbols", args, () => getSymbols(args.repo, args.symbol_ids))(),
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
  async (args) => wrapTool("find_and_show", args, () =>
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
  async (args) => wrapTool("find_references", args, () =>
    findReferences(args.repo, args.symbol_name, args.file_pattern),
  )(),
);

// ---------------------------------------------------------------------------
// 14. trace_call_chain
// ---------------------------------------------------------------------------
server.tool(
  "trace_call_chain",
  "Trace the call chain of a symbol — who calls it (callers) or what it calls (callees). Source code is excluded by default for compact output; set include_source=true to include it.",
  {
    repo: z.string().describe("Repository identifier"),
    symbol_name: z.string().describe("Name of the symbol to trace"),
    direction: z.enum(["callers", "callees"]).describe("Trace direction"),
    depth: z.number().optional().describe("Maximum depth to traverse the call graph (default: 1)"),
    include_source: z.boolean().optional().describe("Include full source code of each symbol (default: false)"),
    include_tests: z.boolean().optional().describe("Include test files in trace results (default: false)"),
  },
  async (args) => wrapTool("trace_call_chain", args, () =>
    traceCallChain(args.repo, args.symbol_name, args.direction as Direction, {
      depth: args.depth,
      include_source: args.include_source,
      include_tests: args.include_tests,
    }),
  )(),
);

// ---------------------------------------------------------------------------
// 15. impact_analysis
// ---------------------------------------------------------------------------
server.tool(
  "impact_analysis",
  "Analyze the blast radius of recent git changes — which symbols and files are affected. Source code is excluded by default for compact output.",
  {
    repo: z.string().describe("Repository identifier"),
    since: z.string().describe("Git ref to compare from (e.g. HEAD~3, commit SHA, branch)"),
    depth: z.number().optional().describe("Depth of dependency traversal"),
    until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
    include_source: z.boolean().optional().describe("Include full source code of affected symbols (default: false)"),
  },
  async (args) => wrapTool("impact_analysis", args, () =>
    impactAnalysis(args.repo, args.since, {
      depth: args.depth,
      until: args.until,
      include_source: args.include_source,
    }),
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
  async (args) => wrapTool("assemble_context", args, () =>
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
  async (args) => wrapTool("get_knowledge_map", args, () =>
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
  async (args) => wrapTool("diff_outline", args, () =>
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
  async (args) => wrapTool("changed_symbols", args, () =>
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
  async (args) => wrapTool("generate_claude_md", args, () =>
    generateClaudeMd(args.repo, args.output_path),
  )(),
);

// ---------------------------------------------------------------------------
// 21. codebase_retrieval
// ---------------------------------------------------------------------------
server.tool(
  "codebase_retrieval",
  "Batch multiple search and retrieval queries into a single call with shared token budget. Semantic and hybrid sub-queries exclude test files by default (set exclude_tests:false to include them).",
  {
    repo: z.string().describe("Repository identifier"),
    queries: z
      .array(z.object({ type: z.string() }).passthrough())
      .describe("Array of sub-queries (symbols, text, file_tree, outline, references, call_chain, impact, context, knowledge_map)"),
    token_budget: z.number().optional().describe("Maximum total tokens across all sub-query results"),
  },
  async (args) => wrapTool("codebase_retrieval", args, () =>
    codebaseRetrieval(args.repo, args.queries, args.token_budget),
  )(),
);

// ---------------------------------------------------------------------------
// 22. usage_stats
// ---------------------------------------------------------------------------
server.tool(
  "usage_stats",
  "Show usage statistics for all CodeSift tool calls (call counts, tokens, timing, repos)",
  {},
  async () => {
    try {
      const stats = await getUsageStats();
      const report = formatUsageReport(stats);
      return {
        content: [{ type: "text" as const, text: report }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  },
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
