import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wrapTool } from "./server-helpers.js";
import { indexFolder, indexFile, indexRepo, listAllRepos, invalidateCache } from "./tools/index-tools.js";
import { searchSymbols, searchText } from "./tools/search-tools.js";
import { getFileTree, getFileOutline, getRepoOutline, suggestQueries } from "./tools/outline-tools.js";
import { getSymbol, getSymbols, findAndShow, findReferences, findReferencesBatch, findDeadCode, getContextBundle } from "./tools/symbol-tools.js";
import { traceCallChain } from "./tools/graph-tools.js";
import { impactAnalysis } from "./tools/impact-tools.js";
import { traceRoute } from "./tools/route-tools.js";
import { detectCommunities } from "./tools/community-tools.js";
import { assembleContext, getKnowledgeMap } from "./tools/context-tools.js";
import { diffOutline, changedSymbols } from "./tools/diff-tools.js";
import { generateClaudeMd } from "./tools/generate-tools.js";
import { codebaseRetrieval } from "./retrieval/codebase-retrieval.js";
import { analyzeComplexity } from "./tools/complexity-tools.js";
import { findClones } from "./tools/clone-tools.js";
import { analyzeHotspots } from "./tools/hotspot-tools.js";
import { crossRepoSearchSymbols, crossRepoFindReferences } from "./tools/cross-repo-tools.js";
import { searchPatterns, listPatterns } from "./tools/pattern-tools.js";
import { generateReport } from "./tools/report-tools.js";
import { getUsageStats, formatUsageReport } from "./storage/usage-stats.js";
import { goToDefinition, getTypeInfo, renameSymbol } from "./lsp/lsp-tools.js";
import { indexConversations, searchConversations, searchAllConversations, findConversationsForSymbol } from "./tools/conversation-tools.js";
import { scanSecrets } from "./tools/secret-tools.js";
import { frequencyAnalysis } from "./tools/frequency-tools.js";
import type { SecretSeverity } from "./tools/secret-tools.js";
import type { SymbolKind, Direction } from "./types.js";

const zFiniteNumber = z.number().finite();

/** Coerce string→number for numeric params while rejecting NaN/empty strings. */
export const zNum = () =>
  z.union([
    zFiniteNumber,
    z.string()
      .trim()
      .min(1, "Expected a number")
      .transform((value) => Number(value))
      .pipe(zFiniteNumber),
  ]).optional();

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool definitions — data-driven registration (CQ14: eliminates 30× boilerplate)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- Indexing ---
  {
    name: "index_folder",
    description: "Index a local folder, extracting symbols and building the search index",
    schema: {
      path: z.string().describe("Absolute path to the folder to index"),
      incremental: z.boolean().optional().describe("Only re-index changed files"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    },
    handler: (args) => indexFolder(args.path as string, {
      incremental: args.incremental as boolean | undefined,
      include_paths: args.include_paths as string[] | undefined,
    }),
  },
  {
    name: "index_repo",
    description: "Clone and index a remote git repository",
    schema: {
      url: z.string().describe("Git clone URL"),
      branch: z.string().optional().describe("Branch to checkout"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    },
    handler: (args) => indexRepo(args.url as string, {
      branch: args.branch as string | undefined,
      include_paths: args.include_paths as string[] | undefined,
    }),
  },
  {
    name: "list_repos",
    description: "List all indexed repository names. Returns just names by default. Set compact=false for full metadata (paths, counts). Call ONCE per session — result is permanently cached (repo list doesn't change).",
    schema: {
      compact: z.boolean().optional().describe("Return just repo names (default: true). Set false for full metadata including root path, index_path, file/symbol counts."),
    },
    handler: (args) => listAllRepos({ compact: (args.compact as boolean | undefined) ?? true }),
  },
  {
    name: "invalidate_cache",
    description: "Clear the index cache for a repository, forcing full re-index on next use",
    schema: {
      repo: z.string().describe("Repository identifier (e.g. local/my-project)"),
    },
    handler: (args) => invalidateCache(args.repo as string),
  },

  {
    name: "index_file",
    description: "Re-index a single file instantly after editing. Finds the repo automatically, updates symbols and BM25 index. Skips if file mtime unchanged. Much faster than index_folder for single-file updates.",
    schema: {
      path: z.string().describe("Absolute path to the file to re-index"),
    },
    handler: (args) => indexFile(args.path as string),
  },

  // --- Search ---
  {
    name: "search_symbols",
    description: "Search for code symbols (functions, classes, types) by name or signature. Use detail_level='compact' for discovery (~15 tok/result), 'standard' for signatures+source (default), 'full' for complete source.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      query: z.string().describe("Search query string"),
      kind: z.string().optional().describe("Filter by symbol kind (function, class, etc.)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      include_source: z.boolean().optional().describe("Include full source code of each symbol"),
      top_k: zNum().describe("Maximum number of results to return (default 50)"),
      source_chars: zNum().describe("Truncate each symbol's source to N characters (reduces output size)"),
      detail_level: z.enum(["compact", "standard", "full"]).optional().describe("Output detail: compact (~15 tok/result, id+name+kind+file+line), standard (default, +signature+source), full (unlimited source)"),
      token_budget: zNum().describe("Max tokens for results — greedily packs results until budget exhausted. Overrides top_k."),
      rerank: z.boolean().optional().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    },
    handler: (args) => searchSymbols(args.repo as string, args.query as string, {
      kind: args.kind as SymbolKind | undefined,
      file_pattern: args.file_pattern as string | undefined,
      include_source: args.include_source as boolean | undefined,
      top_k: args.top_k as number | undefined,
      source_chars: args.source_chars as number | undefined,
      detail_level: args.detail_level as "compact" | "standard" | "full" | undefined,
      token_budget: args.token_budget as number | undefined,
      rerank: args.rerank as boolean | undefined,
    }),
  },
  {
    name: "search_text",
    description: "Full-text search across all files in a repository. For conceptual questions (how/where/why), use codebase_retrieval with type:'semantic' instead — it finds code by meaning, not keywords.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      query: z.string().describe("Search query or regex pattern"),
      regex: z.boolean().optional().describe("Treat query as a regex pattern"),
      context_lines: zNum().describe("Number of context lines around each match"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      max_results: zNum().describe("Maximum number of matching lines to return (default 200)"),
      group_by_file: z.boolean().optional().describe("Group results by file — returns {file, count, lines[], first_match} instead of every line. 80-90% less output for high-cardinality searches."),
      auto_group: z.boolean().optional().describe("Automatically switch to group_by_file when result count exceeds 50 matches. Recommended for exploratory searches where match count is unknown."),
    },
    handler: (args) => searchText(args.repo as string, args.query as string, {
      regex: args.regex as boolean | undefined,
      context_lines: args.context_lines as number | undefined,
      file_pattern: args.file_pattern as string | undefined,
      max_results: args.max_results as number | undefined,
      group_by_file: args.group_by_file as boolean | undefined,
      auto_group: args.auto_group as boolean | undefined,
    }),
  },

  // --- Outline ---
  {
    name: "get_file_tree",
    description: "Get the file tree of a repository with symbol counts per file. Use compact=true for a flat list of paths (10-50x less output). Result is cached for 5 minutes — avoid calling the same path_prefix twice.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      path_prefix: z.string().optional().describe("Filter to a subtree by path prefix"),
      name_pattern: z.string().optional().describe("Glob pattern to filter file names"),
      depth: zNum().describe("Maximum directory depth to traverse"),
      compact: z.boolean().optional().describe("Return flat list of {path, symbols} instead of nested tree (much less output)"),
      min_symbols: zNum().describe("Only include files with at least this many symbols"),
    },
    handler: (args) => getFileTree(args.repo as string, {
      path_prefix: args.path_prefix as string | undefined,
      name_pattern: args.name_pattern as string | undefined,
      depth: args.depth as number | undefined,
      compact: args.compact as boolean | undefined,
      min_symbols: args.min_symbols as number | undefined,
    }),
  },
  {
    name: "get_file_outline",
    description: "Get the symbol outline of a single file (functions, classes, exports)",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_path: z.string().describe("Relative file path within the repository"),
    },
    handler: (args) => getFileOutline(args.repo as string, args.file_path as string),
  },
  {
    name: "get_repo_outline",
    description: "Get a high-level outline of the entire repository grouped by directory",
    schema: {
      repo: z.string().describe("Repository identifier"),
    },
    handler: (args) => getRepoOutline(args.repo as string),
  },

  {
    name: "suggest_queries",
    description: "Suggest useful queries for exploring an unfamiliar repo. Returns top files by symbol density, kind distribution, and ready-to-use example queries. Ideal first call when starting work on a new codebase.",
    schema: {
      repo: z.string().describe("Repository identifier"),
    },
    handler: (args) => suggestQueries(args.repo as string),
  },

  // --- Symbol retrieval ---
  {
    name: "get_symbol",
    description: "Retrieve a single symbol by its unique ID with full source code. For 2+ symbols use get_symbols (batch). After search_symbols, prefer get_context_bundle for symbol + imports + siblings in 1 call. For 3+ reads, use assemble_context(level='L1').",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_id: z.string().describe("Unique symbol identifier"),
    },
    handler: (args) => getSymbol(args.repo as string, args.symbol_id as string),
  },
  {
    name: "get_symbols",
    description: "Retrieve multiple symbols by ID in a single batch call",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_ids: z.union([
        z.array(z.string()),
        z.string().transform((s) => JSON.parse(s) as string[]),
      ]).describe("Array of symbol identifiers. Can be passed as JSON string."),
    },
    handler: (args) => getSymbols(args.repo as string, args.symbol_ids as string[]),
  },
  {
    name: "find_and_show",
    description: "Find a symbol by name and show its source, optionally including references",
    schema: {
      repo: z.string().describe("Repository identifier"),
      query: z.string().describe("Symbol name or query to search for"),
      include_refs: z.boolean().optional().describe("Include locations that reference this symbol"),
    },
    handler: (args) => findAndShow(args.repo as string, args.query as string, args.include_refs as boolean | undefined),
  },
  {
    name: "get_context_bundle",
    description: "Get a symbol with its file imports and sibling symbols in one call. Saves 2-3 round-trips vs separate get_symbol + search_text + get_file_outline.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_name: z.string().describe("Symbol name to find"),
    },
    handler: (args) => getContextBundle(args.repo as string, args.symbol_name as string),
  },

  // --- References & call graph ---
  {
    name: "find_references",
    description: "Find all references to a symbol across the codebase. Pass symbol_names (array) to batch-search multiple symbols in one file pass — much faster than sequential calls on large repos.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_name: z.string().optional().describe("Name of the symbol to find references for"),
      symbol_names: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional()
        .describe("Array of symbol names for batch search (reads each file once). Can be JSON string."),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
    },
    handler: (args) => {
      const names = args.symbol_names as string[] | undefined;
      if (names && names.length > 0) {
        return findReferencesBatch(args.repo as string, names, args.file_pattern as string | undefined);
      }
      return findReferences(args.repo as string, args.symbol_name as string, args.file_pattern as string | undefined);
    },
  },
  {
    name: "trace_call_chain",
    description: "Trace the call chain of a symbol — who calls it (callers) or what it calls (callees). Source code is excluded by default for compact output; set include_source=true to include it. Set output_format='mermaid' for a Mermaid flowchart diagram.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_name: z.string().describe("Name of the symbol to trace"),
      direction: z.enum(["callers", "callees"]).describe("Trace direction"),
      depth: zNum().describe("Maximum depth to traverse the call graph (default: 1)"),
      include_source: z.boolean().optional().describe("Include full source code of each symbol (default: false)"),
      include_tests: z.boolean().optional().describe("Include test files in trace results (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (flowchart diagram)"),
    },
    handler: (args) => traceCallChain(args.repo as string, args.symbol_name as string, args.direction as Direction, {
      depth: args.depth as number | undefined,
      include_source: args.include_source as boolean | undefined,
      include_tests: args.include_tests as boolean | undefined,
      output_format: args.output_format as "json" | "mermaid" | undefined,
    }),
  },
  {
    name: "impact_analysis",
    description: "Analyze the blast radius of recent git changes — which symbols and files are affected. Source code is excluded by default for compact output.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      since: z.string().describe("Git ref to compare from (e.g. HEAD~3, commit SHA, branch)"),
      depth: zNum().describe("Depth of dependency traversal"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_source: z.boolean().optional().describe("Include full source code of affected symbols (default: false)"),
    },
    handler: (args) => impactAnalysis(args.repo as string, args.since as string, {
      depth: args.depth as number | undefined,
      until: args.until as string | undefined,
      include_source: args.include_source as boolean | undefined,
    }),
  },

  {
    name: "trace_route",
    description: "Trace an HTTP route: find handler function, trace to service calls, identify DB operations. Supports NestJS decorators, Next.js App Router, and Express patterns.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      path: z.string().describe("URL path to trace (e.g. '/api/users', '/api/projects/:id')"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (sequence diagram)"),
    },
    handler: (args) => traceRoute(args.repo as string, args.path as string, args.output_format as "json" | "mermaid" | undefined),
  },

  {
    name: "go_to_definition",
    description: "Go to the definition of a symbol. Uses LSP when available for type-safe precision, falls back to index search.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_name: z.string().describe("Symbol name to find definition of"),
      file_path: z.string().optional().describe("File containing the symbol reference (for LSP precision)"),
      line: zNum().describe("0-based line number of the reference"),
      character: zNum().describe("0-based column of the reference"),
    },
    handler: (args) => goToDefinition(
      args.repo as string,
      args.symbol_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  },

  {
    name: "get_type_info",
    description: "Get type information for a symbol (return type, parameter types, documentation). Requires a language server — returns hint if not available.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_name: z.string().describe("Symbol name to get type info for"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    },
    handler: (args) => getTypeInfo(
      args.repo as string,
      args.symbol_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  },

  {
    name: "rename_symbol",
    description: "Rename a symbol across all files using LSP refactoring. Type-safe, handles imports and references. Requires a language server — no fallback.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      symbol_name: z.string().describe("Current name of the symbol to rename"),
      new_name: z.string().describe("New name for the symbol"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    },
    handler: (args) => renameSymbol(
      args.repo as string,
      args.symbol_name as string,
      args.new_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  },

  {
    name: "detect_communities",
    description: "Detect code clusters/modules using Louvain community detection on the import graph. Discovers hidden architectural boundaries. Use focus to narrow scope.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      focus: z.string().optional().describe("Path substring to filter files (e.g. 'src/lib')"),
      resolution: zNum().describe("Louvain resolution: higher = more smaller communities, lower = fewer larger (default: 1.0)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (graph diagram)"),
    },
    handler: (args) => detectCommunities(
      args.repo as string,
      args.focus as string | undefined,
      args.resolution as number | undefined,
      args.output_format as "json" | "mermaid" | undefined,
    ),
  },

  {
    name: "classify_roles",
    description: "Classify each symbol's architectural role (entry/core/utility/adapter/dead/leaf) based on call graph connectivity. Entry points have many callees, few callers. Utilities have many callers, few callees. Core has both. Dead has no callers.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: z.boolean().optional().describe("Include test files (default: false)"),
      top_n: zNum().describe("Maximum number of symbols to return (default: 100)"),
    },
    handler: async (args) => {
      const { classifySymbolRoles } = await import("./tools/graph-tools.js");
      return classifySymbolRoles(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        top_n: args.top_n as number | undefined,
      });
    },
  },

  // --- Context & knowledge ---
  {
    name: "assemble_context",
    description: "Assemble a focused code context for a query within a token budget. Use level to control density: L0=full source, L1=signatures only (5-10x denser), L2=file summaries, L3=directory overview.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      query: z.string().describe("Natural language query describing what context is needed"),
      token_budget: zNum().describe("Maximum tokens for the assembled context"),
      level: z.enum(["L0", "L1", "L2", "L3"]).optional().describe("Context compression level: L0=full source (default), L1=signatures only, L2=file summaries, L3=directory overview"),
      rerank: z.boolean().optional().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    },
    handler: (args) => assembleContext(
      args.repo as string,
      args.query as string,
      args.token_budget as number | undefined,
      args.level as "L0" | "L1" | "L2" | "L3" | undefined,
      args.rerank as boolean | undefined,
    ),
  },
  {
    name: "get_knowledge_map",
    description: "Get the module dependency map showing how files and directories relate",
    schema: {
      repo: z.string().describe("Repository identifier"),
      focus: z.string().optional().describe("Focus on a specific module or directory"),
      depth: zNum().describe("Maximum depth of the dependency graph"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (dependency diagram)"),
    },
    handler: (args) => getKnowledgeMap(args.repo as string, args.focus as string | undefined, args.depth as number | undefined, args.output_format as "json" | "mermaid" | undefined),
  },

  // --- Diff ---
  {
    name: "diff_outline",
    description: "Get a structural outline of what changed between two git refs",
    schema: {
      repo: z.string().describe("Repository identifier"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
    },
    handler: (args) => diffOutline(args.repo as string, args.since as string, args.until as string | undefined),
  },
  {
    name: "changed_symbols",
    description: "List symbols that were added, modified, or removed between two git refs",
    schema: {
      repo: z.string().describe("Repository identifier"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_diff: z.boolean().optional().describe("Include unified diff per changed file (truncated to 500 chars)"),
    },
    handler: (args) => {
      const opts: { include_diff?: boolean } = {};
      if (args.include_diff === true) opts.include_diff = true;
      return changedSymbols(args.repo as string, args.since as string, args.until as string | undefined, opts);
    },
  },

  // --- Generation ---
  {
    name: "generate_claude_md",
    description: "Generate a CLAUDE.md project summary file from the repository index",
    schema: {
      repo: z.string().describe("Repository identifier"),
      output_path: z.string().optional().describe("Custom output file path"),
    },
    handler: (args) => generateClaudeMd(args.repo as string, args.output_path as string | undefined),
  },

  // --- Batch retrieval ---
  {
    name: "codebase_retrieval",
    description: "Batch multiple search and retrieval queries into a single call with shared token budget. Semantic and hybrid sub-queries exclude test files by default (set exclude_tests:false to include them).",
    schema: {
      repo: z.string().describe("Repository identifier"),
      queries: z
        .union([
          z.array(z.object({ type: z.string() }).passthrough()),
          z.string().transform((s) => JSON.parse(s) as Array<{ type: string } & Record<string, unknown>>),
        ])
        .describe("Array of sub-queries (symbols, text, file_tree, outline, references, call_chain, impact, context, knowledge_map). Can be passed as JSON string."),
      token_budget: zNum().describe("Maximum total tokens across all sub-query results"),
    },
    handler: (args) => codebaseRetrieval(
      args.repo as string,
      args.queries as Array<{ type: string } & Record<string, unknown>>,
      args.token_budget as number | undefined,
    ),
  },

  // --- Analysis ---
  {
    name: "find_dead_code",
    description: "Find potentially dead code: exported symbols with zero references outside their defining file. Useful for identifying unused exports to clean up.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: z.boolean().optional().describe("Include test files in scan (default: false)"),
    },
    handler: (args) => findDeadCode(args.repo as string, {
      file_pattern: args.file_pattern as string | undefined,
      include_tests: args.include_tests as boolean | undefined,
    }),
  },
  {
    name: "analyze_complexity",
    description: "Analyze cyclomatic complexity of functions in a repository. Returns top N most complex functions with nesting depth, branch count, and line count. Useful for prioritizing refactoring.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      top_n: zNum().describe("Return top N most complex functions (default: 30)"),
      min_complexity: zNum().describe("Minimum cyclomatic complexity to include (default: 1)"),
      include_tests: z.boolean().optional().describe("Include test files (default: false)"),
    },
    handler: (args) => analyzeComplexity(args.repo as string, {
      file_pattern: args.file_pattern as string | undefined,
      top_n: args.top_n as number | undefined,
      min_complexity: args.min_complexity as number | undefined,
      include_tests: args.include_tests as boolean | undefined,
    }),
  },
  {
    name: "find_clones",
    description: "Find code clones: pairs of functions with similar normalized source (copy-paste detection). Uses hash bucketing + line-similarity scoring.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      min_similarity: zNum().describe("Minimum similarity threshold 0-1 (default: 0.7)"),
      min_lines: zNum().describe("Minimum normalized lines to consider (default: 10)"),
      include_tests: z.boolean().optional().describe("Include test files (default: false)"),
    },
    handler: (args) => findClones(args.repo as string, {
      file_pattern: args.file_pattern as string | undefined,
      min_similarity: args.min_similarity as number | undefined,
      min_lines: args.min_lines as number | undefined,
      include_tests: args.include_tests as boolean | undefined,
    }),
  },
  {
    name: "frequency_analysis",
    description: "Find the most common code structures by normalizing AST and grouping by shape. Discovers emergent patterns invisible to regex: functions with the same control flow but different variable names are grouped together. Returns TOP N clusters with examples. For similar-but-not-identical pairs, use find_clones instead.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      top_n: zNum().optional().describe("Number of clusters to return (default: 30)"),
      min_nodes: zNum().optional().describe("Minimum AST nodes in a subtree to include (default: 5)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      kind: z.string().optional().describe("Filter by symbol kind, comma-separated (default: function,method)"),
      include_tests: z.boolean().optional().describe("Include test files (default: false)"),
      token_budget: zNum().optional().describe("Max tokens for response"),
    },
    handler: async (args) => frequencyAnalysis(
      args.repo as string,
      {
        top_n: args.top_n as number | undefined,
        min_nodes: args.min_nodes as number | undefined,
        file_pattern: args.file_pattern as string | undefined,
        kind: args.kind as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        token_budget: args.token_budget as number | undefined,
      },
    ),
  },
  {
    name: "analyze_hotspots",
    description: "Analyze git churn hotspots: files with high change frequency × complexity. Higher hotspot_score = more likely to contain bugs. Uses git log --numstat.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      since_days: zNum().describe("Look back N days (default: 90)"),
      top_n: zNum().describe("Return top N hotspots (default: 30)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    },
    handler: (args) => analyzeHotspots(args.repo as string, {
      since_days: args.since_days as number | undefined,
      top_n: args.top_n as number | undefined,
      file_pattern: args.file_pattern as string | undefined,
    }),
  },

  // --- Cross-repo ---
  {
    name: "cross_repo_search",
    description: "Search symbols across ALL indexed repositories. Useful for monorepos and microservice architectures.",
    schema: {
      query: z.string().describe("Symbol search query"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern (e.g. 'local/tgm')"),
      kind: z.string().optional().describe("Filter by symbol kind"),
      top_k: zNum().describe("Max results per repo (default: 10)"),
      include_source: z.boolean().optional().describe("Include source code"),
    },
    handler: (args) => crossRepoSearchSymbols(args.query as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      kind: args.kind as SymbolKind | undefined,
      top_k: args.top_k as number | undefined,
      include_source: args.include_source as boolean | undefined,
    }),
  },
  {
    name: "cross_repo_refs",
    description: "Find references to a symbol across ALL indexed repositories.",
    schema: {
      symbol_name: z.string().describe("Symbol name to find references for"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern"),
      file_pattern: z.string().optional().describe("Filter files by glob pattern"),
    },
    handler: (args) => crossRepoFindReferences(args.symbol_name as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      file_pattern: args.file_pattern as string | undefined,
    }),
  },

  // --- Patterns ---
  {
    name: "search_patterns",
    description: "Search for structural code patterns (anti-patterns, CQ violations). Built-in patterns: useEffect-no-cleanup, empty-catch, any-type, console-log, await-in-loop, no-error-type, toctou, unbounded-findmany. Or pass custom regex.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      pattern: z.string().describe("Built-in pattern name or custom regex"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: z.boolean().optional().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max results (default: 50)"),
    },
    handler: (args) => searchPatterns(args.repo as string, args.pattern as string, {
      file_pattern: args.file_pattern as string | undefined,
      include_tests: args.include_tests as boolean | undefined,
      max_results: args.max_results as number | undefined,
    }),
  },
  {
    name: "list_patterns",
    description: "List all available built-in structural code patterns for search_patterns.",
    schema: {},
    handler: async () => listPatterns(),
  },

  // --- Report ---
  {
    name: "generate_report",
    description: "Generate a standalone HTML report with complexity, dead code, hotspots, and architecture. Opens in any browser.",
    schema: {
      repo: z.string().describe("Repository identifier"),
    },
    handler: (args) => generateReport(args.repo as string),
  },

  // --- Conversations ---
  {
    name: "index_conversations",
    description: "Index Claude Code conversation history for search. Scans JSONL files in ~/.claude/projects/ for the given project path.",
    schema: {
      project_path: z.string().optional().describe("Path to the Claude project conversations directory. Auto-detects from cwd if omitted."),
      quiet: z.boolean().optional().describe("Suppress output (used by session-end hook)"),
    },
    handler: async (args) => indexConversations(args.project_path as string | undefined),
  },
  {
    name: "search_conversations",
    description: "Search past Claude Code conversations in a SINGLE project using hybrid BM25+semantic search. Use search_all_conversations to search across ALL projects.",
    schema: {
      query: z.string().describe("Search query — keywords or natural language"),
      project: z.string().optional().describe("Project path to search (default: current project)"),
      limit: zNum().optional().describe("Maximum results to return (default: 10, max: 50)"),
    },
    handler: async (args) => searchConversations(
      args.query as string,
      args.project as string | undefined,
      args.limit as number | undefined,
    ),
  },
  {
    name: "find_conversations_for_symbol",
    description: "Find past conversations that discussed a specific code symbol. Cross-references code intelligence with conversation history.",
    schema: {
      symbol_name: z.string().describe("Name of the code symbol to search for in conversations"),
      repo: z.string().describe("Code repository to resolve the symbol from (e.g., 'local/my-project')"),
      limit: zNum().optional().describe("Maximum conversation results (default: 5)"),
    },
    handler: async (args) => findConversationsForSymbol(
      args.symbol_name as string,
      args.repo as string,
      args.limit as number | undefined,
    ),
  },

  {
    name: "search_all_conversations",
    description: "Search ALL indexed Claude Code conversation projects at once. Use this when you don't know which project a conversation was in. Returns results from all projects ranked by relevance.",
    schema: {
      query: z.string().describe("Search query — keywords, natural language, or concept"),
      limit: zNum().optional().describe("Maximum results across all projects (default: 10)"),
    },
    handler: async (args) => searchAllConversations(
      args.query as string,
      args.limit as number | undefined,
    ),
  },

  // --- Security ---
  {
    name: "scan_secrets",
    description: "Scan repository for hardcoded secrets (API keys, tokens, passwords, connection strings). Returns masked findings with severity, confidence, and AST context. Uses ~1,100 detection rules.",
    schema: {
      repo: z.string().describe("Repository identifier"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level (default: medium)"),
      exclude_tests: z.boolean().optional().describe("Exclude test file findings (default: true)"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Minimum severity level"),
    },
    handler: async (args) => scanSecrets(
      args.repo as string,
      {
        file_pattern: args.file_pattern as string | undefined,
        min_confidence: args.min_confidence as "high" | "medium" | "low" | undefined,
        exclude_tests: args.exclude_tests as boolean | undefined,
        severity: args.severity as SecretSeverity | undefined,
      },
    ),
  },

  // --- Stats ---
  {
    name: "usage_stats",
    description: "Show usage statistics for all CodeSift tool calls (call counts, tokens, timing, repos)",
    schema: {},
    handler: async () => {
      const stats = await getUsageStats();
      return { report: formatUsageReport(stats) };
    },
  },
];

// ---------------------------------------------------------------------------
// Registration loop
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  for (const tool of TOOL_DEFINITIONS) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (args) => wrapTool(tool.name, args as Record<string, unknown>, () => tool.handler(args as Record<string, unknown>))(),
    );
  }
}
