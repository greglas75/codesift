import { z, zBool, zNum, lazySchema, OutputSchemas, enableToolByName, type ToolDefinitionEntry } from "./shared.js";
import { indexConversations, searchConversations, searchAllConversations, findConversationsForSymbol, consolidateMemories, readMemory, usageHotspots, usageTraceSession, retrosList, retrosAnalyze, memoryCandidateExtract, optimizationCandidates, popeInsightsPushCandidates, createAnalysisPlan, writeScratchpad, readScratchpad, listScratchpad, updateStepStatus, getPlan, listPlans, analyzeProject, getExtractorVersions, indexStatus, auditAgentConfig, planTurn, formatPlanTurnResult, generateWiki, getUsageStats, formatUsageReport, formatSnapshot, getContext, getSessionState, dispatchFormatter } from "./deps.js";

export const META_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  { order: 2345, definition: {
    name: "generate_wiki",
    category: "reporting",
    searchHint: "generate wiki markdown community hub architecture documentation",
    description: "Generate wiki pages and optional Lens HTML dashboard from code topology (communities, hubs, surprises, hotspots).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Scope to directory (e.g., 'src/tools')"),
      output_dir: z.string().optional().describe("Output directory (default: {repo_root}/.codesift/wiki)"),
      journal_mode: z.enum(["skip", "refresh-overview", "append", "full"]).optional().default("skip").describe("Journal integration mode (default: skip)"),
      journal_since_ref: z.string().optional().describe("git-relative ref for journal_mode=append (e.g., '2 weeks ago' or ISO date)"),
      journal_bulk_fill: z.boolean().optional().describe("Bulk-fill all phases when journal_mode=full"),
    })),
    handler: async (args) => {
      const opts: { focus?: string; output_dir?: string; journal_mode?: "skip" | "refresh-overview" | "append" | "full"; journal_since_ref?: string; journal_bulk_fill?: boolean } = {};
      if (args.focus !== undefined) opts.focus = args.focus as string;
      if (args.output_dir !== undefined) opts.output_dir = args.output_dir as string;
      if (args.journal_mode !== undefined) opts.journal_mode = args.journal_mode as "skip" | "refresh-overview" | "append" | "full";
      if (args.journal_since_ref !== undefined) opts.journal_since_ref = args.journal_since_ref as string;
      if (args.journal_bulk_fill !== undefined) opts.journal_bulk_fill = args.journal_bulk_fill as boolean;
      const result = await generateWiki(args.repo as string, opts);
      return JSON.stringify(result, null, 2);
    },
  } },
  { order: 2370, definition: {
    name: "journal_append",
    category: "reporting",
    searchHint: "journal append phases git commits since wiki journal",
    description: "Append new journal phases for commits since the given git ref. Dispatches to runJournalAppend.",
    schema: lazySchema(() => ({
      since: z.string().describe("git-relative string like '2 weeks ago' or ISO date"),
      max_cost_usd: z.number().optional().default(2.0).describe("Maximum LLM cost cap in USD (default: 2.0)"),
      dry_run: z.boolean().optional().default(false).describe("Plan phases without writing files (default: false)"),
    })),
    handler: async (args) => {
      const { runJournalAppend } = await import("../tools/journal-generator.js");
      const opts: import("../tools/journal-generator.js").JournalRunOptions = {
        cwd: process.cwd(),
        outputDir: ".codesift/wiki",
        since: args.since as string,
      };
      if (args.dry_run !== undefined) opts.dryRun = args.dry_run as boolean;
      const r = await runJournalAppend(opts);
      return JSON.stringify(r, null, 2);
    },
  } },
  // --- Conversations ---
  { order: 2394, definition: {
    name: "index_conversations",
    category: "conversations",
    searchHint: "index conversations Claude Code history JSONL",
    description: "Index Claude Code conversation history for search. Scans JSONL files in ~/.claude/projects/ for the given project path.",
    schema: lazySchema(() => ({
      project_path: z.string().optional().describe("Path to the Claude project conversations directory. Auto-detects from cwd if omitted."),
      quiet: zBool().describe("Suppress output (used by session-end hook)"),
    })),
    handler: async (args) => indexConversations(args.project_path as string | undefined),
  } },
  { order: 2405, definition: {
    name: "search_conversations",
    category: "conversations",
    searchHint: "search conversations past sessions history BM25 semantic",
    description: "Search conversations in one project (BM25+semantic). For all projects: search_all_conversations.",
    schema: lazySchema(() => ({
      query: z.string().describe("Search query — keywords or natural language"),
      project: z.string().optional().describe("Project path to search (default: current project)"),
      limit: zNum().optional().describe("Maximum results to return (default: 10, max: 50)"),
    })),
    handler: async (args) => {
      const result = await searchConversations(args.query as string, args.project as string | undefined, args.limit as number | undefined);
      return dispatchFormatter("search_conversations", result);
    },
  } },
  { order: 2420, definition: {
    name: "find_conversations_for_symbol",
    category: "conversations",
    searchHint: "find conversations symbol discussion cross-reference code",
    description: "Find conversations that discussed a code symbol. Cross-refs code + history.",
    schema: lazySchema(() => ({
      symbol_name: z.string().describe("Name of the code symbol to search for in conversations"),
      repo: z.string().describe("Code repository to resolve the symbol from (e.g., 'local/my-project')"),
      limit: zNum().optional().describe("Maximum conversation results (default: 5)"),
    })),
    handler: async (args) => {
      const result = await findConversationsForSymbol(args.symbol_name as string, args.repo as string, args.limit as number | undefined);
      return dispatchFormatter("find_conversations_for_symbol", result);
    },
  } },
  { order: 2436, definition: {
    name: "search_all_conversations",
    category: "conversations",
    searchHint: "search all conversations every project cross-project",
    description: "Search ALL conversation projects at once, ranked by relevance.",
    schema: lazySchema(() => ({
      query: z.string().describe("Search query — keywords, natural language, or concept"),
      limit: zNum().optional().describe("Maximum results across all projects (default: 10)"),
    })),
    handler: async (args) => {
      const result = await searchAllConversations(args.query as string, args.limit as number | undefined);
      return dispatchFormatter("search_all_conversations", result);
    },
  } },
  // --- Memory consolidation ---
  { order: 3347, definition: {
    name: "consolidate_memories",
    category: "conversations",
    searchHint: "consolidate memories dream knowledge MEMORY.md decisions solutions patterns",
    description: "Consolidate conversations into MEMORY.md — decisions, solutions, patterns.",
    schema: lazySchema(() => ({
      project_path: z.string().optional().describe("Project path (auto-detects from cwd if omitted)"),
      output_path: z.string().optional().describe("Custom output file path (default: MEMORY.md in project root)"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level for extracted memories (default: low)"),
    })),
    handler: async (args) => {
      const opts: { output_path?: string; min_confidence?: "high" | "medium" | "low" } = {};
      if (typeof args.output_path === "string") opts.output_path = args.output_path;
      if (typeof args.min_confidence === "string") opts.min_confidence = args.min_confidence as "high" | "medium" | "low";
      const result = await consolidateMemories(args.project_path as string | undefined, opts);
      return result;
    },
  } },
  { order: 3365, definition: {
    name: "read_memory",
    category: "conversations",
    searchHint: "read memory MEMORY.md institutional knowledge past decisions",
    description: "Read MEMORY.md knowledge file with past decisions and patterns.",
    schema: lazySchema(() => ({
      project_path: z.string().optional().describe("Project path (default: current directory)"),
    })),
    handler: async (args) => {
      const result = await readMemory(args.project_path as string | undefined);
      if (!result) return { error: "No MEMORY.md found. Run consolidate_memories first." };
      return result.content;
    },
  } },
  // --- Coordinator ---
  { order: 3381, definition: {
    name: "create_analysis_plan",
    category: "meta",
    searchHint: "create plan multi-step analysis workflow coordinator scratchpad",
    description: "Create multi-step analysis plan with shared scratchpad and dependencies.",
    schema: lazySchema(() => ({
      title: z.string().describe("Plan title describing the analysis goal"),
      steps: z.union([
        z.array(z.object({
          description: z.string(),
          tool: z.string(),
          args: z.record(z.string(), z.unknown()),
          result_key: z.string().optional(),
          depends_on: z.array(z.string()).optional(),
        })),
        z.string().transform((s) => JSON.parse(s) as Array<{ description: string; tool: string; args: Record<string, unknown>; result_key?: string; depends_on?: string[] }>),
      ]).describe("Steps array: {description, tool, args, result_key?, depends_on?}. JSON string OK."),
    })),
    handler: async (args) => {
      const result = await createAnalysisPlan(
        args.title as string,
        args.steps as Array<{ description: string; tool: string; args: Record<string, unknown>; result_key?: string; depends_on?: string[] }>,
      );
      return result;
    },
  } },
  { order: 3407, definition: {
    name: "scratchpad_write",
    category: "meta",
    searchHint: "scratchpad write store knowledge cross-step data persist",
    description: "Write key-value to plan scratchpad for cross-step knowledge sharing.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
      key: z.string().describe("Key name for the entry"),
      value: z.string().describe("Value to store"),
    })),
    handler: async (args) => writeScratchpad(args.plan_id as string, args.key as string, args.value as string),
  } },
  { order: 3419, definition: {
    name: "scratchpad_read",
    category: "meta",
    searchHint: "scratchpad read retrieve knowledge entry",
    description: "Read a key from a plan's scratchpad. Returns the stored value or null if not found.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
      key: z.string().describe("Key name to read"),
    })),
    handler: async (args) => {
      const result = await readScratchpad(args.plan_id as string, args.key as string);
      return result ?? { error: "Key not found in scratchpad" };
    },
  } },
  { order: 3433, definition: {
    name: "scratchpad_list",
    category: "meta",
    searchHint: "scratchpad list entries keys",
    description: "List all entries in a plan's scratchpad with their sizes.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
    })),
    handler: (args) => listScratchpad(args.plan_id as string),
  } },
  { order: 3443, definition: {
    name: "update_step_status",
    category: "meta",
    searchHint: "update step status plan progress completed failed",
    description: "Update step status in plan. Auto-updates plan status on completion.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
      step_id: z.string().describe("Step identifier (e.g. step_1)"),
      status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).describe("New status for the step"),
      error: z.string().optional().describe("Error message if status is 'failed'"),
    })),
    handler: async (args) => {
      const result = await updateStepStatus(
        args.plan_id as string,
        args.step_id as string,
        args.status as "pending" | "in_progress" | "completed" | "failed" | "skipped",
        args.error as string | undefined,
      );
      return result;
    },
  } },
  { order: 3464, definition: {
    name: "get_analysis_plan",
    category: "meta",
    searchHint: "get plan status steps progress",
    description: "Get the current state of an analysis plan including all step statuses.",
    schema: lazySchema(() => ({
      plan_id: z.string().describe("Analysis plan identifier"),
    })),
    handler: async (args) => {
      const plan = getPlan(args.plan_id as string);
      return plan ?? { error: "Plan not found" };
    },
  } },
  { order: 3477, definition: {
    name: "list_analysis_plans",
    category: "meta",
    searchHint: "list plans active analysis workflows",
    description: "List all active analysis plans with their completion status.",
    schema: lazySchema(() => ({})),
    handler: async () => listPlans(),
  } },
  // --- Stats ---
  { order: 3525, definition: {
    name: "usage_stats",
    category: "meta",
    searchHint: "usage statistics tool calls tokens timing metrics",
    outputSchema: OutputSchemas.usageStats,
    description: "Show usage statistics for all CodeSift tool calls (call counts, tokens, timing, repos, hosts). Merges logs synced from other machines (~/.codesift/usage-remote/*.jsonl).",
    schema: lazySchema(() => ({
      since: z.string().optional().describe("ISO date/time lower bound, e.g. 2026-05-01"),
      repo: z.string().optional().describe("Exact CodeSift repo key"),
      tool: z.string().optional().describe("Exact tool name"),
      session_id: z.string().optional().describe("Exact CodeSift session id"),
      host: z.string().optional().describe("Exact host tag (machine hostname or usage-remote/<name>.jsonl stem)"),
    })),
    handler: async (args) => {
      const filters: { since?: string; repo?: string; tool?: string; session_id?: string; host?: string } = {};
      if (typeof args.since === "string") filters.since = args.since;
      if (typeof args.repo === "string") filters.repo = args.repo;
      if (typeof args.tool === "string") filters.tool = args.tool;
      if (typeof args.session_id === "string") filters.session_id = args.session_id;
      if (typeof args.host === "string") filters.host = args.host;
      const stats = await getUsageStats(filters);
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const pkgVersion: string = (req("../../package.json") as { version: string }).version;
      return { version: pkgVersion, filters: args, stats, report: formatUsageReport(stats) };
    },
  } },
  { order: 3552, definition: {
    name: "usage_hotspots",
    category: "meta",
    searchHint: "PopeInsights usage hotspots slow tools high tokens duplicate calls optimize CodeSift",
    description: "Analyze ~/.codesift/usage.jsonl for slow tools, token-heavy outputs, and repeated calls.",
    schema: lazySchema(() => ({
      since: z.string().optional().describe("ISO date/time lower bound, e.g. 2026-05-01"),
      repo: z.string().optional().describe("Exact CodeSift repo key"),
      tool: z.string().optional().describe("Exact tool name"),
      session_id: z.string().optional().describe("Exact CodeSift session id"),
      limit: zNum().describe("Optional row limit for returned repeated calls"),
    })),
    handler: async (args) => usageHotspots(args as Record<string, unknown>),
  } },
  { order: 3566, definition: {
    name: "usage_trace_session",
    category: "meta",
    searchHint: "PopeInsights trace usage session timeline tool calls elapsed tokens",
    description: "Show the timeline of CodeSift tool calls for one usage.jsonl session.",
    schema: lazySchema(() => ({
      session_id: z.string().describe("CodeSift session id"),
      limit: zNum().describe("Max calls to return"),
    })),
    handler: async (args) => {
      const input: { session_id: string; limit?: number } = { session_id: args.session_id as string };
      if (typeof args.limit === "number") input.limit = args.limit;
      return usageTraceSession(input);
    },
  } },
  { order: 3581, definition: {
    name: "retros_list",
    category: "meta",
    searchHint: "PopeInsights Zuvo retros list project skill friction retrospective",
    description: "List Zuvo retros from ~/.zuvo/retros.log and ~/.zuvo/retros.md with filters.",
    schema: lazySchema(() => ({
      project: z.string().optional().describe("Project key, e.g. codesift-mcp"),
      skill: z.string().optional().describe("Zuvo skill name"),
      friction_category: z.string().optional().describe("Friction category"),
      since: z.string().optional().describe("ISO date/time lower bound"),
      limit: zNum().describe("Max retros to return"),
      zuvo_dir: z.string().optional().describe("Override Zuvo dir. Default ~/.zuvo"),
    })),
    handler: async (args) => retrosList(args as Record<string, unknown>),
  } },
  { order: 3596, definition: {
    name: "retros_analyze",
    category: "meta",
    searchHint: "PopeInsights Zuvo retros analyze friction skill gaps missing templates routing failures",
    description: "Aggregate Zuvo retros into friction, project, and missing-template hotspots.",
    schema: lazySchema(() => ({
      project: z.string().optional().describe("Project key, e.g. codesift-mcp"),
      skill: z.string().optional().describe("Zuvo skill name"),
      friction_category: z.string().optional().describe("Friction category"),
      since: z.string().optional().describe("ISO date/time lower bound"),
      limit: zNum().describe("Max retros to analyze"),
      zuvo_dir: z.string().optional().describe("Override Zuvo dir. Default ~/.zuvo"),
    })),
    handler: async (args) => retrosAnalyze(args as Record<string, unknown>),
  } },
  { order: 3611, definition: {
    name: "memory_candidate_extract",
    category: "meta",
    searchHint: "PopeInsights memory candidates extract Zuvo proposals promote PopeMemory evidence",
    description: "Extract evidence-backed memory candidates from Zuvo retros proposals.",
    schema: lazySchema(() => ({
      project: z.string().optional().describe("Project key"),
      skill: z.string().optional().describe("Zuvo skill name"),
      since: z.string().optional().describe("ISO date/time lower bound"),
      limit: zNum().describe("Max candidates to return"),
      zuvo_dir: z.string().optional().describe("Override Zuvo dir. Default ~/.zuvo"),
    })),
    handler: async (args) => memoryCandidateExtract(args as Record<string, unknown>),
  } },
  { order: 3625, definition: {
    name: "optimization_candidates",
    category: "meta",
    searchHint: "PopeInsights optimization candidates usage retros CodeSift tools Zuvo skills",
    description: "Combine usage hotspots and Zuvo retros into ranked optimization candidates.",
    schema: lazySchema(() => ({
      since: z.string().optional().describe("ISO date/time lower bound"),
      repo: z.string().optional().describe("Exact CodeSift repo key for usage filtering"),
      project: z.string().optional().describe("Zuvo project key for retros filtering"),
      skill: z.string().optional().describe("Zuvo skill name"),
      zuvo_dir: z.string().optional().describe("Override Zuvo dir. Default ~/.zuvo"),
    })),
    handler: async (args) => optimizationCandidates(args as Record<string, unknown>),
  } },
  { order: 3639, definition: {
    name: "pope_insights_push_candidates",
    category: "meta",
    searchHint: "PopeInsights push candidates PopeBot API dry run",
    description: "Push generated optimization candidates to PopeBot /api/insights/ingest. Defaults to dry_run=true.",
    schema: lazySchema(() => ({
      server: z.string().optional().describe("PopeBot base URL or /api/insights URL"),
      api_key: z.string().optional().describe("PopeBot API key. Required only with dry_run=false"),
      dry_run: zBool().describe("Return payload without network write. Default true"),
      since: z.string().optional().describe("ISO date/time lower bound"),
      repo: z.string().optional().describe("Exact CodeSift repo key for usage filtering"),
      zuvo_dir: z.string().optional().describe("Override Zuvo dir. Default ~/.zuvo"),
    })),
    handler: async (args) => popeInsightsPushCandidates(args as Record<string, unknown>),
  } },
  { order: 3656, definition: {
    name: "get_session_snapshot",
    category: "session",
    searchHint: "session context snapshot compaction summary explored symbols files queries",
    description: "Get a compact ~200 token snapshot of what was explored in this session. Designed to survive context compaction. Call proactively before long tasks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Filter to specific repo. Default: most recent repo."),
    })),
    handler: async (args: { repo?: string }) => {
      return formatSnapshot(getSessionState(), args.repo);
    },
  } },
  { order: 3668, definition: {
    name: "get_session_context",
    category: "session",
    searchHint: "session context full explored symbols files queries negative evidence",
    description: "Get full session context: explored symbols, files, queries, and negative evidence (searched but not found). Use get_session_snapshot for a compact version.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Filter to specific repo"),
      include_stale: zBool().describe("Include stale negative evidence entries (default: false)"),
    })),
    handler: async (args: { repo?: string; include_stale?: boolean | string }) => {
      const includeStale = args.include_stale === true || args.include_stale === "true";
      return getContext(args.repo, includeStale);
    },
  } },
  // --- Project Analysis ---
  { order: 3684, definition: {
    name: "analyze_project",
    category: "analysis",
    searchHint: "project profile stack conventions middleware routes rate-limits auth detection",
    description: "Analyze a repository to extract stack, file classifications, and framework-specific conventions. Returns a structured project profile (schema v1.0) with file:line evidence for convention-level facts.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      force: zBool().describe("Ignore cached results and re-analyze"),
    })),
    handler: async (args) => {
      const result = await analyzeProject(args.repo as string, {
        force: args.force as boolean | undefined,
      });
      return result;
    },
  } },
  { order: 3700, definition: {
    name: "get_extractor_versions",
    category: "meta",
    searchHint: "extractor version cache invalidation profile parser languages",
    description: "Return parser_languages (tree-sitter symbol extractors) and profile_frameworks (analyze_project detectors). Text tools (search_text, get_file_tree) work on ALL files regardless — use this only for cache invalidation or to check symbol support for a specific language.",
    schema: lazySchema(() => ({})),
    handler: async () => getExtractorVersions(),
  } },
  // --- New tools (agent-requested) ---
  { order: 3732, definition: {
    name: "index_status",
    category: "meta",
    searchHint: "index status indexed repo check files symbols languages",
    description: "Check whether a repository is indexed and return index metadata: file count, symbol count, language breakdown, text_stub languages (no parser). Use this before calling symbol-based tools on unfamiliar repos.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const result = await indexStatus(args.repo as string);
      if (!result.indexed) {
        // Stale: index file exists but extractor_version drifted. Distinct
        // from "never indexed" — agents seeing "STALE" know that re-running
        // index_folder will fix it without wondering whether earlier indexing
        // attempts silently failed.
        if (result.stale) {
          return (
            `index_status: STALE — extractor_version_mismatch ` +
            `(${result.stale.language}: indexed at ${result.stale.actual_version}, ` +
            `current ${result.stale.expected_version}). ` +
            `Run index_folder to refresh.`
          );
        }
        // If no repo specified, list available repos so the agent can pick one
        if (!args.repo) {
          const { listAllRepos } = await import("../tools/index-tools.js");
          const repos = await listAllRepos();
          const localRepos = repos.filter((r) => (typeof r === "string" ? r : r.name).startsWith("local/")).map((r) => typeof r === "string" ? r : r.name);
          if (localRepos.length > 0) {
            return `index_status: repo not auto-detected (CWD mismatch). ${localRepos.length} repos available. Pass repo= explicitly. Available: ${localRepos.join(", ")}`;
          }
        }
        return "index_status: NOT INDEXED — run index_folder first";
      }
      const langs = Object.entries(result.language_breakdown ?? {})
        .sort(([, a], [, b]) => b - a)
        .map(([lang, count]) => `${lang}(${count})`)
        .join(", ");
      const parts = [
        `index_status: indexed=true`,
        `files: ${result.file_count} | symbols: ${result.symbol_count} | last_indexed: ${result.last_indexed}`,
        `languages: ${langs}`,
      ];
      if (result.text_stub_languages) {
        parts.push(`text_stub (no parser): ${result.text_stub_languages.join(", ")}`);
      }
      return parts.join("\n");
    },
  } },
  // --- Agent config audit ---
  { order: 3937, definition: {
    name: "audit_agent_config",
    category: "meta",
    searchHint: "audit agent config CLAUDE.md cursorrules stale symbols dead paths token waste redundancy",
    description: "Scan a config file (CLAUDE.md, .cursorrules) for stale symbol references, dead file paths, token cost, and redundancy. Cross-references against the CodeSift index. Optionally compares two config files for redundant content blocks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      config_path: z.string().optional().describe("Path to config file (default: CLAUDE.md in repo root)"),
      compare_with: z.string().optional().describe("Path to second config file for redundancy detection"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof auditAgentConfig>[1] = {};
      if (args.config_path != null) opts!.config_path = args.config_path as string;
      if (args.compare_with != null) opts!.compare_with = args.compare_with as string;
      const result = await auditAgentConfig(args.repo as string, opts);
      const parts = [`audit_agent_config: ${result.config_path}`, `token_cost: ~${result.token_cost} tokens`];
      if (result.stale_symbols.length > 0) {
        parts.push(`\n─── Stale Symbols (${result.stale_symbols.length}) ───`);
        for (const s of result.stale_symbols) parts.push(`  line ${s.line}: \`${s.symbol}\` — not found in index`);
      }
      if (result.dead_paths.length > 0) {
        parts.push(`\n─── Dead Paths (${result.dead_paths.length}) ───`);
        for (const p of result.dead_paths) parts.push(`  line ${p.line}: ${p.path} — file not in index`);
      }
      if (result.redundant_blocks.length > 0) {
        parts.push(`\n─── Redundant Blocks (${result.redundant_blocks.length}) ───`);
        for (const b of result.redundant_blocks) parts.push(`  "${b.text.slice(0, 60)}..." found in: ${b.found_in.join(", ")}`);
      }
      if (result.findings.length > 0) {
        parts.push(`\n─── Findings ───`);
        for (const f of result.findings) parts.push(`  ${f}`);
      }
      if (result.stale_symbols.length === 0 && result.dead_paths.length === 0 && result.redundant_blocks.length === 0) {
        parts.push("\nAll references valid. No issues found.");
      }
      return parts.join("\n");
    },
  } },
  // --- Discovery / concierge ---
  { order: 4968, definition: {
    name: "initial_instructions",
    category: "meta",
    searchHint: "initial instructions onboarding setup start session",
    description: "IMPORTANT: Call this tool IMMEDIATELY after the user gives you a task, BEFORE any other tool calls. Returns CodeSift's full instruction manual which critically informs how to use the 146 code intelligence tools. Skipping this tool causes the agent to miss CodeSift's pre-built BM25 + semantic index and waste tokens on Grep/Read instead.",
    schema: lazySchema(() => ({})),
    handler: async () => {
      const { CODESIFT_INSTRUCTIONS } = await import("../instructions.js");
      return CODESIFT_INSTRUCTIONS;
    },
  } },
  { order: 4979, definition: {
    name: "plan_turn",
    category: "discovery",
    searchHint: "plan turn routing recommend tools symbols files gap analysis session aware concierge",
    description: "Routes a natural-language query to the most relevant CodeSift tools, symbols, and files. Uses hybrid BM25+semantic ranking with session-aware dedup. Call at the start of a task to get a prioritized action list.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Natural-language description of what you want to do"),
      max_results: z.number().optional().describe("Max tools to return (default 10)"),
      skip_session: z.boolean().optional().describe("Skip session state checks (default false)"),
    })),
    handler: async (args) => {
      const { query, max_results, skip_session } = args as { query: string; max_results?: number; skip_session?: boolean };
      const opts: { max_results?: number; skip_session?: boolean } = {};
      if (max_results !== undefined) opts.max_results = max_results;
      if (skip_session !== undefined) opts.skip_session = skip_session;
      const result = await planTurn(args.repo as string, query, opts);
      for (const name of result.reveal_required) {
        enableToolByName(name);
      }
      return formatPlanTurnResult(result);
    },
  } },
];
