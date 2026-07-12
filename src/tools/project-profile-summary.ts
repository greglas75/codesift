import type { AstroConventions } from "./astro-config.js";
import type {
  Conventions,
  DependencyHealth,
  ExpressConventions,
  GitHealth,
  NestConventions,
  NextConventions,
  PhpConventions,
  ProjectProfile,
  PythonConventions,
  ReactConventions,
} from "./project-profile-types.js";

export interface ProfileSummary {
  status: ProjectProfile["status"];
  profile_path: string;
  stack: {
    framework: string | null;
    language: string;
    test_runner: string | null;
    package_manager: string | null;
    monorepo: boolean;
  };
  file_counts: {
    critical: number;
    important: number;
    routine: number;
    total_analyzed: number;
  };
  conventions_summary: Record<string, unknown> | null;
  dependency_health: { total: number; prod: number; dev: number; key_count: number } | null;
  git_health: GitHealth | null;
  duration_ms: number;
}

type ProfileWithAnalysis = ProjectProfile & {
  conventions?: Conventions;
  nest_conventions?: NestConventions;
  next_conventions?: NextConventions;
  express_conventions?: ExpressConventions;
  react_conventions?: ReactConventions;
  python_conventions?: PythonConventions;
  php_conventions?: PhpConventions;
  astro_conventions?: AstroConventions;
  dependency_health?: DependencyHealth;
  git_health?: GitHealth | null;
};

export function buildConventionsSummary(profile: ProjectProfile): ProfileSummary["conventions_summary"] {
  const p = profile as ProfileWithAnalysis;
  if (p.conventions) return {
    middleware_chains: p.conventions.middleware_chains?.length ?? 0,
    rate_limits: p.conventions.rate_limits?.length ?? 0,
    route_mounts: p.conventions.route_mounts?.length ?? 0,
    auth_groups: Object.keys(p.conventions.auth_patterns?.groups ?? {}).length,
  };
  if (p.nest_conventions) return {
    type: "nestjs",
    modules: p.nest_conventions.modules?.length ?? 0,
    global_guards: p.nest_conventions.global_guards?.length ?? 0,
    global_filters: p.nest_conventions.global_filters?.length ?? 0,
    global_interceptors: p.nest_conventions.global_interceptors?.length ?? 0,
    controllers: p.nest_conventions.controllers?.length ?? 0,
    has_throttler: !!p.nest_conventions.throttler,
  };
  if (p.next_conventions) return {
    type: "nextjs",
    pages: p.next_conventions.pages?.length ?? 0,
    api_routes: p.next_conventions.api_routes?.length ?? 0,
    services: p.next_conventions.services_count,
    inngest_functions: p.next_conventions.inngest_functions?.length ?? 0,
    webhooks: p.next_conventions.webhooks?.length ?? 0,
    has_middleware: !!p.next_conventions.middleware,
    app_router: p.next_conventions.config?.app_router,
    i18n: p.next_conventions.config?.i18n,
  };
  if (p.express_conventions) return {
    type: "express",
    middleware: p.express_conventions.middleware?.length ?? 0,
    routers: p.express_conventions.routers?.length ?? 0,
    error_handlers: p.express_conventions.error_handlers?.length ?? 0,
  };
  if (p.react_conventions) return {
    type: "react",
    ...p.react_conventions.component_count,
    state_management: p.react_conventions.state_management,
    ui_library: p.react_conventions.ui_library,
  };
  if (p.python_conventions) return {
    type: "python",
    routers: p.python_conventions.routers?.length ?? 0,
    middleware: p.python_conventions.middleware?.length ?? 0,
    framework_type: p.python_conventions.framework_type,
  };
  if (p.php_conventions) return {
    type: "php",
    controllers: p.php_conventions.controllers?.length ?? 0,
    middleware: p.php_conventions.middleware?.length ?? 0,
    models: p.php_conventions.models?.length ?? 0,
    migrations: p.php_conventions.migrations_count,
  };
  if (p.astro_conventions) return {
    type: "astro",
    output_mode: p.astro_conventions.output_mode,
    adapter: p.astro_conventions.adapter,
    integrations: p.astro_conventions.integrations?.length ?? 0,
    has_i18n: !!p.astro_conventions.i18n,
    config_resolution: p.astro_conventions.config_resolution,
  };
  return null;
}

function buildSummaryStack(profile: ProjectProfile): ProfileSummary["stack"] {
  return {
    framework: profile.stack?.framework ?? null,
    language: profile.stack?.language ?? "unknown",
    test_runner: profile.stack?.test_runner ?? null,
    package_manager: profile.stack?.package_manager ?? null,
    monorepo: !!profile.stack?.monorepo,
  };
}

function buildSummaryFileCounts(profile: ProjectProfile): ProfileSummary["file_counts"] {
  return {
    critical: profile.file_classifications?.critical.length ?? 0,
    important: profile.file_classifications?.important.count ?? 0,
    routine: profile.file_classifications?.routine.count ?? 0,
    total_analyzed: profile.generation_metadata.files_analyzed,
  };
}

function buildDependencyHealthSummary(
  dependencyHealth: DependencyHealth | undefined,
): ProfileSummary["dependency_health"] {
  if (!dependencyHealth) return null;

  return {
    total: dependencyHealth.total,
    prod: dependencyHealth.prod,
    dev: dependencyHealth.dev,
    key_count: Object.keys(dependencyHealth.key_versions).length,
  };
}

export function buildSummary(profile: ProjectProfile, profilePath: string): ProfileSummary {
  const p = profile as ProfileWithAnalysis;
  return {
    status: profile.status,
    profile_path: profilePath,
    stack: buildSummaryStack(profile),
    file_counts: buildSummaryFileCounts(profile),
    conventions_summary: buildConventionsSummary(profile),
    dependency_health: buildDependencyHealthSummary(p.dependency_health),
    git_health: p.git_health ?? null,
    duration_ms: profile.generation_metadata.duration_ms,
  };
}
