import { z, zBool, zNum, lazySchema, OutputSchemas, checkTextStubHint, type ToolDefinitionEntry } from "../shared.js";
import { getSymbol, getSymbols, findAndShow, getContextBundle, formatRefsCompact, formatSymbolCompact, formatSymbolsCompact, formatBundleCompact, findReferences, findReferencesBatch, traceCallChain, impactAnalysis, traceRoute, goToDefinition, getTypeInfo, renameSymbol, getCallHierarchy, dispatchFormatter, type Direction } from "../deps.js";

export const CORE_SYMBOL_TOOL_ENTRIES: ToolDefinitionEntry[] = [
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
        const { findSimilarSymbols } = await import("../../tools/symbol-tools.js");
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
          const { findSimilarSymbols } = await import("../../tools/symbol-tools.js");
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
    description: "Find all references to a symbol. Pass symbol_names array for batch search.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().optional().describe("Name of the symbol to find references for"),
      symbol_names: z.union([z.array(z.string()), z.string().transform((s) => JSON.parse(s) as string[])]).optional()
        .describe("Array of symbol names for batch search (reads each file once). Can be JSON string."),
      file_pattern: z.string().optional().describe("Glob pattern to filter files"),
    })),
    handler: async (args) => {
      const names = args.symbol_names as string[] | undefined;
      if (names && names.length > 0) {
        return findReferencesBatch(args.repo as string, names, args.file_pattern as string | undefined);
      }
      const refs = await findReferences(args.repo as string, args.symbol_name as string, args.file_pattern as string | undefined);
      const output = await formatRefsCompact(refs);
      const hint = await checkTextStubHint(args.repo as string, "find_references", refs.length === 0);
      return hint ? hint + output : output;
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
      const output = dispatchFormatter("trace_call_chain", result);
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
      return dispatchFormatter("impact_analysis", result);
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
      return dispatchFormatter("trace_route", result);
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
];
