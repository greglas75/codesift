import type { AstroConventions } from "./astro-config.js";

export interface ProjectProfile {
  version: string;
  generated_at: string;
  generated_by: {
    tool: string;
    tool_version: string;
    extractor_versions: Record<string, string>;
  };
  compatible_with: string;
  status: "complete" | "partial" | "failed";

  identity?: ProjectIdentity;
  stack?: StackInfo;
  file_classifications?: FileClassifications;
  conventions?: Conventions;
  dependency_graph?: DependencyGraph;
  test_conventions?: TestConventions;
  known_gotchas?: KnownGotchas;
  nest_conventions?: NestConventions;
  next_conventions?: NextConventions;
  express_conventions?: ExpressConventions;
  react_conventions?: ReactConventions;
  python_conventions?: PythonConventions;
  php_conventions?: PhpConventions;
  astro_conventions?: AstroConventions;
  dependency_health?: DependencyHealth;
  git_health?: GitHealth;
  generation_metadata: GenerationMetadata;
}

export interface ProjectIdentity {
  project_name: string;
  project_type: "monorepo" | "single";
  workspace_root: string;
  git_remote: string | null;
}

export interface DependencyGraph {
  entry_points: string[];
  hub_modules: { path: string; imported_by_count: number }[];
  leaf_modules: string[];
  orphan_files: string[];
}

export interface TestConventions {
  mock_style: string | null;
  setup_files: string[];
  mock_patterns: { name: string; import_from: string; usage: string }[];
  assertion_library: string;
  file_patterns: string[];
  common_mocks: string[];
}

export interface KnownGotchas {
  auto_detected: { gotcha: string; evidence: string[]; severity: "high" | "medium" | "low" }[];
}

export interface StackInfo {
  framework: string | null;
  framework_version: string | null;
  language: string;
  language_version: string | null;
  test_runner: string | null;
  package_manager: string | null;
  build_tool: string | null;  // vite, cra, webpack, parcel, esbuild, rspack, rsbuild, turbopack
  monorepo: {
    tool: string | null;
    workspaces: string[];
    /** Rich per-workspace data populated by `resolveWorkspaces()` when
     *  available; absent when only the regex fallback ran. */
    workspace_details?: import("../types.js").Workspace[];
  } | null;
  detected_from: string[];
}

export interface FileClassifications {
  critical: ClassifiedFile[];
  important: { count: number; by_type: Record<string, number>; top: ClassifiedFile[] };
  routine: { count: number; by_type: Record<string, number> };
}

export interface ClassifiedFile {
  path: string;
  code_type: string;
  reason?: string;
  dependents_count: number;
  has_tests: boolean;
}

export interface Conventions {
  middleware_chains: MiddlewareChain[];
  rate_limits: RateLimitEntry[];
  route_mounts: RouteMountEntry[];
  auth_patterns: AuthPatterns;
}

export interface MiddlewareChain {
  scope: string;
  file: string;
  chain: { name: string; line: number; order: number }[];
}

export interface RateLimitEntry {
  file: string;
  line: number;
  max: number;
  window: number;
  applied_to_path: string | null;
  method: string | null;
}

export interface RouteMountEntry {
  file: string;
  line: number;
  mount_path: string;
  imported_from: string | null;
  exported_as: string | null;
}

export interface AuthPatterns {
  auth_middleware: string | null;
  groups: Record<string, { requires_auth: boolean; middleware: string[] }>;
}

// NestJS-specific conventions
export interface NestConventions {
  modules: NestModuleEntry[];
  global_guards: NestProviderEntry[];
  global_filters: NestProviderEntry[];
  global_pipes: NestProviderEntry[];
  global_interceptors: NestProviderEntry[];
  controllers: string[];
  throttler: { ttl: number; limit: number } | null;
  /** G1: middleware.configure(consumer) chains */
  middleware_chains: MiddlewareChainEntry[];
}

export interface MiddlewareChainEntry {
  middleware: string;
  routes: Array<{ path: string; method?: string }>;
  file: string;
  line: number;
}

export interface NestModuleEntry {
  name: string;
  file: string;
  line: number;
  imported_from: string | null;
  is_global: boolean;
  /** G2: entity class names from TypeOrmModule.forFeature([...]) / MongooseModule.forFeature([...]) */
  entities?: string[];
  /** G2: top-level config keys from forRoot({ ... }) */
  dynamic_config_keys?: string[];
}

export interface NestProviderEntry {
  name: string;
  token: string; // APP_GUARD, APP_FILTER, etc.
  file: string;
  line: number;
  imported_from: string | null;
}

export interface DependencyHealth {
  total: number;
  prod: number;
  dev: number;
  key_versions: Record<string, string>; // framework, runtime, etc.
}

export interface GitHealth {
  total_commits: number;
  recent_commits_30d: number;
  last_commit_date: string | null;
  contributors: number;
}

export interface GenerationMetadata {
  files_analyzed: number;
  files_skipped: number;
  skip_reasons: Record<string, number>;
  duration_ms: number;
}

export interface NextConventions {
  pages: { path: string; type: "page" | "layout" | "loading" | "error" | "not-found" | "global-error" | "default" | "template" }[];
  middleware: { file: string; matchers: string[] } | null;
  api_routes: { path: string; methods: string[]; file: string }[];
  services_count: number;
  inngest_functions: string[];
  webhooks: string[];
  client_component_count: number;
  server_action_count: number;
  config: {
    app_router: boolean;
    src_dir: boolean;
    i18n: boolean;
  };
}

export interface ExpressConventions {
  middleware: { name: string; file: string; line: number }[];
  routers: { mount_path: string; file: string; line: number; imported_from: string | null }[];
  error_handlers: { file: string; line: number }[];
}

export interface ReactConventions {
  state_management: string | null; // redux, zustand, context, jotai, etc.
  routing: string | null; // react-router, tanstack-router, etc.
  ui_library: string | null; // mui, chakra, shadcn, etc.
  form_library: string | null; // react-hook-form, formik, final-form, or null
  /** File-path-based counts (coarse, matches /pages/, /components/, /hooks/ dirs) */
  component_count: { pages: number; components: number; hooks: number };
  /** Actual count from symbol kinds (requires Wave 1 extractor) */
  actual_component_count: number;
  /** Actual count from symbol kinds */
  actual_hook_count: number;
  /** Top hooks called across all components, sorted by usage */
  hook_usage: { name: string; count: number }[];
  /** Count of components wrapped in React.memo/forwardRef/lazy */
  component_patterns: { memo: number; forwardRef: number; lazy: number };
}

export interface PythonConventions {
  framework_type: "fastapi" | "django" | "flask" | null;
  routers: { path: string; file: string }[];
  middleware: string[];
  models_dir: string | null;
  test_framework: string | null;
}

export interface PhpConventions {
  controllers: { name: string; path: string }[];
  middleware: { name: string; path: string }[];
  models: { name: string; path: string }[];
  routes_files: string[];
  migrations_count: number;
}

export interface Yii2Conventions extends PhpConventions {
  framework_type: "yii2";
  modules: { name: string; path: string }[];
  widgets: { name: string; path: string }[];
  behaviors: { name: string; path: string }[];
  components: { name: string; path: string }[];
  assets: { name: string; path: string }[];
  config_files: string[];
}
