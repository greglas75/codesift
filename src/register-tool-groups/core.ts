import { z, zBool, zNum, lazySchema, OutputSchemas, checkTextStubHint, detectAutoLoadToolsCached, enableToolByName, type ToolDefinitionEntry } from "./shared.js";
import { indexFolder, indexFile, indexRepo, listAllRepos, invalidateCache, searchSymbols, searchText, semanticSearch, getFileTree, getFileOutline, getRepoOutline, suggestQueries, getSymbol, getSymbols, findAndShow, findReferences, findReferencesBatch, getContextBundle, formatRefsCompact, formatSymbolCompact, formatSymbolsCompact, formatBundleCompact, traceCallChain, impactAnalysis, traceRoute, detectCommunities, assembleContext, getKnowledgeMap, diffOutline, changedSymbols, generateClaudeMd, codebaseRetrieval, goToDefinition, getTypeInfo, renameSymbol, getCallHierarchy, formatSearchSymbols, formatFileTree, formatFileOutline, formatRepoOutline, formatSuggestQueries, formatRoles, formatAssembleContext, formatCommunities, formatCallTree, formatTraceRoute, formatKnowledgeMap, formatImpactAnalysis, formatDiffOutline, formatChangedSymbols, type SymbolKind, type Direction } from "./deps.js";

// Token diet (2026-07-10 tool-runtime-opt plan, Task 4): find_references' default
// result cap. Telemetry showed find_references as the #2 token sink (605 calls /
// 909K tok), most of it unbounded result sets on common symbol names. An explicit
// higher max_refs opts out.
const DEFAULT_MAX_REFS = 50;

/**
 * Sanitize a client-supplied `max_refs` into a usable slice length. zNum() only
 * guarantees a finite number, so -1 or 2.5 reach the handler as-is: `slice(0, -1)`
 * silently DROPS the last reference (and reports a nonsense `+${len+1} more`),
 * and a fractional cap prints `+7.5 more`. Clamp to a whole number ≥ 0.
 */
function normalizeMaxRefs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_REFS;
  return Math.max(0, Math.floor(raw));
}

export const CORE_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Indexing ---
  { order: 1154, definition: {
    name: "index_folder",
    category: "indexing",
    searchHint: "index local folder directory project parse symbols",
    description: "Index a local folder, extracting symbols and building the search index",
    schema: lazySchema(() => ({
      path: z.string().describe("Absolute path to the folder to index"),
      incremental: zBool().describe("Only re-index changed files"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
      max_files: z.number().int().positive().optional().describe("Cap on files indexed. Default 50000 (or CODESIFT_MAX_FILES env). Walker stops at this count and returns partial results — protects against OOM on huge repos. Use include_paths to scope instead of raising this for large vendored trees."),
      watch: zBool().describe("Whether to set up a chokidar file watcher for incremental updates after indexing. Default true. Pass false for bulk/CI indexing scenarios — file watchers consume system file descriptors (1+ per repo on macOS FSEvents); indexing many repos with watchers active can exhaust the system file table (ENFILE)."),
    })),
    handler: async (args) => {
      const result = await indexFolder(args.path as string, {
        incremental: args.incremental as boolean | undefined,
        include_paths: args.include_paths as string[] | undefined,
        max_files: args.max_files as number | undefined,
        watch: args.watch as boolean | undefined,
      });
      // Auto-enable framework tools based on indexed path (not CWD)
      try {
        const toEnable = await detectAutoLoadToolsCached(args.path as string);
        for (const name of toEnable) enableToolByName(name);
      } catch { /* best-effort — non-fatal */ }
      return result;
    },
  } },
  { order: 1181, definition: {
    name: "index_repo",
    category: "indexing",
    searchHint: "clone remote git repository index",
    description: "Clone and index a remote git repository",
    schema: lazySchema(() => ({
      url: z.string().describe("Git clone URL"),
      branch: z.string().optional().describe("Branch to checkout"),
      include_paths: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional().describe("Glob patterns to include. Can be passed as JSON string."),
    })),
    handler: (args) => indexRepo(args.url as string, {
      branch: args.branch as string | undefined,
      include_paths: args.include_paths as string[] | undefined,
    }),
  } },
  { order: 1196, definition: {
    name: "list_repos",
    category: "indexing",
    searchHint: "list indexed repositories repos available",
    outputSchema: OutputSchemas.repoList,
    description: "List indexed repos. Only needed for multi-repo discovery — single-repo tools auto-resolve from CWD. Set compact=false for full metadata.",
    schema: lazySchema(() => ({
      compact: zBool().describe("true=names only (default), false=full metadata"),
      name_contains: z.string().optional().describe("Filter repos by name substring (case-insensitive). E.g. 'tgm' matches 'local/tgm-panel'"),
    })),
    handler: (args) => {
      const opts: { compact?: boolean; name_contains?: string } = {
        compact: (args.compact as boolean | undefined) ?? true,
      };
      if (args.name_contains) opts.name_contains = args.name_contains as string;
      return listAllRepos(opts);
    },
  } },
  { order: 1214, definition: {
    name: "invalidate_cache",
    category: "indexing",
    searchHint: "clear cache invalidate re-index refresh",
    description: "Clear the index cache for a repository, forcing full re-index on next use",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: (args) => invalidateCache(args.repo as string),
  } },
  { order: 1225, definition: {
    name: "index_file",
    category: "indexing",
    searchHint: "re-index single file update incremental",
    description: "Re-index a single file after editing. Auto-finds repo, skips if unchanged.",
    schema: lazySchema(() => ({
      path: z.string().describe("Absolute path to the file to re-index"),
    })),
    handler: (args) => indexFile(args.path as string),
  } },
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
      const output = formatSearchSymbols(results);
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
      const { astQuery } = await import("../tools/ast-query-tools.js");
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

        const { zeroHitFallback } = await import("../register-tool-loaders.js");
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
      return formatFileTree(result as never);
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
      const output = formatFileOutline(result as never);
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
      return formatRepoOutline(result as never);
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
      return formatSuggestQueries(result as never);
    },
  } },
  // --- Symbol retrieval ---
  { order: 1454, definition: {
    name: "get_symbol",
    category: "symbols",
    searchHint: "get retrieve single symbol source code by ID",
    outputSchema: OutputSchemas.symbol,
    description: "Get symbol by ID with source. Auto-prefetches children for classes. For batch: get_symbols. For context: get_context_bundle.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_id: z.string().describe("Unique symbol identifier"),
      include_related: zBool().describe("Include children/related symbols (default: true)"),
    })),
    handler: async (args) => {
      const opts: { include_related?: boolean } = {};
      if (args.include_related != null) opts.include_related = args.include_related as boolean;
      const symbolId = args.symbol_id as string;
      const result = await getSymbol(args.repo as string, symbolId, opts);
      if (!result) {
        // Telemetry: 24% of get_symbol calls return null (hallucinated IDs).
        // Suggest closest matches by name so the agent doesn't burn turns guessing.
        const { findSimilarSymbols } = await import("../tools/symbol-tools.js");
        const similar = await findSimilarSymbols(args.repo as string, symbolId, 3);
        if (similar.length > 0) {
          const suggestions = similar.map((s) => `  ${s.id}  (${s.kind} ${s.name} @ ${s.file}:${s.start_line})`).join("\n");
          return `Symbol "${symbolId}" not found. Did you mean:\n${suggestions}`;
        }
        const hint = await checkTextStubHint(args.repo as string, "get_symbol", true);
        return hint ?? `Symbol "${symbolId}" not found. Use search_symbols(query=...) to discover available IDs.`;
      }
      let text = await formatSymbolCompact(result.symbol);
      if (result.related && result.related.length > 0) {
        text += "\n\n--- children ---\n" + result.related.map((s) => `${s.kind} ${s.name}${s.signature ? s.signature : ""} [${s.file}:${s.start_line}]`).join("\n");
      }
      return text;
    },
  } },
  { order: 1489, definition: {
    name: "get_symbols",
    category: "symbols",
    searchHint: "batch get multiple symbols by IDs",
    description: "Retrieve multiple symbols by ID in a single batch call",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_ids: z.union([
        z.array(z.string()),
        z.string().transform((s) => JSON.parse(s) as string[]),
      ]).describe("Array of symbol identifiers. Can be passed as JSON string."),
    })),
    handler: async (args) => {
      const ids = args.symbol_ids as string[];
      const syms = await getSymbols(args.repo as string, ids);
      const output = await formatSymbolsCompact(syms);
      // Surface fuzzy suggestions for missing IDs (telemetry: 26% zero rate).
      let suggestions = "";
      if (syms.length < ids.length) {
        const foundIds = new Set(syms.map((s) => s.id));
        const missing = ids.filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          const { findSimilarSymbols } = await import("../tools/symbol-tools.js");
          const lines: string[] = [];
          for (const m of missing.slice(0, 5)) {
            const sims = await findSimilarSymbols(args.repo as string, m, 2);
            if (sims.length > 0) {
              lines.push(`  ${m} → ${sims.map((s) => s.id).join(", ")}`);
            } else {
              lines.push(`  ${m} → no similar symbols`);
            }
          }
          suggestions = `\n\n--- not found (${missing.length}) — suggestions ---\n${lines.join("\n")}`;
        }
      }
      const hint = await checkTextStubHint(args.repo as string, "get_symbols", syms.length === 0);
      return (hint ? hint + output : output) + suggestions;
    },
  } },
  { order: 1528, definition: {
    name: "find_and_show",
    category: "symbols",
    searchHint: "find symbol by name show source code references",
    description: "Find a symbol by name and show its source, optionally including references",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Symbol name or query to search for"),
      include_refs: zBool().describe("Include locations that reference this symbol"),
    })),
    handler: async (args) => {
      const result = await findAndShow(args.repo as string, args.query as string, args.include_refs as boolean | undefined);
      if (!result) return null;
      let text = await formatSymbolCompact(result.symbol);
      if (result.references) {
        text += `\n\n--- references ---\n${await formatRefsCompact(result.references)}`;
      }
      return text;
    },
  } },
  { order: 1548, definition: {
    name: "get_context_bundle",
    category: "symbols",
    searchHint: "context bundle symbol imports siblings callers one call",
    description: "Symbol + imports + siblings in one call. Saves 2-3 round-trips.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to find"),
    })),
    handler: async (args) => {
      const bundle = await getContextBundle(args.repo as string, args.symbol_name as string);
      if (!bundle) return null;
      return formatBundleCompact(bundle);
    },
  } },
  // --- References & call graph ---
  { order: 1565, definition: {
    name: "find_references",
    category: "graph",
    searchHint: "find references usages callers who uses symbol",
    outputSchema: OutputSchemas.references,
    description: "Find all references to a symbol. Pass symbol_names array for batch search. Capped at max_refs (default 50) — per symbol in batch mode; pass a higher value to see more.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().optional().describe("Name of the symbol to find references for"),
      symbol_names: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional()
        .describe("Array of symbol names for batch search (reads each file once). Can be JSON string."),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
      max_refs: zNum().describe("Maximum number of references to return, per symbol (default 50). Negative/fractional values are clamped to a whole number ≥ 0."),
    })),
    handler: async (args) => {
      const maxRefs = normalizeMaxRefs(args.max_refs);
      const names = args.symbol_names as string[] | undefined;
      if (names && names.length > 0) {
        // The batch path fans out over MANY symbols — it is the one that most
        // needs the cap, so apply it per symbol (return shape unchanged).
        const batch = await findReferencesBatch(args.repo as string, names, args.file_pattern as string | undefined);
        for (const name of Object.keys(batch)) {
          const refs = batch[name];
          if (refs && refs.length > maxRefs) batch[name] = refs.slice(0, maxRefs);
        }
        return batch;
      }
      const refs = await findReferences(args.repo as string, args.symbol_name as string, args.file_pattern as string | undefined);
      const truncated = refs.length > maxRefs;
      const shown = truncated ? refs.slice(0, maxRefs) : refs;
      const output = await formatRefsCompact(shown);
      const overflow = truncated ? `\n… +${refs.length - maxRefs} more (pass max_refs to see more)` : "";
      const hint = await checkTextStubHint(args.repo as string, "find_references", refs.length === 0);
      return (hint ? hint + output : output) + overflow;
    },
  } },
  { order: 1589, definition: {
    name: "trace_call_chain",
    category: "graph",
    searchHint: "trace call chain callers callees dependency graph mermaid react hooks",
    outputSchema: OutputSchemas.callTree,
    description: "Trace call chain: callers or callees. output_format='mermaid' for diagram. filter_react_hooks=true skips useState/useEffect etc. for cleaner React graphs.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Name of the symbol to trace"),
      direction: z.enum(["callers", "callees"]).describe("Trace direction"),
      depth: zNum().describe("Maximum depth to traverse the call graph (default: 1)"),
      include_source: zBool().describe("Include full source code of each symbol (default: false)"),
      include_tests: zBool().describe("Include test files in trace results (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (flowchart diagram)"),
      filter_react_hooks: zBool().describe("Skip edges to React stdlib hooks (useState, useEffect, etc.) to reduce call graph noise in React codebases (default: false)"),
    })),
    handler: async (args) => {
      const result = await traceCallChain(args.repo as string, args.symbol_name as string, args.direction as Direction, {
        depth: args.depth as number | undefined,
        include_source: args.include_source as boolean | undefined,
        include_tests: args.include_tests as boolean | undefined,
        output_format: args.output_format as "json" | "mermaid" | undefined,
        filter_react_hooks: args.filter_react_hooks as boolean | undefined,
      });
      const output = formatCallTree(result as never);
      const isEmpty = typeof result === "object" && result != null && "children" in result && Array.isArray((result as { children: unknown[] }).children) && (result as { children: unknown[] }).children.length === 0;
      const hint = await checkTextStubHint(args.repo as string, "trace_call_chain", isEmpty);
      return hint ? hint + output : output;
    },
  } },
  { order: 1619, definition: {
    name: "impact_analysis",
    category: "graph",
    searchHint: "impact analysis blast radius git changes affected symbols",
    outputSchema: OutputSchemas.impactAnalysis,
    description: "Blast radius of git changes — affected symbols and files.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from (e.g. HEAD~3, commit SHA, branch)"),
      depth: zNum().describe("Depth of dependency traversal"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_source: zBool().describe("Include full source code of affected symbols (default: false)"),
    })),
    handler: async (args) => {
      const result = await impactAnalysis(args.repo as string, args.since as string, {
        depth: args.depth as number | undefined,
        until: args.until as string | undefined,
        include_source: args.include_source as boolean | undefined,
      });
      return formatImpactAnalysis(result as never);
    },
  } },
  { order: 1761, definition: {
    name: "trace_route",
    category: "graph",
    searchHint: "trace HTTP route handler API endpoint service database NestJS Express Next.js",
    description: "Trace HTTP route → handler → service → DB. NestJS, Next.js, Express.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().describe("URL path to trace (e.g. '/api/users', '/api/projects/:id')"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (sequence diagram)"),
    })),
    handler: async (args) => {
      const result = await traceRoute(args.repo as string, args.path as string, args.output_format as "json" | "mermaid" | undefined);
      return formatTraceRoute(result as never);
    },
  } },
  { order: 1777, definition: {
    name: "go_to_definition",
    category: "lsp",
    searchHint: "go to definition jump navigate LSP language server",
    outputSchema: OutputSchemas.definition,
    description: "Go to the definition of a symbol. Uses LSP when available for type-safe precision, falls back to index search.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to find definition of"),
      file_path: z.string().optional().describe("File containing the symbol reference (for LSP precision)"),
      line: zNum().describe("0-based line number of the reference"),
      character: zNum().describe("0-based column of the reference"),
    })),
    handler: async (args) => {
      const result = await goToDefinition(
        args.repo as string,
        args.symbol_name as string,
        args.file_path as string | undefined,
        args.line as number | undefined,
        args.character as number | undefined,
      );
      if (!result) return null;
      const preview = result.preview ? `\n${result.preview}` : "";
      return `${result.file}:${result.line + 1} (via ${result.via})${preview}`;
    },
  } },
  { order: 1804, definition: {
    name: "get_type_info",
    category: "lsp",
    searchHint: "type information hover documentation return type parameters LSP",
    outputSchema: OutputSchemas.typeInfo,
    description: "Get type info via LSP hover (return type, params, docs). Hint if LSP unavailable.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to get type info for"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    })),
    handler: (args) => getTypeInfo(
      args.repo as string,
      args.symbol_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  } },
  { order: 1826, definition: {
    name: "rename_symbol",
    category: "lsp",
    searchHint: "rename symbol refactor LSP type-safe all files",
    outputSchema: OutputSchemas.renameResult,
    description: "Rename symbol across all files via LSP. Type-safe, updates imports/refs.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Current name of the symbol to rename"),
      new_name: z.string().describe("New name for the symbol"),
      file_path: z.string().optional().describe("File containing the symbol"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    })),
    handler: (args) => renameSymbol(
      args.repo as string,
      args.symbol_name as string,
      args.new_name as string,
      args.file_path as string | undefined,
      args.line as number | undefined,
      args.character as number | undefined,
    ),
  } },
  { order: 1850, definition: {
    name: "get_call_hierarchy",
    category: "lsp",
    searchHint: "call hierarchy incoming outgoing calls who calls what calls LSP callers callees",
    outputSchema: OutputSchemas.callHierarchy,
    description: "LSP call hierarchy: incoming + outgoing calls. Complements trace_call_chain.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Symbol name to get call hierarchy for"),
      file_path: z.string().optional().describe("File containing the symbol (for LSP precision)"),
      line: zNum().describe("0-based line number"),
      character: zNum().describe("0-based column"),
    })),
    handler: async (args) => {
      const result = await getCallHierarchy(
        args.repo as string,
        args.symbol_name as string,
        args.file_path as string | undefined,
        args.line as number | undefined,
        args.character as number | undefined,
      );

      if (result.via === "unavailable") {
        return { ...result };
      }

      // Compact text format
      const lines: string[] = [];
      lines.push(`${result.symbol.kind} ${result.symbol.name} (${result.symbol.file}:${result.symbol.line})`);

      if (result.incoming.length > 0) {
        lines.push(`\n--- incoming calls (${result.incoming.length}) ---`);
        for (const c of result.incoming) {
          lines.push(`  ${c.kind} ${c.name} (${c.file}:${c.line})`);
        }
      }

      if (result.outgoing.length > 0) {
        lines.push(`\n--- outgoing calls (${result.outgoing.length}) ---`);
        for (const c of result.outgoing) {
          lines.push(`  ${c.kind} ${c.name} (${c.file}:${c.line})`);
        }
      }

      if (result.incoming.length === 0 && result.outgoing.length === 0) {
        lines.push("\nNo incoming or outgoing calls found.");
      }

      return lines.join("\n");
    },
  } },
  { order: 1902, definition: {
    name: "detect_communities",
    cacheable: true,
    category: "architecture",
    searchHint: "community detection clusters modules Louvain import graph boundaries",
    description: "Louvain community detection on import graph. Discovers module boundaries.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Path substring to filter files (e.g. 'src/lib')"),
      resolution: zNum().describe("Louvain resolution: higher = more smaller communities, lower = fewer larger (default: 1.0)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (graph diagram)"),
    })),
    handler: async (args) => {
      const result = await detectCommunities(
        args.repo as string,
        args.focus as string | undefined,
        args.resolution as number | undefined,
        args.output_format as "json" | "mermaid" | undefined,
      );
      return formatCommunities(result as never);
    },
  } },
  { order: 1924, definition: {
    name: "find_circular_deps",
    cacheable: true,
    category: "architecture",
    searchHint: "circular dependency cycle import loop detection",
    description: "Detect circular dependencies in the import graph via DFS. Returns file-level cycles.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      max_cycles: zNum().describe("Maximum cycles to report (default: 50)"),
    })),
    handler: async (args) => {
      const { findCircularDeps } = await import("../tools/graph-tools.js");
      const opts: Parameters<typeof findCircularDeps>[1] = {};
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.max_cycles != null) opts.max_cycles = args.max_cycles as number;
      const result = await findCircularDeps(args.repo as string, opts);
      if (result.cycles.length === 0) {
        return `No circular dependencies found (scanned ${result.total_files} files, ${result.total_edges} edges)`;
      }
      const lines = [`${result.cycles.length} circular dependencies found (${result.total_files} files, ${result.total_edges} edges):\n`];
      for (const c of result.cycles) {
        lines.push(`  ${c.cycle.join(" → ")}`);
      }
      return lines.join("\n");
    },
  } },
  { order: 1950, definition: {
    name: "check_boundaries",
    category: "architecture",
    searchHint: "boundary rules architecture enforcement imports CI gate hexagonal onion",
    description: "Check architecture boundary rules against imports. Path substring matching.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      rules: z.union([
        z.array(z.object({
          from: z.string().describe("Path substring matching source files (e.g. 'src/domain')"),
          cannot_import: z.array(z.string()).optional().describe("Path patterns that matched files must NOT import"),
          can_only_import: z.array(z.string()).optional().describe("Path patterns that matched files may ONLY import (allowlist)"),
        })),
        z.string().transform((s) => JSON.parse(s) as Array<{ from: string; cannot_import?: string[]; can_only_import?: string[] }>),
      ]).describe("Array of boundary rules to check. JSON string OK."),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    })),
    handler: async (args) => {
      const { checkBoundaries } = await import("../tools/boundary-tools.js");
      return checkBoundaries(
        args.repo as string,
        args.rules as Array<{ from: string; cannot_import?: string[]; can_only_import?: string[] }>,
        { file_pattern: args.file_pattern as string | undefined },
      );
    },
  } },
  { order: 1976, definition: {
    name: "classify_roles",
    category: "architecture",
    searchHint: "classify roles entry core utility dead leaf symbol architecture",
    description: "Classify symbol roles (entry/core/utility/dead/leaf) by call graph connectivity.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      top_n: zNum().describe("Maximum number of symbols to return (default: 100)"),
    })),
    handler: async (args) => {
      const { classifySymbolRoles } = await import("../tools/graph-tools.js");
      const result = await classifySymbolRoles(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        top_n: args.top_n as number | undefined,
      });
      return formatRoles(result as never);
    },
  } },
  // --- Context & knowledge ---
  { order: 1999, definition: {
    name: "assemble_context",
    category: "context",
    searchHint: "assemble context token budget L0 L1 L2 L3 source signatures summaries",
    description: "Assemble code context within token budget. L0=source, L1=signatures, L2=files, L3=dirs.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural language query describing what context is needed"),
      token_budget: zNum().describe("Maximum tokens for the assembled context"),
      level: z.enum(["L0", "L1", "L2", "L3"]).optional().describe("L0=source (default), L1=signatures, L2=files, L3=dirs"),
      rerank: zBool().describe("Rerank results using cross-encoder model for improved relevance (requires @huggingface/transformers)"),
    })),
    handler: async (args) => {
      const result = await assembleContext(
        args.repo as string,
        args.query as string,
        args.token_budget as number | undefined,
        args.level as "L0" | "L1" | "L2" | "L3" | undefined,
        args.rerank as boolean | undefined,
      );
      return formatAssembleContext(result as never);
    },
  } },
  { order: 2022, definition: {
    name: "get_knowledge_map",
    category: "context",
    searchHint: "knowledge map module dependency graph architecture overview mermaid",
    description: "Get the module dependency map showing how files and directories relate",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Focus on a specific module or directory"),
      depth: zNum().describe("Maximum depth of the dependency graph"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid' (dependency diagram)"),
    })),
    handler: async (args) => {
      const result = await getKnowledgeMap(args.repo as string, args.focus as string | undefined, args.depth as number | undefined, args.output_format as "json" | "mermaid" | undefined);
      return formatKnowledgeMap(result as never);
    },
  } },
  // --- Diff ---
  { order: 2040, definition: {
    name: "diff_outline",
    category: "diff",
    searchHint: "diff outline structural changes git refs compare",
    description: "Get a structural outline of what changed between two git refs",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
    })),
    handler: async (args) => {
      const result = await diffOutline(args.repo as string, args.since as string, args.until as string | undefined);
      return formatDiffOutline(result as never);
    },
  } },
  { order: 2055, definition: {
    name: "changed_symbols",
    category: "diff",
    searchHint: "changed symbols added modified removed git diff",
    description: "List symbols that were added, modified, or removed between two git refs",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to compare from"),
      until: z.string().optional().describe("Git ref to compare to (defaults to HEAD)"),
      include_diff: zBool().describe("Include unified diff per changed file (truncated to 500 chars)"),
    })),
    handler: async (args) => {
      const opts: { include_diff?: boolean } = {};
      if (args.include_diff === true) opts.include_diff = true;
      const result = await changedSymbols(args.repo as string, args.since as string, args.until as string | undefined, opts);
      return formatChangedSymbols(result as never);
    },
  } },
  // --- Generation ---
  { order: 2075, definition: {
    name: "generate_claude_md",
    category: "reporting",
    searchHint: "generate CLAUDE.md project summary documentation",
    description: "Generate a CLAUDE.md project summary file from the repository index",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      output_path: z.string().optional().describe("Custom output file path"),
    })),
    handler: (args) => generateClaudeMd(args.repo as string, args.output_path as string | undefined),
  } },
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
          z.string().transform((s) => JSON.parse(s) as Array<{ type: string } & Record<string, unknown>>),
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
