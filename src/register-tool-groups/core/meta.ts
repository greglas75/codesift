import { z, zBool, zNum, lazySchema, type ToolDefinitionEntry } from "../shared.js";
import { detectCommunities, assembleContext, getKnowledgeMap, diffOutline, changedSymbols, generateClaudeMd, dispatchFormatter } from "../deps.js";
import { zJsonArray } from "./schema.js";

export const CORE_META_TOOL_ENTRIES: ToolDefinitionEntry[] = [
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
      return dispatchFormatter("detect_communities", result);
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
      const { findCircularDeps } = await import("../../tools/graph-tools.js");
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
        zJsonArray(z.object({
          from: z.string().trim().min(1),
          cannot_import: z.array(z.string().trim().min(1)).optional(),
          can_only_import: z.array(z.string().trim().min(1)).optional(),
        })),
      ]).describe("Array of boundary rules to check. JSON string OK."),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    })),
    handler: async (args) => {
      const { checkBoundaries } = await import("../../tools/boundary-tools.js");
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
      const { classifySymbolRoles } = await import("../../tools/graph-tools.js");
      const result = await classifySymbolRoles(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        top_n: args.top_n as number | undefined,
      });
      return dispatchFormatter("classify_roles", result);
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
      return dispatchFormatter("assemble_context", result);
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
      return dispatchFormatter("get_knowledge_map", result);
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
      return dispatchFormatter("diff_outline", result);
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
      return dispatchFormatter("changed_symbols", result);
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
];
