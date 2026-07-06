import { z, zBool, zNum, lazySchema, type ToolDefinitionEntry } from "./shared.js";
import { getCodeIndex, traceComponentTree, analyzeHooks, analyzeRenders, buildContextGraph, auditCompilerReadiness, reactQuickstart } from "./deps.js";

export const REACT_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  { order: 1642, definition: {
    name: "trace_component_tree",
    category: "graph",
    searchHint: "react component tree composition render jsx parent child hierarchy",
    description: "Trace React component composition tree from a root component. Shows which components render which via JSX. React equivalent of trace_call_chain. output_format='mermaid' for diagram.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().describe("Root component name (must have kind 'component' in index)"),
      depth: zNum().describe("Maximum depth of composition tree (default: 3)"),
      include_source: zBool().describe("Include full source of each component (default: false)"),
      include_tests: zBool().describe("Include test files (default: false)"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format: 'json' (default) or 'mermaid'"),
    })),
    handler: async (args) => {
      const result = await traceComponentTree(args.repo as string, args.component_name as string, {
        depth: args.depth as number | undefined,
        include_source: args.include_source as boolean | undefined,
        include_tests: args.include_tests as boolean | undefined,
        output_format: args.output_format as "json" | "mermaid" | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  } },
  { order: 1666, definition: {
    name: "analyze_hooks",
    category: "analysis",
    searchHint: "react hooks analyze inventory rule of hooks violations usestate useeffect custom",
    description: "Analyze React hooks: inventory per component, Rule of Hooks violations (hook inside if/loop, hook after early return), custom hook composition, codebase-wide hook usage summary.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().optional().describe("Filter to single component/hook (default: all)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_entries: zNum().describe("Max entries to return (default: 100)"),
    })),
    handler: async (args) => {
      const result = await analyzeHooks(args.repo as string, {
        component_name: args.component_name as string | undefined,
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        max_entries: args.max_entries as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  } },
  { order: 1689, definition: {
    name: "analyze_renders",
    category: "analysis",
    searchHint: "react render performance inline props memo useCallback useMemo re-render risk optimization",
    description: "Static re-render risk analysis for React components. Detects inline object/array/function props in JSX (new reference every render), unstable default values (= [] or = {}), and components missing React.memo that render children. Returns per-component risk level (low/medium/high) with actionable suggestions.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      component_name: z.string().optional().describe("Filter to single component (default: all)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_entries: zNum().describe("Max entries to return (default: 100)"),
    })),
    handler: async (args) => {
      const result = await analyzeRenders(args.repo as string, {
        component_name: args.component_name as string | undefined,
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        max_entries: args.max_entries as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  } },
  { order: 1712, definition: {
    name: "analyze_context_graph",
    category: "analysis",
    searchHint: "react context createContext provider useContext consumer re-render propagation",
    description: "Map React context flows: createContext → Provider → useContext consumers. Shows which components consume each context and which provide values. Helps identify unnecessary re-renders from context value changes.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const index = await getCodeIndex(args.repo as string);
      if (!index) throw new Error(`Repository not found: ${args.repo}`);
      const result = await buildContextGraph(index.symbols);
      return JSON.stringify(result, null, 2);
    },
  } },
  { order: 1728, definition: {
    name: "audit_compiler_readiness",
    category: "analysis",
    searchHint: "react compiler forget memoization bailout readiness migration adoption auto-memo",
    description: "Audit React Compiler (v1.0) adoption readiness. Scans all components for patterns that cause silent bailout (side effects in render, ref reads, prop/state mutation, try/catch). Returns readiness score (0-100), prioritized fix list, and count of redundant manual memoization safe to remove post-adoption. No competitor offers codebase-wide compiler readiness analysis.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
    })),
    handler: async (args) => {
      const result = await auditCompilerReadiness(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  } },
  { order: 1747, definition: {
    name: "react_quickstart",
    category: "analysis",
    searchHint: "react onboarding day-1 overview stack inventory components hooks critical issues",
    description: "Day-1 onboarding composite for React projects. Single call returns: component/hook inventory, stack detection (state mgmt, routing, UI lib, form lib, build tool), critical pattern scan (XSS, Rule of Hooks, memory leaks), top hook usage, and suggested next queries. Replaces 5-6 manual tool calls. First tool to run on an unfamiliar React codebase.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await reactQuickstart(args.repo as string);
      return JSON.stringify(result, null, 2);
    },
  } },
];
