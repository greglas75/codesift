import { z, zBool, zFiniteNumber, lazySchema, type ToolDefinitionEntry } from "./shared.js";
import { getModelGraph, getTestFixtures, findFrameworkWiring, runRuff, parsePyproject, resolveConstantValue, effectiveDjangoViewSecurity, findPythonCallers, taintTrace, analyzeDjangoSettings, runMypy, runPyright, analyzePythonDeps, pythonAudit, traceFastAPIDepends, analyzeAsyncCorrectness, getPydanticModels } from "./deps.js";

export const PYTHON_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- Python tools (all discoverable via discover_tools(query="python")) ---
  { order: 2706, definition: {
    name: "get_model_graph",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python django sqlalchemy orm model relationship foreignkey manytomany entity graph mermaid",
    description: "Extract ORM model relationships (Django ForeignKey/M2M/O2O, SQLAlchemy relationship). JSON or mermaid erDiagram.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output as structured JSON or mermaid erDiagram"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof getModelGraph>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "json" | "mermaid";
      return await getModelGraph(args.repo as string, opts);
    },
  } },
  { order: 2724, definition: {
    name: "get_test_fixtures",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pytest fixture conftest scope autouse dependency graph session function",
    description: "Extract pytest fixture dependency graph: conftest hierarchy, scope, autouse, fixture-to-fixture deps.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof getTestFixtures>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      return await getTestFixtures(args.repo as string, opts);
    },
  } },
  { order: 2740, definition: {
    name: "find_framework_wiring",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python django signal receiver celery task middleware management command flask fastapi event wiring",
    description: "Discover implicit control flow: Django signals, Celery tasks/.delay() calls, middleware, management commands, Flask init_app, FastAPI events.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof findFrameworkWiring>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      return await findFrameworkWiring(args.repo as string, opts);
    },
  } },
  { order: 2756, definition: {
    name: "run_ruff",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python ruff lint check bugbear performance simplify security async unused argument",
    description: "Run ruff linter with symbol graph correlation. Configurable rule categories (B, PERF, SIM, UP, S, ASYNC, RET, ARG).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      categories: z.array(z.string()).optional().describe("Rule categories to enable (default: B,PERF,SIM,UP,S,ASYNC,RET,ARG)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      max_results: zFiniteNumber.optional().describe("Max findings to return (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof runRuff>[1] = {};
      if (args.categories != null) opts!.categories = args.categories as string[];
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await runRuff(args.repo as string, opts);
    },
  } },
  { order: 2776, definition: {
    name: "parse_pyproject",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pyproject toml dependencies version build system entry points scripts tools ruff pytest mypy",
    description: "Parse pyproject.toml: name, version, Python version, build system, dependencies, optional groups, entry points, configured tools.",
    schema: lazySchema(() => ({ repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)") })),
    handler: async (args) => { return await parsePyproject(args.repo as string); },
  } },
  { order: 2785, definition: {
    name: "resolve_constant_value",
    category: "analysis",
    searchHint: "python typescript nestjs resolve constant value literal alias import default parameter propagation",
    description: "Resolve Python or TypeScript constants and function default values through simple aliases and import chains. Returns literals or explicit unresolved reasons.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      symbol_name: z.string().describe("Constant, function, or method name to resolve"),
      file_pattern: z.string().optional().describe("Filter candidate symbols by file path substring"),
      language: z.enum(["python", "typescript"]).optional().describe("Force resolver language instead of auto-inference"),
      max_depth: zFiniteNumber.optional().describe("Maximum alias/import resolution depth (default: 8)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof resolveConstantValue>[2] & {
        language?: "python" | "typescript";
      } = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.language != null) opts!.language = args.language as "python" | "typescript";
      if (args.max_depth != null) opts!.max_depth = args.max_depth as number;
      return await resolveConstantValue(args.repo as string, args.symbol_name as string, opts);
    },
  } },
  { order: 2807, definition: {
    name: "effective_django_view_security",
    category: "security",
    requiresLanguage: "python",
    searchHint: "python django view auth csrf login_required middleware mixin route security posture",
    description: "Assess effective Django view security from decorators, mixins, settings middleware, and optional route resolution.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      path: z.string().optional().describe("Django route path to resolve first, e.g. /settings/"),
      symbol_name: z.string().optional().describe("View function/class/method name when you already know the symbol"),
      file_pattern: z.string().optional().describe("Filter candidate symbols by file path substring"),
      settings_file: z.string().optional().describe("Explicit Django settings file path (auto-detects if omitted)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof effectiveDjangoViewSecurity>[1] = {};
      if (args.path != null) opts.path = args.path as string;
      if (args.symbol_name != null) opts.symbol_name = args.symbol_name as string;
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.settings_file != null) opts.settings_file = args.settings_file as string;
      return await effectiveDjangoViewSecurity(args.repo as string, opts);
    },
  } },
  { order: 2829, definition: {
    name: "taint_trace",
    category: "security",
    requiresLanguage: "python",
    searchHint: "python django taint data flow source sink request get post redirect mark_safe cursor execute subprocess session trace",
    description: "Trace Python/Django user-controlled data from request sources to security sinks like redirect, mark_safe, cursor.execute, subprocess, requests/httpx, open, or session writes.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      framework: z.enum(["python-django"]).optional().describe("Currently only python-django is implemented"),
      file_pattern: z.string().optional().describe("Restrict analysis to matching Python files"),
      source_patterns: z.array(z.string()).optional().describe("Optional source pattern allowlist (defaults to request.* presets)"),
      sink_patterns: z.array(z.string()).optional().describe("Optional sink pattern allowlist (defaults to built-in security sinks)"),
      max_depth: zFiniteNumber.optional().describe("Maximum interprocedural helper depth (default: 4)"),
      max_traces: zFiniteNumber.optional().describe("Maximum traces to return before truncation (default: 50)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof taintTrace>[1] = {};
      if (args.framework != null) opts.framework = args.framework as "python-django";
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.source_patterns != null) opts.source_patterns = args.source_patterns as string[];
      if (args.sink_patterns != null) opts.sink_patterns = args.sink_patterns as string[];
      if (args.max_depth != null) opts.max_depth = args.max_depth as number;
      if (args.max_traces != null) opts.max_traces = args.max_traces as number;
      return await taintTrace(args.repo as string, opts);
    },
  } },
  { order: 2855, definition: {
    name: "find_python_callers",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python callers call site usage trace cross module import delay apply_async constructor",
    description: "Find all call sites of a Python symbol: direct calls, method calls, Celery .delay()/.apply_async(), constructor, references.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      target_name: z.string().describe("Name of the target function/class/method"),
      target_file: z.string().optional().describe("Disambiguate target by file path substring"),
      file_pattern: z.string().optional().describe("Restrict caller search scope"),
      max_results: zFiniteNumber.optional().describe("Max callers to return (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof findPythonCallers>[2] = {};
      if (args.target_file != null) opts!.target_file = args.target_file as string;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await findPythonCallers(args.repo as string, args.target_name as string, opts);
    },
  } },
  { order: 2876, definition: {
    name: "analyze_django_settings",
    category: "security",
    requiresLanguage: "python",
    searchHint: "python django settings security debug secret key allowed hosts csrf middleware cookie hsts cors",
    description: "Audit Django settings.py: 15 security/config checks (DEBUG, SECRET_KEY, CSRF, CORS, HSTS, cookies, sqlite, middleware).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      settings_file: z.string().optional().describe("Explicit settings file path (auto-detects if omitted)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzeDjangoSettings>[1] = {};
      if (args.settings_file != null) opts!.settings_file = args.settings_file as string;
      return await analyzeDjangoSettings(args.repo as string, opts);
    },
  } },
  { order: 2892, definition: {
    name: "run_mypy",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python mypy type check error strict return incompatible argument missing",
    description: "Run mypy type checker with symbol correlation. Parses error codes, maps to containing symbols.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      strict: zBool().describe("Enable mypy --strict mode"),
      max_results: zFiniteNumber.optional().describe("Max findings (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof runMypy>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.strict != null) opts!.strict = args.strict as boolean;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await runMypy(args.repo as string, opts);
    },
  } },
  { order: 2912, definition: {
    name: "run_pyright",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pyright type check reportMissingImports reportGeneralTypeIssues",
    description: "Run pyright type checker with symbol correlation. Parses JSON diagnostics, maps to containing symbols.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      strict: zBool().describe("Enable strict level"),
      max_results: zFiniteNumber.optional().describe("Max findings (default: 100)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof runPyright>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.strict != null) opts!.strict = args.strict as boolean;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await runPyright(args.repo as string, opts);
    },
  } },
  { order: 2932, definition: {
    name: "analyze_python_deps",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python dependency version outdated vulnerable CVE pypi osv requirements pyproject",
    description: "Python dependency analysis: parse pyproject.toml/requirements.txt, detect unpinned deps, optional PyPI freshness, optional OSV.dev CVE scan.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      check_pypi: zBool().describe("Check PyPI for latest versions (network, opt-in)"),
      check_vulns: zBool().describe("Check OSV.dev for CVEs (network, opt-in)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzePythonDeps>[1] = {};
      if (args.check_pypi != null) opts!.check_pypi = args.check_pypi as boolean;
      if (args.check_vulns != null) opts!.check_vulns = args.check_vulns as boolean;
      return await analyzePythonDeps(args.repo as string, opts);
    },
  } },
  { order: 2950, definition: {
    name: "trace_fastapi_depends",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python fastapi depends dependency injection security scopes oauth2 authentication auth endpoint",
    description: "Trace FastAPI Depends()/Security() dependency injection chains recursively from route handlers. Detects yield deps (resource cleanup), Security() with scopes, shared deps across endpoints, endpoints without auth.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      endpoint: z.string().optional().describe("Focus on a specific endpoint function name"),
      max_depth: zFiniteNumber.optional().describe("Max dependency tree depth (default: 5)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof traceFastAPIDepends>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.endpoint != null) opts!.endpoint = args.endpoint as string;
      if (args.max_depth != null) opts!.max_depth = args.max_depth as number;
      return await traceFastAPIDepends(args.repo as string, opts);
    },
  } },
  { order: 2970, definition: {
    name: "analyze_async_correctness",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python async await asyncio blocking sync requests sleep subprocess django sqlalchemy ORM coroutine fastapi",
    description: "Detect 8 asyncio pitfalls in async def: blocking requests/sleep/IO/subprocess, sync SQLAlchemy/Django ORM in async views, async without await, asyncio.create_task without ref storage.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      rules: z.array(z.string()).optional().describe("Subset of rules to run"),
      max_results: zFiniteNumber.optional().describe("Max findings (default: 200)"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof analyzeAsyncCorrectness>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.rules != null) opts!.rules = args.rules as string[];
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      return await analyzeAsyncCorrectness(args.repo as string, opts);
    },
  } },
  { order: 2990, definition: {
    name: "get_pydantic_models",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python pydantic basemodel fastapi schema request response contract validator field constraint type classdiagram",
    description: "Extract Pydantic models: fields with types, validators, Field() constraints, model_config, cross-model references (list[X], Optional[Y]), inheritance. JSON or mermaid classDiagram.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output as structured JSON or mermaid classDiagram"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof getPydanticModels>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "json" | "mermaid";
      return await getPydanticModels(args.repo as string, opts);
    },
  } },
  { order: 3008, definition: {
    name: "python_audit",
    category: "analysis",
    requiresLanguage: "python",
    searchHint: "python audit health score compound project review django security circular patterns celery dependencies dead code task shared_task delay apply_async chain group chord canvas retry orphan queue import cycle ImportError TYPE_CHECKING DFS",
    description: "Compound Python project health audit: circular imports + Django settings + anti-patterns (17) + framework wiring + Celery orphans + pytest fixtures + deps + dead code. Runs in parallel, returns unified health score (0-100) + severity counts + prioritized top_risks list.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter by file path substring"),
      checks: z.array(z.string()).optional().describe("Subset of checks: circular_imports, django_settings, anti_patterns, framework_wiring, celery, pytest_fixtures, dependencies, dead_code"),
    })),
    handler: async (args) => {
      const opts: Parameters<typeof pythonAudit>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.checks != null) opts!.checks = args.checks as string[];
      return await pythonAudit(args.repo as string, opts);
    },
  } },
];
