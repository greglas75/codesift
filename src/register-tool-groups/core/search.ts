import { z, zBool, zNum, lazySchema, OutputSchemas, checkTextStubHint, type ToolDefinitionEntry } from "../shared.js";
import { searchSymbols, searchText, semanticSearch, getFileTree, getFileOutline, getRepoOutline, suggestQueries, codebaseRetrieval, dispatchFormatter, type SymbolKind } from "../deps.js";
import { zJsonArray } from "./schema.js";

export const CORE_SEARCH_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Search ---
  { order: 1237, definition: {
    name: "search_symbols",
    category: "search",
    searchHint: "search find symbols functions classes types methods by name signature",
    outputSchema: OutputSchemas.searchResults,
    description: "Search symbols by name/signature. Supports kind, file, and decorator filters. detail_level: compact (~15 tok), standard (default), full.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Search query string"),
      kind: z.string().optional().describe("Filter by symbol kind (function, class, etc.)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      decorator: z.string().optional().describe("Filter by decorator metadata, e.g. login_required, @dataclass, router.get"),
      include_source: zBool().describe("Include full source code of each symbol"),
      top_k: zNum().describe("Maximum number of results to return (default 50)"),
      source_chars: zNum().describe("Truncate each symbol's source to N characters (reduces output size)"),
      detail_level: z.enum(["compact", "standard", "full"]).optional().describe("compact (~15 tok), standard (default), full (all source)"),
      token_budget: zNum().describe("Max tokens for results — greedily packs results until budget exhausted. Overrides top_k."),
      rerank: zBool().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    })),
    handler: async (args) => {
      const results = await searchSymbols(args.repo as string, args.query as string, {
        kind: args.kind as SymbolKind | undefined,
        file_pattern: args.file_pattern as string | undefined,
        decorator: args.decorator as string | undefined,
        include_source: args.include_source as boolean | undefined,
        top_k: args.top_k as number | undefined,
        source_chars: args.source_chars as number | undefined,
        detail_level: args.detail_level as "compact" | "standard" | "full" | undefined,
        token_budget: args.token_budget as number | undefined,
        rerank: args.rerank as boolean | undefined,
      });
      const output = dispatchFormatter("search_symbols", results);
      const hint = await checkTextStubHint(args.repo as string, "search_symbols", results.length === 0);
      return hint ? hint + output : output;
    },
  } },
  { order: 1273, definition: {
    name: "ast_query",
    category: "search",
    searchHint: "AST tree-sitter query structural pattern matching code shape jsx react",
    description: "Search AST patterns via tree-sitter S-expressions. Finds code by structural shape. React examples (language='tsx'): `(jsx_element open_tag: (jsx_opening_element name: (identifier) @tag))` finds all JSX component usage; `(call_expression function: (identifier) @fn (#match? @fn \"^use[A-Z]\"))` finds all hook calls.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Tree-sitter query in S-expression syntax. For JSX/React use language='tsx'."),
      language: z.string().describe("Tree-sitter grammar: typescript, tsx, javascript, python, go, rust, java, ruby, php"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      max_matches: zNum().describe("Maximum matches to return (default: 50)"),
    })),
    handler: async (args) => {
      const { astQuery } = await import("../../tools/ast-query-tools.js");
      return astQuery(args.repo as string, args.query as string, {
        language: args.language as string | undefined,
        file_pattern: args.file_pattern as string | undefined,
        max_matches: args.max_matches as number | undefined,
      });
    },
  } },
  { order: 1294, definition: {
    name: "semantic_search",
    category: "search",
    searchHint: "semantic meaning intent concept embedding vector natural language",
    description: "Search code by meaning using embeddings. For intent-based queries: 'error handling', 'auth flow'. Requires indexed embeddings.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural language query describing what you're looking for"),
      top_k: zNum().describe("Number of results (default: 10)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      exclude_tests: zBool().describe("Exclude test files from results"),
      rerank: zBool().describe("Re-rank results with cross-encoder for better precision"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof semanticSearch>[2] = {};
      if (args.top_k != null) opts.top_k = args.top_k as number;
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.exclude_tests != null) opts.exclude_tests = args.exclude_tests as boolean;
      if (args.rerank != null) opts.rerank = args.rerank as boolean;
      return semanticSearch(args.repo as string, args.query as string, opts);
    },
  } },
  { order: 1316, definition: {
    name: "search_text",
    category: "search",
    searchHint: "full-text search grep regex keyword content files",
    description: "Full-text search across all files. For conceptual queries use semantic_search.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Search query or regex pattern"),
      regex: zBool().describe("Treat query as a regex pattern"),
      context_lines: zNum().describe("Number of context lines around each match"),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      max_results: zNum().describe("Maximum number of matching lines to return (default 200)"),
      group_by_file: zBool().describe("Group by file: {file, count, lines[], first_match}. ~80% less output."),
      auto_group: zBool().describe("Auto group_by_file when >50 matches."),
      ranked: z.boolean().optional().describe("Classify hits by containing symbol and rank by centrality"),
    })),
    handler: async (args) => {
      const result: unknown = await searchText(args.repo as string, args.query as string, {
        regex: args.regex as boolean | undefined,
        context_lines: args.context_lines as number | undefined,
        file_pattern: args.file_pattern as string | undefined,
        max_results: args.max_results as number | undefined,
        group_by_file: args.group_by_file as boolean | undefined,
        auto_group: args.auto_group as boolean | undefined,
        ranked: args.ranked as boolean | undefined,
      });
      // Zero-result fallback: 44% of search_text calls return nothing in
      // telemetry. Instead of a bare empty array, return (a) shape-based
      // hints, (b) near-miss symbol names from the index vocabulary, and
      // (c) semantic results when an embeddings index already exists —
      // so the agent doesn't burn 2-3 follow-up turns guessing.
      const isEmpty =
        (Array.isArray(result) && result.length === 0)
        || (typeof result === "string" && (result as string).length === 0);
      if (isEmpty) {
        const q = args.query as string;
        const fp = args.file_pattern as string | undefined;
        const looksLikeSymbol =
          /::|->|\.[a-z][a-zA-Z0-9_]*\(/.test(q)
          || /^(class|function|def|fn|interface|type)\s+\w/.test(q)
          || (/^[A-Z][a-zA-Z0-9_]+$|^[a-z][a-zA-Z0-9_]+$/.test(q.trim()) && !q.includes(" "));
        const hints: string[] = ["No matches."];
        if (looksLikeSymbol) hints.push("Query looks like a symbol — try search_symbols(query=...) instead.");
        if (fp) hints.push(`Try without file_pattern="${fp}" to widen scope.`);
        if (args.regex === true) hints.push("Try regex=false (literal) — escapes may be off.");
        if (!fp && !looksLikeSymbol) hints.push("Try a shorter substring, or add file_pattern= to scope.");

        const { zeroHitFallback } = await import("../../register-tool-loaders.js");
        const fallback = await zeroHitFallback(args.repo as string, q);
        if (fallback.semantic_results) {
          hints.push("Exact text not found — semantic_fallback below shows closest matches by meaning.");
        }
        const response: Record<string, unknown> = { matches: [], hint: hints.join(" ") };
        if (fallback.suggestions) {
          response["did_you_mean"] = fallback.suggestions;
        }
        if (fallback.semantic_results) {
          response["semantic_fallback"] = fallback.semantic_results;
        }
        return response;
      }
      return result;
    },
  } },
  // --- Outline ---
  { order: 1382, definition: {
    name: "get_file_tree",
    category: "outline",
    searchHint: "file tree directory structure listing files symbols",
    outputSchema: OutputSchemas.fileTree,
    description: "File tree with symbol counts. Defaults to a flat compact list (10-50x less output); pass compact:false for the nested tree. Cached 5min.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path_prefix: z.string().optional().describe("Filter to a subtree by path prefix"),
      name_pattern: z.string().optional().describe("Glob pattern to filter file names"),
      depth: zNum().describe("Maximum directory depth to traverse"),
      compact: zBool().describe("Return flat list of {path, symbols} instead of nested tree (much less output). Default: true — pass false for the nested tree."),
      min_symbols: zNum().describe("Only include files with at least this many symbols"),
    })),
    handler: async (args) => {
      // Default to compact when the caller omits the arg — the biggest token sink in
      // telemetry (1.1M tok over 881 calls) came from agents rarely passing compact=true.
      // An explicit compact:false still returns the full nested tree.
      const compact = args.compact === undefined ? true : (args.compact as boolean);
      const result = await getFileTree(args.repo as string, {
        path_prefix: args.path_prefix as string | undefined,
        name_pattern: args.name_pattern as string | undefined,
        depth: args.depth as number | undefined,
        compact,
        min_symbols: args.min_symbols as number | undefined,
      });
      return dispatchFormatter("get_file_tree", result);
    },
  } },
  { order: 1407, definition: {
    name: "get_file_outline",
    category: "outline",
    searchHint: "file outline symbols functions classes exports single file",
    outputSchema: OutputSchemas.fileOutline,
    description: "Get the symbol outline of a single file (functions, classes, exports)",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_path: z.string().describe("Relative file path within the repository"),
    })),
    handler: async (args) => {
      const result = await getFileOutline(args.repo as string, args.file_path as string);
      const output = dispatchFormatter("get_file_outline", result);
      const isEmpty = !result || (Array.isArray(result) && result.length === 0);
      const hint = await checkTextStubHint(args.repo as string, "get_file_outline", isEmpty);
      return hint ? hint + output : output;
    },
  } },
  { order: 1425, definition: {
    name: "get_repo_outline",
    cacheable: true,
    category: "outline",
    searchHint: "repository outline overview directory structure high-level",
    description: "Get a high-level outline of the entire repository grouped by directory",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await getRepoOutline(args.repo as string);
      return dispatchFormatter("get_repo_outline", result);
    },
  } },
  { order: 1439, definition: {
    name: "suggest_queries",
    category: "outline",
    searchHint: "suggest queries explore unfamiliar repo onboarding first call",
    description: "Suggest queries for exploring a new repo. Returns top files, kind distribution, examples.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await suggestQueries(args.repo as string);
      return dispatchFormatter("suggest_queries", result);
    },
  } },
];

export const CORE_BATCH_SEARCH_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Batch retrieval ---
  { order: 2088, definition: {
    name: "codebase_retrieval",
    category: "search",
    searchHint: "batch retrieval multi-query semantic hybrid token budget",
    outputSchema: OutputSchemas.batchResults,
    description: "Batch multi-query retrieval with shared token budget. Supports symbols/text/semantic/hybrid.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      queries: z
        .union([
          z.array(z.object({ type: z.string() }).passthrough()),
          zJsonArray(z.object({ type: z.string().trim().min(1) }).passthrough()),
        ])
        .describe("Sub-queries array (symbols/text/file_tree/outline/references/call_chain/impact/context/knowledge_map). JSON string OK."),
      token_budget: zNum().describe("Maximum total tokens across all sub-query results"),
    })),
    handler: async (args) => {
      const result = await codebaseRetrieval(
        args.repo as string,
        args.queries as Array<{ type: string } & Record<string, unknown>>,
        args.token_budget as number | undefined,
      );
      // Format as text sections instead of JSON envelope
      const sections = result.results.map((r) => {
        const dataStr = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
        return `--- ${r.type} ---\n${dataStr}`;
      });
      let output = sections.join("\n\n");
      if (result.truncated) output += "\n\n(truncated: token budget exceeded)";
      return output;
    },
  } },
];
