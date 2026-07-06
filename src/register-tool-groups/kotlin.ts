import { z, lazySchema, type ToolDefinitionEntry } from "./shared.js";
import { findExtensionFunctions, analyzeSealedHierarchy, traceSuspendChain, analyzeKmpDeclarations, traceFlowChain, traceHiltGraph, traceComposeTree, analyzeComposeRecomposition, traceRoomSchema, extractKotlinSerializationContract } from "./deps.js";

export const KOTLIN_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Kotlin tools (discoverable via discover_tools(query="kotlin")) ---
  { order: 2554, definition: {
    name: "find_extension_functions",
    category: "analysis",
    requiresLanguage: "kotlin",
    searchHint: "kotlin extension function receiver type method discovery",
    description: "Find all Kotlin extension functions for a given receiver type. Scans indexed symbols for signatures matching 'ReceiverType.' prefix.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      receiver_type: z.string().describe("Receiver type name, e.g. 'String', 'List', 'User'"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      return await findExtensionFunctions(args.repo as string, args.receiver_type as string, opts);
    },
  } },
  { order: 2571, definition: {
    name: "analyze_sealed_hierarchy",
    category: "analysis",
    requiresLanguage: "kotlin",
    searchHint: "kotlin sealed class interface subtype when exhaustive branch missing hierarchy",
    description: "Analyze a Kotlin sealed class/interface: find all subtypes and check when() blocks for exhaustiveness (missing branches).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      sealed_class: z.string().describe("Name of the sealed class or interface to analyze"),
    })),
    handler: async (args) => {
      return await analyzeSealedHierarchy(args.repo as string, args.sealed_class as string);
    },
  } },
  { order: 2585, definition: {
    name: "trace_hilt_graph",
    category: "analysis",
    searchHint: "hilt dagger DI dependency injection viewmodel inject module provides binds android kotlin graph",
    description: "Trace a Hilt DI dependency tree rooted at a class annotated with @HiltViewModel / @AndroidEntryPoint / @HiltAndroidApp. Returns constructor dependencies with matching @Provides/@Binds providers and their module. Unresolved deps are flagged.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      class_name: z.string().describe("Name of the Hilt-annotated class (e.g. 'UserViewModel')"),
      depth: z.number().optional().describe("Max traversal depth (default: 1)"),
    })),
    handler: async (args) => {
      const opts: { depth?: number } = {};
      if (typeof args.depth === "number") opts.depth = args.depth;
      return await traceHiltGraph(args.repo as string, args.class_name as string, opts);
    },
  } },
  { order: 2601, definition: {
    name: "trace_suspend_chain",
    category: "analysis",
    searchHint: "kotlin coroutine suspend dispatcher withContext runBlocking Thread.sleep blocking chain trace anti-pattern",
    description: "Trace the call chain of a Kotlin suspend function, emitting dispatcher transitions (withContext(Dispatchers.X)) and warnings for coroutine anti-patterns: runBlocking inside suspend, Thread.sleep, non-cancellable while(true) loops. Lexical walk — follows callee names found in the source, filtered to suspend-only functions.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      function_name: z.string().describe("Name of the suspend function to trace"),
      depth: z.number().optional().describe("Max chain depth (default: 3)"),
    })),
    handler: async (args) => {
      const opts: { depth?: number } = {};
      if (typeof args.depth === "number") opts.depth = args.depth;
      return await traceSuspendChain(args.repo as string, args.function_name as string, opts);
    },
  } },
  { order: 2617, definition: {
    name: "analyze_kmp_declarations",
    category: "analysis",
    searchHint: "kotlin multiplatform kmp expect actual source set common main android ios jvm js missing orphan",
    description: "Validate Kotlin Multiplatform expect/actual declarations across source sets. For each `expect` in commonMain, check every platform source set (androidMain/iosMain/jvmMain/jsMain/etc. discovered from the repo layout) for a matching `actual`. Reports fully matched pairs, expects missing on a platform, and orphan actuals with no corresponding expect.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      return await analyzeKmpDeclarations(args.repo as string);
    },
  } },
  // --- Kotlin Wave 3 tools ---
  { order: 2631, definition: {
    name: "trace_compose_tree",
    category: "analysis",
    searchHint: "kotlin compose composable component tree hierarchy ui call graph jetpack preview",
    description: "Build a Jetpack Compose component hierarchy rooted at a @Composable function. Traces PascalCase calls matching indexed composables, excludes @Preview. Reports tree depth, leaf components, and total component count.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      root_name: z.string().describe("Name of the root @Composable function (e.g. 'HomeScreen')"),
      depth: z.number().optional().describe("Max tree depth (default: 10)"),
    })),
    handler: async (args) => {
      const opts: { depth?: number } = {};
      if (typeof args.depth === "number") opts.depth = args.depth;
      return await traceComposeTree(args.repo as string, args.root_name as string, opts);
    },
  } },
  { order: 2647, definition: {
    name: "analyze_compose_recomposition",
    category: "analysis",
    searchHint: "kotlin compose recomposition unstable remember mutableStateOf performance skip lambda collection",
    description: "Detect recomposition hazards in @Composable functions: mutableStateOf without remember (critical), unstable collection parameters (List/Map/Set), excessive function-type params. Scans all indexed composables, skipping @Preview.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      return await analyzeComposeRecomposition(args.repo as string, opts);
    },
  } },
  { order: 2662, definition: {
    name: "trace_room_schema",
    category: "analysis",
    searchHint: "kotlin room database entity dao query insert update delete schema sqlite persistence android",
    description: "Build a Room persistence schema graph: @Entity classes (with table names, primary keys), @Dao interfaces (with @Query SQL extraction), @Database declarations (with entity refs and version). Index-only.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      return await traceRoomSchema(args.repo as string);
    },
  } },
  { order: 2674, definition: {
    name: "extract_kotlin_serialization_contract",
    category: "analysis",
    searchHint: "kotlin serialization serializable json schema serialname field type api contract data class",
    description: "Derive JSON field schema from @Serializable data classes. Extracts field names, types, @SerialName remapping, nullable flags, and defaults.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      class_name: z.string().optional().describe("Filter to a single class by name"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string; class_name?: string } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.class_name === "string") opts.class_name = args.class_name;
      return await extractKotlinSerializationContract(args.repo as string, opts);
    },
  } },
  { order: 2691, definition: {
    name: "trace_flow_chain",
    category: "analysis",
    searchHint: "kotlin flow coroutine operator map filter collect stateIn shareIn catch chain pipeline reactive",
    description: "Analyze a Kotlin Flow<T> operator chain: detects 50+ operators, reports ordered list, warns about .collect without .catch and .stateIn without lifecycle scope.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Name of the function or property containing the Flow chain"),
    })),
    handler: async (args) => {
      return await traceFlowChain(args.repo as string, args.symbol_name as string);
    },
  } },
];
