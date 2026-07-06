import { z, zBool, zNum, lazySchema, OutputSchemas, checkTextStubHint, formatAuditScan, type ToolDefinitionEntry, type ToolCategory } from "./shared.js";
import { findDeadCode, analyzeComplexity, findClones, analyzeHotspots, crossRepoSearchSymbols, crossRepoFindReferences, searchPatterns, listPatterns, generateReport, scanSecrets, frequencyAnalysis, reviewDiff, auditScan, testImpactAnalysis, dependencyAudit, migrationLint, analyzePrismaSchema, findPerfHotspots, fanInFanOut, coChangeAnalysis, architectureSummary, nestAudit, explainQuery, formatSearchPatterns, formatDeadCode, formatComplexity, formatClones, formatHotspots, formatSecrets, formatReviewDiff, formatPerfHotspots, formatFanInFanOut, formatCoChange, formatArchitectureSummary, type AuditScanOptions, type SecretSeverity, type SymbolKind } from "./deps.js";

export const ANALYSIS_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Analysis ---
  { order: 2122, definition: {
    name: "find_dead_code",
    category: "analysis",
    searchHint: "dead code unused exports unreferenced symbols cleanup",
    outputSchema: OutputSchemas.deadCode,
    description: "Find dead code: exported symbols with zero external references.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files in scan (default: false)"),
    })),
    handler: async (args) => {
      const result = await findDeadCode(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      const output = formatDeadCode(result as never);
      const isEmpty = !result || ((result as { candidates: unknown[] }).candidates?.length ?? 0) === 0;
      const hint = await checkTextStubHint(args.repo as string, "find_dead_code", isEmpty);
      return hint ? hint + output : output;
    },
  } },
  { order: 2144, definition: {
    name: "find_unused_imports",
    category: "analysis",
    searchHint: "unused imports dead cleanup lint",
    description: "Find imported names never referenced in the file body. Complements find_dead_code.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files in scan (default: false)"),
    })),
    handler: async (args) => {
      const { findUnusedImports } = await import("../tools/symbol-tools.js");
      const opts: Parameters<typeof findUnusedImports>[1] = {};
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.include_tests != null) opts.include_tests = args.include_tests as boolean;
      const result = await findUnusedImports(args.repo as string, opts);
      if (result.unused.length === 0) {
        return `No unused imports found (scanned ${result.scanned_files} files)`;
      }
      const lines = [`${result.unused.length} unused imports (${result.scanned_files} files scanned)${result.truncated ? " [truncated]" : ""}:\n`];
      for (const u of result.unused) {
        lines.push(`  ${u.file}:${u.line} — "${u.imported_name}"`);
      }
      return lines.join("\n");
    },
  } },
  { order: 2170, definition: {
    name: "analyze_complexity",
    category: "analysis",
    searchHint: "complexity cyclomatic nesting refactoring functions",
    outputSchema: OutputSchemas.complexity,
    description: "Top N most complex functions by cyclomatic complexity, nesting, lines.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      top_n: zNum().describe("Return top N most complex functions (default: 30)"),
      min_complexity: zNum().describe("Minimum cyclomatic complexity to include (default: 1)"),
      include_tests: zBool().describe("Include test files (default: false)"),
    })),
    handler: async (args) => {
      const result = await analyzeComplexity(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        top_n: args.top_n as number | undefined,
        min_complexity: args.min_complexity as number | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      const output = formatComplexity(result as never);
      const isEmpty = !result || ((result as { functions: unknown[] }).functions?.length ?? 0) === 0;
      const hint = await checkTextStubHint(args.repo as string, "analyze_complexity", isEmpty);
      return hint ? hint + output : output;
    },
  } },
  { order: 2196, definition: {
    name: "find_clones",
    category: "analysis",
    searchHint: "code clones duplicates copy-paste detection similar functions",
    outputSchema: OutputSchemas.clones,
    description: "Find code clones: similar function pairs via hash bucketing + line-similarity.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      min_similarity: zNum().describe("Minimum similarity threshold 0-1 (default: 0.7)"),
      min_lines: zNum().describe("Minimum normalized lines to consider (default: 10)"),
      include_tests: zBool().describe("Include test files (default: false)"),
    })),
    handler: async (args) => {
      const result = await findClones(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        min_similarity: args.min_similarity as number | undefined,
        min_lines: args.min_lines as number | undefined,
        include_tests: args.include_tests as boolean | undefined,
      });
      return formatClones(result as never);
    },
  } },
  { order: 2219, definition: {
    name: "frequency_analysis",
    category: "analysis",
    searchHint: "frequency analysis common patterns AST shape clusters",
    description: "Group functions by normalized AST shape. Finds emergent patterns invisible to regex.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      top_n: zNum().optional().describe("Number of clusters to return (default: 30)"),
      min_nodes: zNum().optional().describe("Minimum AST nodes in a subtree to include (default: 5)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      kind: z.string().optional().describe("Filter by symbol kind, comma-separated (default: function,method)"),
      include_tests: zBool().describe("Include test files (default: false)"),
      token_budget: zNum().optional().describe("Max tokens for response"),
    })),
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
  } },
  { order: 2245, definition: {
    name: "analyze_hotspots",
    category: "analysis",
    searchHint: "hotspots git churn bug-prone change frequency complexity",
    description: "Git churn hotspots: change frequency × complexity. Higher score = more bug-prone.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since_days: zNum().describe("Look back N days (default: 90)"),
      top_n: zNum().describe("Return top N hotspots (default: 30)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
    })),
    handler: async (args) => {
      const result = await analyzeHotspots(args.repo as string, {
        since_days: args.since_days as number | undefined,
        top_n: args.top_n as number | undefined,
        file_pattern: args.file_pattern as string | undefined,
      });
      return formatHotspots(result as never);
    },
  } },
  // --- Cross-repo ---
  { order: 2267, definition: {
    name: "cross_repo_search",
    category: "cross-repo",
    searchHint: "cross-repo search symbols across all repositories monorepo microservice",
    description: "Search symbols across ALL indexed repositories. Useful for monorepos and microservice architectures.",
    schema: lazySchema(() => ({
      query: z.string().describe("Symbol search query"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern (e.g. 'local/tgm')"),
      kind: z.string().optional().describe("Filter by symbol kind"),
      top_k: zNum().describe("Max results per repo (default: 10)"),
      include_source: zBool().describe("Include source code"),
    })),
    handler: (args) => crossRepoSearchSymbols(args.query as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      kind: args.kind as SymbolKind | undefined,
      top_k: args.top_k as number | undefined,
      include_source: args.include_source as boolean | undefined,
    }),
  } },
  { order: 2286, definition: {
    name: "cross_repo_refs",
    category: "cross-repo",
    searchHint: "cross-repo references symbol across all repositories",
    description: "Find references to a symbol across ALL indexed repositories.",
    schema: lazySchema(() => ({
      symbol_name: z.string().describe("Symbol name to find references for"),
      repo_pattern: z.string().optional().describe("Filter repos by name pattern"),
      file_pattern: z.string().optional().describe("Filter files by glob pattern"),
    })),
    handler: (args) => crossRepoFindReferences(args.symbol_name as string, {
      repo_pattern: args.repo_pattern as string | undefined,
      file_pattern: args.file_pattern as string | undefined,
    }),
  } },
  // --- Patterns ---
  { order: 2303, definition: {
    name: "search_patterns",
    category: "patterns",
    searchHint: "search patterns anti-patterns CQ violations useEffect empty-catch console-log",
    description: "Search structural patterns/anti-patterns. Built-in or custom regex.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      pattern: z.string().describe("Built-in pattern name or custom regex"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max results (default: 50)"),
    })),
    handler: async (args) => {
      const result = await searchPatterns(args.repo as string, args.pattern as string, {
        file_pattern: args.file_pattern as string | undefined,
        include_tests: args.include_tests as boolean | undefined,
        max_results: args.max_results as number | undefined,
      });
      return formatSearchPatterns(result as never);
    },
  } },
  { order: 2324, definition: {
    name: "list_patterns",
    category: "patterns",
    searchHint: "list available built-in patterns anti-patterns",
    description: "List all available built-in structural code patterns for search_patterns.",
    schema: lazySchema(() => ({})),
    handler: async () => listPatterns(),
  } },
  // --- Report ---
  { order: 2334, definition: {
    name: "generate_report",
    category: "reporting",
    searchHint: "generate HTML report complexity dead code hotspots architecture browser",
    description: "Generate a standalone HTML report with complexity, dead code, hotspots, and architecture. Opens in any browser.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: (args) => generateReport(args.repo as string),
  } },
  // --- Monorepo Workspaces (Tasks 8-11 of monorepo workspace intelligence plan) ---
  { order: 2452, definition: {
    name: "list_workspaces",
    category: "analysis",
    searchHint: "monorepo workspace list packages turbo pnpm yarn npm",
    description: "List workspace packages for a JS/TS monorepo (Turbo / pnpm / yarn / npm / Nx). Returns shape-stable empty result on flat repos.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
    })),
    handler: async (args) => {
      const { listWorkspacesHandler } = await import("../tools/workspace-tools.js");
      return listWorkspacesHandler(args.repo ? { repo: args.repo as string } : {});
    },
  } },
  { order: 2465, definition: {
    name: "workspace_graph",
    category: "analysis",
    searchHint: "monorepo workspace dependency graph turbo nx mermaid dot",
    description: "Build the workspace-to-workspace dependency DAG of a monorepo. Output formats: json (default), mermaid, dot.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      format: z.enum(["json", "mermaid", "dot"]).optional().describe("Output format (default: json)"),
    })),
    handler: async (args) => {
      const { workspaceGraphHandler } = await import("../tools/workspace-tools.js");
      const opts: Parameters<typeof workspaceGraphHandler>[0] = {};
      if (args.repo) opts.repo = args.repo as string;
      if (args.format) opts.format = args.format as "json" | "mermaid" | "dot";
      return workspaceGraphHandler(opts);
    },
  } },
  { order: 2482, definition: {
    name: "affected_workspaces",
    category: "analysis",
    searchHint: "monorepo affected workspaces git diff impact transitive turbo nx",
    description: "Compute affected workspaces for a git diff. File changes -> containing workspace -> reverse-dep walk. Lockfile-only commits surface separately and never fan out.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().describe("Git ref to diff against (e.g. HEAD~1, main, <sha>)"),
      include_transitive: zBool().describe("Include transitive reverse-deps (default: true)"),
    })),
    handler: async (args) => {
      const { affectedWorkspacesHandler } = await import("../tools/workspace-tools.js");
      const opts: Parameters<typeof affectedWorkspacesHandler>[0] = {
        since: args.since as string,
      };
      if (args.repo) opts.repo = args.repo as string;
      if (args.include_transitive !== undefined) opts.include_transitive = args.include_transitive as boolean;
      return affectedWorkspacesHandler(opts);
    },
  } },
  { order: 2502, definition: {
    name: "workspace_boundaries",
    category: "analysis",
    searchHint: "monorepo boundary rules workspace import violations enforce",
    description: "Enforce workspace-level import boundaries. Walks ALL cross-workspace import edges (relative + bare/tsconfig-alias) and reports rule violations.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      rules: z
        .array(
          z.object({
            from_workspace: z.string().describe("Workspace name OR glob (e.g. 'apps/*')"),
            cannot_import_workspaces: z.array(z.string()).describe("Names, globs, or negation entries"),
          }),
        )
        .describe("Workspace boundary rules"),
    })),
    handler: async (args) => {
      const { workspaceBoundariesHandler } = await import("../tools/workspace-tools.js");
      const opts: Parameters<typeof workspaceBoundariesHandler>[0] = {
        rules: args.rules as Array<{ from_workspace: string; cannot_import_workspaces: string[] }>,
      };
      if (args.repo) opts.repo = args.repo as string;
      return workspaceBoundariesHandler(opts);
    },
  } },
  // --- Security ---
  { order: 2529, definition: {
    name: "scan_secrets",
    category: "security",
    searchHint: "scan secrets API keys tokens passwords credentials security",
    outputSchema: OutputSchemas.secrets,
    description: "Scan for hardcoded secrets (API keys, tokens, passwords). ~1,100 rules.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files"),
      min_confidence: z.enum(["high", "medium", "low"]).optional().describe("Minimum confidence level (default: medium)"),
      exclude_tests: zBool().describe("Exclude test file findings (default: true)"),
      severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Minimum severity level"),
    })),
    handler: async (args) => {
      const result = await scanSecrets(args.repo as string, {
        file_pattern: args.file_pattern as string | undefined,
        min_confidence: args.min_confidence as "high" | "medium" | "low" | undefined,
        exclude_tests: args.exclude_tests as boolean | undefined,
        severity: args.severity as SecretSeverity | undefined,
      });
      return formatSecrets(result as never);
    },
  } },
  // --- Review diff ---
  { order: 3487, definition: {
    name: "review_diff",
    category: "diff",
    searchHint: "review diff static analysis git changes secrets breaking-changes complexity dead-code blast-radius",
    description: "Run 9 parallel static analysis checks on a git diff: secrets, breaking changes, coupling gaps, complexity, dead-code, blast-radius, bug-patterns, test-gaps, hotspots. Returns a scored verdict (pass/warn/fail) with tiered findings.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().optional().describe("Base git ref (default: HEAD~1)"),
      until: z.string().optional().describe("Target ref. Default: HEAD. Special: WORKING, STAGED"),
      checks: z.string().optional().describe("Comma-separated check names (default: all)"),
      exclude_patterns: z.string().optional().describe("Comma-separated globs to exclude"),
      token_budget: zNum().describe("Max tokens (default: 15000)"),
      max_files: zNum().describe("Warn above N files (default: 50)"),
      check_timeout_ms: zNum().describe("Per-check timeout ms (default: 8000)"),
    })),
    handler: async (args) => {
      const checksArr = args.checks
        ? (args.checks as string).split(",").map((c) => c.trim()).filter(Boolean)
        : undefined;
      const excludeArr = args.exclude_patterns
        ? (args.exclude_patterns as string).split(",").map((p) => p.trim()).filter(Boolean)
        : undefined;
      const opts: import("../tools/review-diff-tools.js").ReviewDiffOptions = {
        repo: args.repo as string,
      };
      if (args.since != null) opts.since = args.since as string;
      if (args.until != null) opts.until = args.until as string;
      if (checksArr != null) opts.checks = checksArr.join(",");
      if (excludeArr != null) opts.exclude_patterns = excludeArr;
      if (args.token_budget != null) opts.token_budget = args.token_budget as number;
      if (args.max_files != null) opts.max_files = args.max_files as number;
      if (args.check_timeout_ms != null) opts.check_timeout_ms = args.check_timeout_ms as number;
      const result = await reviewDiff(args.repo as string, opts);
      return formatReviewDiff(result);
    },
  } },
  // --- Composite tools ---
  { order: 3709, definition: {
    name: "audit_scan",
    category: "analysis",
    searchHint: "audit scan code quality CQ gates dead code clones complexity patterns",
    description: "Run 5 analysis tools in parallel, return findings keyed by CQ gate. One call replaces sequential find_dead_code + search_patterns + find_clones + analyze_complexity + analyze_hotspots. Returns: CQ8 (empty catch), CQ11 (complexity), CQ13 (dead code), CQ14 (clones), CQ17 (perf anti-patterns).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      checks: z.string().optional().describe("Comma-separated CQ gates to check (default: all). E.g. 'CQ8,CQ11,CQ14'"),
    })),
    handler: async (args) => {
      const checks = args.checks ? (args.checks as string).split(",").map(s => s.trim()) : undefined;
      const opts: AuditScanOptions = {};
      if (args.file_pattern) opts.file_pattern = args.file_pattern as string;
      if (args.include_tests) opts.include_tests = args.include_tests as boolean;
      if (checks) opts.checks = checks;
      const result = await auditScan(args.repo as string, opts);
      return formatAuditScan(result);
    },
  } },
  { order: 3781, definition: {
    name: "find_perf_hotspots",
    category: "analysis",
    searchHint: "performance perf hotspot N+1 unbounded query sync handler pagination findMany pLimit",
    description: "Scan for 6 performance anti-patterns: unbounded DB queries, sync I/O in handlers, N+1 loops, unbounded Promise.all, missing pagination, expensive recompute. Returns findings grouped by severity (high/medium/low) with fix hints.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      patterns: z.string().optional().describe("Comma-separated pattern names to check (default: all). Options: unbounded-query, sync-in-handler, n-plus-one, unbounded-parallel, missing-pagination, expensive-recompute"),
      file_pattern: z.string().optional().describe("Filter to files matching this path substring"),
      include_tests: zBool().describe("Include test files (default: false)"),
      max_results: zNum().describe("Max findings to return (default: 50)"),
    })),
    handler: async (args) => {
      const patterns = args.patterns
        ? (args.patterns as string).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const opts: Parameters<typeof findPerfHotspots>[1] = {};
      if (patterns) opts!.patterns = patterns;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.include_tests != null) opts!.include_tests = args.include_tests as boolean;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      const result = await findPerfHotspots(args.repo as string, opts);
      return formatPerfHotspots(result);
    },
  } },
  { order: 3806, definition: {
    name: "fan_in_fan_out",
    category: "architecture",
    searchHint: "fan-in fan-out coupling dependencies imports hub afferent efferent instability threshold",
    description: "Analyze import graph to find most-imported files (fan-in), most-dependent files (fan-out), and hub files (high both — instability risk). Returns coupling score 0-100. Use min_fan_in/min_fan_out for threshold-based audits ('all files with fan_in > 50') instead of top_n cap.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Focus on files in this directory"),
      top_n: zNum().describe("How many entries per list (default: 20)"),
      min_fan_in: zNum().describe("Only return files with fan_in >= this value (default: 0). Use for audits."),
      min_fan_out: zNum().describe("Only return files with fan_out >= this value (default: 0). Use for audits."),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof fanInFanOut>[1] = {};
      if (args.path != null) opts!.path = args.path as string;
      if (args.top_n != null) opts!.top_n = args.top_n as number;
      if (args.min_fan_in != null) opts!.min_fan_in = args.min_fan_in as number;
      if (args.min_fan_out != null) opts!.min_fan_out = args.min_fan_out as number;
      const result = await fanInFanOut(args.repo as string, opts);
      return formatFanInFanOut(result);
    },
  } },
  { order: 3828, definition: {
    name: "co_change_analysis",
    category: "architecture",
    searchHint: "co-change temporal coupling git history Jaccard co-commit correlation cluster",
    description: "Analyze git history to find files that frequently change together (temporal coupling). Returns file pairs ranked by Jaccard similarity, plus clusters of always-co-changed files. Useful for detecting hidden dependencies.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since_days: zNum().describe("Analyze last N days of history (default: 180)"),
      min_support: zNum().describe("Minimum co-commits to include a pair (default: 3)"),
      min_jaccard: zNum().describe("Minimum Jaccard similarity threshold (default: 0.3)"),
      path: z.string().optional().describe("Focus on files in this directory"),
      top_n: zNum().describe("Max pairs to return (default: 30)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof coChangeAnalysis>[1] = {};
      if (args.since_days != null) opts!.since_days = args.since_days as number;
      if (args.min_support != null) opts!.min_support = args.min_support as number;
      if (args.min_jaccard != null) opts!.min_jaccard = args.min_jaccard as number;
      if (args.path != null) opts!.path = args.path as string;
      if (args.top_n != null) opts!.top_n = args.top_n as number;
      const result = await coChangeAnalysis(args.repo as string, opts);
      return formatCoChange(result);
    },
  } },
  { order: 3852, definition: {
    name: "architecture_summary",
    category: "architecture",
    searchHint: "architecture summary overview structure stack framework communities coupling circular dependencies entry points",
    description: "One-call architecture profile: stack detection, module communities, coupling hotspots, circular dependencies, LOC distribution, and entry points. Runs 5 analyses in parallel. Supports Mermaid diagram output.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      focus: z.string().optional().describe("Focus on this directory path"),
      output_format: z.enum(["text", "mermaid"]).optional().describe("Output format (default: text)"),
      token_budget: zNum().describe("Max tokens for output"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof architectureSummary>[1] = {};
      if (args.focus != null) opts!.focus = args.focus as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "text" | "mermaid";
      if (args.token_budget != null) opts!.token_budget = args.token_budget as number;
      const result = await architectureSummary(args.repo as string, opts);
      return formatArchitectureSummary(result);
    },
  } },
  { order: 3872, definition: {
    name: "explain_query",
    category: "analysis",
    searchHint: "explain query SQL Prisma ORM database performance EXPLAIN ANALYZE findMany pagination index",
    description: "Parse a Prisma call and generate approximate SQL with EXPLAIN ANALYZE. Detects: unbounded queries, N+1 risks from includes, missing indexes. MVP: Prisma only. Supports postgresql/mysql/sqlite dialects.",
    schema: lazySchema(() => ({
      code: z.string().describe("Prisma code snippet (e.g. prisma.user.findMany({...}))"),
      dialect: z.enum(["postgresql", "mysql", "sqlite"]).optional().describe("SQL dialect (default: postgresql)"),
    })),
    handler: async (args) => {
      const eqOpts: Parameters<typeof explainQuery>[1] = {};
      if (args.dialect != null) eqOpts!.dialect = args.dialect as "postgresql" | "mysql" | "sqlite";
      const result = explainQuery(args.code as string, eqOpts);
      const parts = [
        `explain_query: prisma.${result.parsed.model}.${result.parsed.method}`,
        `─── Generated SQL (${args.dialect ?? "postgresql"}) ───`,
        `  ${result.sql}`,
        `─── EXPLAIN command ───`,
        `  ${result.explain_command}`,
      ];
      if (result.warnings.length > 0) {
        parts.push("─── Warnings ───");
        for (const w of result.warnings) parts.push(`  ⚠ ${w}`);
      }
      if (result.optimization_hints.length > 0) {
        parts.push("─── Optimization hints ───");
        for (const h of result.optimization_hints) parts.push(`  → ${h}`);
      }
      return parts.join("\n");
    },
  } },
  // --- NestJS analysis tools (sub-tools absorbed into nest_audit) ---
  { order: 3904, definition: {
    name: "nest_audit",
    category: "nestjs",
    searchHint: "nestjs audit analysis comprehensive module di guard route lifecycle pattern graphql websocket schedule typeorm microservice hook onModuleInit onApplicationBootstrap shutdown dependency graph circular import boundary injection provider constructor inject cycle interceptor pipe filter middleware chain security endpoint api map inventory list all params resolver query mutation subscription apollo gateway subscribemessage socketio realtime event cron interval timeout scheduled job task onevent listener entity relation onetomany manytoone database schema messagepattern eventpattern kafka rabbitmq nats transport request pipeline handler execution flow visualization bull bullmq queue processor process background worker scope transient singleton performance escalation swagger openapi documentation apiproperty apioperation apiresponse contract extract workspace monorepo",
    description: "One-call NestJS architecture audit: modules, DI, guards, routes, lifecycle, patterns, GraphQL, WebSocket, schedule, TypeORM, microservices. Pass workspace=<name|path> in monorepos to scope to a single workspace.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace: z.string().optional().describe("Monorepo workspace name or path. Scopes the audit to that workspace's files."),
      checks: z.string().optional().describe("Comma-separated checks (default: all). Options: modules,routes,di,guards,lifecycle,patterns,graphql,websocket,schedule,typeorm,microservice"),
    })),
    handler: async (args: { repo?: string; workspace?: string; checks?: string }) => {
      const { resolveWorkspaceScope } = await import("../tools/workspace-scope-helper.js");
      const checks = args.checks?.split(",").map((s) => s.trim()).filter(Boolean);
      const scope = await resolveWorkspaceScope(args.repo ?? "", args.workspace, "nestjs");
      if ("error" in scope) {
        return { error: scope.error, input: scope.input, available: scope.available };
      }
      const opts: Parameters<typeof nestAudit>[1] = {};
      if (checks) opts.checks = checks;
      if (scope.rootPaths.length > 0) {
        // Pass first matched workspace path through the existing file_pattern-style hook
        (opts as Record<string, unknown>).file_pattern = `${scope.rootPaths[0]}/**`;
      }
      const result = await nestAudit(args.repo ?? "", opts);
      // Telemetry: nest_audit averaged 18.4K tok/call with 110K-tok peaks —
      // cap arrays to keep JSON valid instead of letting the cascade
      // hard-truncate mid-structure.
      const { capArraysToBudget } = await import("../formatters-shortening.js");
      return capArraysToBudget(result);
    },
  } },
  // --- Test impact analysis ---
  { order: 3977, definition: {
    name: "test_impact_analysis",
    category: "analysis",
    searchHint: "test impact analysis affected tests changed files CI confidence which tests to run",
    description: "Determine which tests to run based on changed files. Uses impact analysis, co-change correlation, and naming convention matching. Returns prioritized test list with confidence scores and a suggested test command.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      since: z.string().optional().describe("Git ref to compare from (default: HEAD~1)"),
      until: z.string().optional().describe("Git ref to compare to (default: HEAD)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof testImpactAnalysis>[1] = {};
      if (args.since != null) opts!.since = args.since as string;
      if (args.until != null) opts!.until = args.until as string;
      const result = await testImpactAnalysis(args.repo as string, opts);
      const parts = [`test_impact: ${result.affected_tests.length} tests affected | ${result.changed_files.length} files changed`];
      if (result.suggested_command) parts.push(`\nRun: ${result.suggested_command}`);
      if (result.affected_tests.length > 0) {
        parts.push("\n─── Affected Tests ───");
        for (const t of result.affected_tests) {
          parts.push(`  ${t.test_file} (confidence: ${t.confidence.toFixed(2)}) — ${t.reasons.join(", ")}`);
        }
      } else {
        parts.push("\nNo affected tests found.");
      }
      return parts.join("\n");
    },
  } },
  // --- Dependency audit (composite) ---
  { order: 4007, definition: {
    name: "dependency_audit",
    category: "analysis",
    searchHint: "dependency audit npm vulnerabilities CVE licenses outdated freshness lockfile drift supply chain",
    description: "Composite dependency health check: vulnerabilities (npm/pnpm/yarn audit), licenses (problematic copyleft detection), freshness (outdated count + major gaps), lockfile integrity (drift, duplicates). Runs 4 sub-checks in parallel. Replaces ~40 manual bash calls for D1-D5 audit dimensions.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      workspace_path: z.string().optional().describe("Workspace path (default: index root)"),
      skip_licenses: zBool().describe("Skip license check (faster, default: false)"),
      min_severity: z.enum(["low", "moderate", "high", "critical"]).optional().describe("Filter vulnerabilities by minimum severity"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof dependencyAudit>[1] = {};
      if (args.workspace_path != null) opts!.workspace_path = args.workspace_path as string;
      if (args.skip_licenses != null) opts!.skip_licenses = args.skip_licenses as boolean;
      if (args.min_severity != null) opts!.min_severity = args.min_severity as "low" | "moderate" | "high" | "critical";
      const result = await dependencyAudit(args.repo as string, opts);
      const parts = [
        `dependency_audit: ${result.workspace} (${result.package_manager}) — ${result.duration_ms}ms`,
        `\n─── Vulnerabilities (${result.vulnerabilities.total}) ───`,
        `  critical: ${result.vulnerabilities.by_severity.critical} | high: ${result.vulnerabilities.by_severity.high} | moderate: ${result.vulnerabilities.by_severity.moderate} | low: ${result.vulnerabilities.by_severity.low}`,
      ];
      for (const v of result.vulnerabilities.findings.slice(0, 10)) {
        parts.push(`  [${v.severity}] ${v.package}${v.fix_available ? " (fix available)" : ""}`);
      }
      parts.push(`\n─── Licenses (${result.licenses.total}) ───`);
      if (result.licenses.problematic.length > 0) {
        parts.push(`  ⚠ Problematic: ${result.licenses.problematic.length}`);
        for (const l of result.licenses.problematic.slice(0, 10)) parts.push(`    ${l.package}: ${l.license}`);
      }
      parts.push(`\n─── Freshness (${result.freshness.outdated_count} outdated) ───`);
      for (const o of result.freshness.major_gaps.slice(0, 10)) {
        parts.push(`  ${o.package}: ${o.current} → ${o.latest} (${o.major_gap} major)`);
      }
      parts.push(`\n─── Lockfile ───`);
      parts.push(`  present: ${result.lockfile.present} | issues: ${result.lockfile.issues.length}`);
      for (const i of result.lockfile.issues.slice(0, 5)) parts.push(`    ${i.type}: ${i.message}`);
      if (result.errors.length > 0) {
        parts.push(`\n─── Sub-check errors (${result.errors.length}) ───`);
        for (const e of result.errors) parts.push(`  ${e}`);
      }
      return parts.join("\n");
    },
  } },
  // --- Migration safety linter (squawk wrapper) ---
  { order: 4053, definition: {
    name: "migration_lint",
    category: "analysis",
    searchHint: "migration lint squawk SQL postgresql safety linter unsafe-migration not-null drop-column alter-column-type concurrently",
    description: "PostgreSQL migration safety linter via squawk wrapper. Detects 30+ anti-patterns: NOT NULL without default, DROP COLUMN, ALTER COLUMN TYPE, CREATE INDEX without CONCURRENTLY, etc. Requires squawk CLI installed (brew install squawk OR cargo install squawk-cli). Auto-discovers prisma/migrations, migrations/, db/migrate, drizzle/.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      migration_glob: z.string().optional().describe("Custom migration file glob pattern"),
      excluded_rules: z.union([z.array(z.string()), z.string().transform((s) => s.split(",").map((x) => x.trim()))]).optional().describe("Squawk rules to exclude (comma-sep or array)"),
      pg_version: z.string().optional().describe("PostgreSQL version for version-aware rules (e.g. '13')"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof migrationLint>[1] = {};
      if (args.migration_glob != null) opts!.migration_glob = args.migration_glob as string;
      if (args.excluded_rules != null) opts!.excluded_rules = args.excluded_rules as string[];
      if (args.pg_version != null) opts!.pg_version = args.pg_version as string;
      const result = await migrationLint(args.repo as string, opts);
      if (!result.squawk_installed) {
        return `migration_lint: squawk not installed.\n${result.install_hint}\n${result.files_checked} migration files would be checked.`;
      }
      const parts = [
        `migration_lint: squawk ${result.squawk_version ?? "unknown"} — ${result.files_checked} files checked`,
        `errors: ${result.by_severity.error} | warnings: ${result.by_severity.warning}`,
      ];
      if (result.findings.length > 0) {
        parts.push("\n─── Findings ───");
        for (const f of result.findings.slice(0, 30)) {
          parts.push(`  [${f.level}] ${f.file}:${f.line} ${f.rule} — ${f.message}`);
        }
      } else {
        parts.push("\nNo issues found.");
      }
      return parts.join("\n");
    },
  } },
  // --- Prisma schema analyzer ---
  { order: 4090, definition: {
    name: "analyze_prisma_schema",
    category: "analysis",
    searchHint: "prisma schema analyze ast model field index foreign-key relation soft-delete enum coverage",
    description: "Parse schema.prisma into structured AST. Returns model coverage: fields, indexes, FKs, relations, soft-delete detection, FK index coverage %, unindexed FKs (audit warning), status-as-String suggestions. Uses @mrleebo/prisma-ast for proper AST parsing (vs regex-only extractor).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      schema_path: z.string().optional().describe("Path to schema.prisma (default: auto-detected)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzePrismaSchema>[1] = {};
      if (args.schema_path != null) opts!.schema_path = args.schema_path as string;
      const result = await analyzePrismaSchema(args.repo as string, opts);
      const parts = [
        `analyze_prisma_schema: ${result.schema_path}`,
        `models: ${result.model_count} | enums: ${result.enum_count}`,
        `\n─── FK Index Coverage ───`,
        `  ${result.totals.fk_with_index}/${result.totals.fk_columns} FKs indexed (${result.totals.fk_index_coverage_pct.toFixed(1)}%)`,
        `  unindexed FKs: ${result.totals.fk_without_index}`,
        `  soft-delete models: ${result.totals.soft_delete_models}`,
        `  composite indexes: ${result.totals.composite_indexes} | single indexes: ${result.totals.single_indexes}`,
      ];
      if (result.warnings.length > 0) {
        parts.push(`\n─── Warnings (${result.warnings.length}) ───`);
        for (const w of result.warnings.slice(0, 20)) parts.push(`  ⚠ ${w}`);
      }
      // List models with audit issues
      const auditModels = result.models.filter((m) => m.fk_columns_without_index.length > 0 || m.status_like_string_fields.length > 0);
      if (auditModels.length > 0) {
        parts.push(`\n─── Models with issues (${auditModels.length}) ───`);
        for (const m of auditModels.slice(0, 15)) {
          const issues: string[] = [];
          if (m.fk_columns_without_index.length > 0) issues.push(`unindexed FKs: ${m.fk_columns_without_index.join(",")}`);
          if (m.status_like_string_fields.length > 0) issues.push(`status-as-String: ${m.status_like_string_fields.join(",")}`);
          parts.push(`  ${m.name} — ${issues.join(" | ")}`);
        }
      }
      return parts.join("\n");
    },
  } },
  // --- Cross-repo contract groups (F1) ---
  { order: 4859, definition: {
    name: "repo_group",
    category: "architecture" as ToolCategory,
    searchHint: "repo group multi-repo cross-repo service group create list remove register contract",
    description: "Manage named groups of indexed repos for cross-service contract analysis. action='create' (name + repos[] required, optional description), 'list', or 'remove' (name required). Groups are stored in groups.json under the data dir.",
    schema: lazySchema(() => ({
      action: z.enum(["create", "list", "remove"]).describe("create | list | remove"),
      name: z.string().optional().describe("Group name (required for create/remove)"),
      repos: z.array(z.string()).optional().describe("Repo identifiers in the group (required for create)"),
      description: z.string().optional().describe("Optional human description (create only)"),
    })),
    handler: async (args) => {
      const { loadConfig } = await import("../config.js");
      const reg = await import("../storage/group-registry.js");
      const registryPath = reg.getGroupRegistryPath(loadConfig().dataDir);
      const action = args.action as string;
      if (action === "list") {
        return { groups: await reg.listGroups(registryPath) };
      }
      if (action === "create") {
        const name = args.name as string | undefined;
        const repos = args.repos as string[] | undefined;
        if (!name || !repos) return { error: "create requires name and repos[]" };
        const input: { name: string; repos: string[]; description?: string } = { name, repos };
        if (typeof args.description === "string") input.description = args.description;
        // registerGroup returns void — read the persisted group back so the
        // caller gets a non-empty confirmation (name/repos) instead of `{}`.
        // Fail loud if the read-back misses (corruption / concurrent delete)
        // rather than returning an empty group a caller would retry on.
        await reg.registerGroup(registryPath, input);
        const created = await reg.getGroup(registryPath, name);
        if (!created) return { error: "group persisted but read-back failed" };
        return { group: created };
      }
      // remove
      const name = args.name as string | undefined;
      if (!name) return { error: "remove requires name" };
      return { removed: await reg.removeGroup(registryPath, name) };
    },
  } },
  { order: 4899, definition: {
    name: "match_group_contracts",
    category: "architecture" as ToolCategory,
    searchHint: "cross-repo contract match who calls endpoint producer consumer fetch axios downstream break group",
    description: "Match producer HTTP endpoints to cross-repo consumer calls (fetch/axios/got) across every indexed repo in a group. Returns ContractMatch[] (exact + partial), plus warnings for unindexed/failed repos. Answers 'who calls this endpoint' across services.",
    schema: lazySchema(() => ({
      group: z.string().describe("Repo group name (created via repo_group)"),
    })),
    handler: async (args) => {
      const { matchGroupContracts } = await import("../tools/cross-repo-contract-tools.js");
      return matchGroupContracts(args.group as string);
    },
  } },
  { order: 4912, definition: {
    name: "find_endpoint_consumers",
    category: "architecture" as ToolCategory,
    searchHint: "who calls endpoint consumers downstream impact contract change break group cross-repo",
    description: "Find every cross-repo consumer of a specific producer endpoint within a group — 'who calls GET /users/{id}'. Method is case-insensitive; path params in any style (:id, {id}, [id]) are normalised. Answers 'what breaks downstream if I change this contract'.",
    schema: lazySchema(() => ({
      group: z.string().describe("Repo group name"),
      method: z.string().describe("HTTP method (GET/POST/...) — case-insensitive"),
      path: z.string().describe("Producer path, any param style (e.g. /users/{id} or /users/:id)"),
    })),
    handler: async (args) => {
      const { findEndpointConsumers } = await import("../tools/cross-repo-contract-tools.js");
      return findEndpointConsumers(args.group as string, args.method as string, args.path as string);
    },
  } },
];
