import * as pathModule from "node:path";

// ---------------------------------------------------------------------------
// Framework-specific tool auto-loading
// ---------------------------------------------------------------------------

/**
 * Tool groups that should be auto-enabled when a matching project type is detected at CWD.
 * Keys are detection signals (files at CWD root), values are tool names to enable.
 */
const FRAMEWORK_TOOL_GROUPS: Record<string, string[]> = {
  // PHP / Yii2 / Laravel — detected by composer.json
  "composer.json": [
    "resolve_php_namespace",
    // analyze_activerecord, find_php_n_plus_one, find_php_god_model absorbed into php_project_audit
    "trace_php_event",
    "find_php_views",
    "resolve_php_service",
    "php_security_scan",
    "php_project_audit",
    "yii3_migration_audit",
    "php8_compat_check",
    "analyze_yii_modules",
    "analyze_yii_migrations",
    "analyze_yii_rbac",
    "find_php8_migration_candidates",
    "analyze_phpstan_baseline",
    "analyze_yii_console_commands",
    "find_yii3_attribute_candidates",
    // PHP stacks (Yii2/Laravel/Symfony) overwhelmingly run on MySQL/Postgres with
    // raw .sql migrations and ActiveRecord models. The SQL toolchain is the
    // missing entry-point for schema/drift/lint/dml work — auto-revealing it
    // here closes the gap that 0 SQL tools have ever been called from PHP repos.
    "analyze_schema",
    "trace_query",
    "sql_audit",
    "diff_migrations",
    "search_columns",
    "migration_lint",
  ],
  // Kotlin / Android / Gradle — detected by build.gradle.kts or settings.gradle.kts
  "build.gradle.kts": [
    "find_extension_functions",
    "analyze_sealed_hierarchy",
    "trace_hilt_graph",
    "trace_suspend_chain",
    "analyze_kmp_declarations",
    "trace_compose_tree",
    "analyze_compose_recomposition",
    "trace_room_schema",
    "extract_kotlin_serialization_contract",
    "trace_flow_chain",
  ],
  "settings.gradle.kts": [
    "find_extension_functions",
    "analyze_sealed_hierarchy",
    "trace_hilt_graph",
    "trace_suspend_chain",
    "analyze_kmp_declarations",
    "trace_compose_tree",
    "analyze_compose_recomposition",
    "trace_room_schema",
    "extract_kotlin_serialization_contract",
    "trace_flow_chain",
  ],
  // Fallback — Android projects with Groovy gradle but Kotlin source
  "build.gradle": [
    "find_extension_functions",
    "analyze_sealed_hierarchy",
    "trace_hilt_graph",
    "trace_suspend_chain",
    "analyze_kmp_declarations",
    "trace_compose_tree",
    "analyze_compose_recomposition",
    "trace_room_schema",
    "extract_kotlin_serialization_contract",
    "trace_flow_chain",
  ],
  // Python — detected by pyproject.toml (poetry/pdm/uv/hatch) or requirements.txt
  "pyproject.toml": [
    "get_model_graph",
    "get_test_fixtures",
    "find_framework_wiring",
    "run_ruff",
    "parse_pyproject",
    "find_python_callers",
    "analyze_django_settings",
    "run_mypy",
    "run_pyright",
    "analyze_python_deps",
    "trace_fastapi_depends",
    "analyze_async_correctness",
    "get_pydantic_models",
    "python_audit",
  ],
  "requirements.txt": [
    "get_model_graph",
    "get_test_fixtures",
    "find_framework_wiring",
    "run_ruff",
    "find_python_callers",
    "analyze_django_settings",
    "run_mypy",
    "run_pyright",
    "analyze_python_deps",
    "trace_fastapi_depends",
    "analyze_async_correctness",
    "get_pydantic_models",
    "python_audit",
  ],
  // TypeScript baseline — auto-enabled on any project with tsconfig.json.
  // Promotes 3 high-value but historically dark tools so that vanilla TS /
  // library / monorepo repos get a proper entry point beyond search_text.
  "tsconfig.json": [
    "dependency_audit",
    "check_boundaries",
    "architecture_summary",
  ],
  // Monorepo signals — orchestration-level analysis is most useful when
  // there are >1 packages. Each of these files alone is enough to fire.
  "pnpm-workspace.yaml": [
    "check_boundaries",
    "architecture_summary",
  ],
  "lerna.json": [
    "check_boundaries",
    "architecture_summary",
  ],
  "nx.json": [
    "check_boundaries",
    "architecture_summary",
  ],
  "turbo.json": [
    "check_boundaries",
    "architecture_summary",
  ],
  // Prisma — root-level schema. Nested prisma/schema.prisma handled in
  // detectAutoLoadTools after the loop. drizzle-kit dep handled in
  // detectFromPackageJson.
  "schema.prisma": [
    "analyze_prisma_schema",
    "migration_lint",
  ],
  // Astro — detected by astro.config.{mjs,ts,cjs,js}. Auto-loads the full
  // 13-tool Astro toolkit (7 core + 6 Astro 5 sub-tools from Tasks 2-7).
  // astro_audit is the meta-tool entry point; sub-tools are listed for
  // direct invocation via describe_tools.
  "astro.config.mjs": [
    "astro_route_map",
    "astro_config_analyze",
    "astro_content_collections",
    "astro_actions_audit",
    "astro_migration_check",
    "astro_analyze_islands",
    "astro_audit",
    "astro_middleware",
    "astro_sessions",
    "astro_db_audit",
    "astro_env_validator",
    "astro_image_audit",
    "astro_svg_components",
  ],
  "astro.config.ts": [
    "astro_route_map",
    "astro_config_analyze",
    "astro_content_collections",
    "astro_actions_audit",
    "astro_migration_check",
    "astro_analyze_islands",
    "astro_audit",
    "astro_middleware",
    "astro_sessions",
    "astro_db_audit",
    "astro_env_validator",
    "astro_image_audit",
    "astro_svg_components",
  ],
  "astro.config.cjs": [
    "astro_route_map",
    "astro_config_analyze",
    "astro_content_collections",
    "astro_actions_audit",
    "astro_migration_check",
    "astro_analyze_islands",
    "astro_audit",
    "astro_middleware",
    "astro_sessions",
    "astro_db_audit",
    "astro_env_validator",
    "astro_image_audit",
    "astro_svg_components",
  ],
  "astro.config.js": [
    "astro_route_map",
    "astro_config_analyze",
    "astro_content_collections",
    "astro_actions_audit",
    "astro_migration_check",
    "astro_analyze_islands",
    "astro_audit",
    "astro_middleware",
    "astro_sessions",
    "astro_db_audit",
    "astro_env_validator",
    "astro_image_audit",
    "astro_svg_components",
  ],
};

/**
 * React-specific tools — auto-enabled when a React project is detected.
 * Detection requires BOTH a package.json with react dependency AND presence
 * of .tsx/.jsx files (prevents false positives on non-UI projects that happen
 * to have react as a transitive dep).
 */
const REACT_TOOLS = [
  "trace_component_tree",
  "analyze_hooks",
  "analyze_renders",
  "analyze_context_graph",
  "audit_compiler_readiness",
  "react_quickstart",
];

/**
 * Hono-specific tools — auto-enabled when a Hono project is detected.
 * Core tools (trace_middleware_chain, analyze_hono_app) are already in
 * CORE_TOOL_NAMES. This list covers the 5 hidden tools that agents need
 * to discover via describe_tools/discover_tools otherwise.
 *
 * Detection: package.json with "hono" OR "@hono/zod-openapi" dep.
 * Content-based (not filename), so lives outside FRAMEWORK_TOOL_GROUPS.
 */

const HONO_TOOLS = [
  "trace_context_flow",
  "extract_api_contract",
  "trace_rpc_types",
  "audit_hono_security",
  "visualize_hono_routes",
  // Phase 2 additions — closes blog-API demo gaps + GitHub issues #3587/#4121/#4270
  "analyze_inline_handler",
  "extract_response_types",
  "detect_hono_modules",
  "find_dead_hono_routes",
];

/**
 * Monorepo tools — auto-enabled when `pkg.workspaces` field is present
 * (mirror of the file-based monorepo signals in FRAMEWORK_TOOL_GROUPS).
 */
const MONOREPO_TOOLS = [
  "check_boundaries",
  "architecture_summary",
];

/**
 * Prisma tools — auto-enabled when `prisma` or `drizzle-kit` is in deps
 * (mirror of the schema.prisma file signal in FRAMEWORK_TOOL_GROUPS).
 */
const PRISMA_TOOLS = [
  "analyze_prisma_schema",
  "migration_lint",
];

/**
 * Raw-SQL toolchain — auto-enabled when a project has loose `*.sql` files
 * (migrations, seeds, mysqldump). Independent of any ORM. Targets the
 * "PHP/Yii2 + MySQL legacy" segment that historically called 0 of these
 * tools because they were hidden behind discover_tools.
 */
const SQL_TOOLS = [
  "analyze_schema",
  "trace_query",
  "sql_audit",
  "diff_migrations",
  "search_columns",
  "migration_lint",
];

const AUTO_LOAD_CACHE_TTL_MS = 5_000;
const autoLoadToolsCache = new Map<string, {
  expiresAt: number;
  value: Promise<string[]>;
}>();

function cloneAutoLoadTools(value: Promise<string[]>): Promise<string[]> {
  return value.then((tools) => [...tools]);
}

/**
 * Detect project type at CWD and return list of tools that should be auto-enabled.
 * Returns empty array if no framework-specific tools apply.
 * Exported for unit testing.
 */
export async function detectAutoLoadTools(cwd: string): Promise<string[]> {
  // Kill switch: spec D-FB. Skip workspace walk entirely when set.
  const killSwitchOff = process.env.CODESIFT_DISABLE_MONOREPO !== "1";
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const toEnable: string[] = [];
  for (const [signalFile, tools] of Object.entries(FRAMEWORK_TOOL_GROUPS)) {
    if (existsSync(join(cwd, signalFile))) {
      toEnable.push(...tools);
    }
  }

  // Nested Prisma schema — `prisma/schema.prisma` is the more common layout
  // than root-level. The root-level case is covered by FRAMEWORK_TOOL_GROUPS.
  if (existsSync(join(cwd, "prisma", "schema.prisma"))) {
    toEnable.push(...PRISMA_TOOLS);
  }

  // Raw SQL detection — fires on any project with loose `*.sql` files in
  // common schema/migration dirs. Catches mysqldump/pg_dump artifacts and
  // hand-written migrations across PHP/Python/Go/Java stacks regardless of
  // ORM. Composer-based PHP repos already pull SQL_TOOLS via FRAMEWORK_TOOL_GROUPS;
  // this branch covers everything else (e.g. Django + raw migrations,
  // standalone schema repos).
  if (hasSqlFilesShallow(cwd, readdirSync)) {
    toEnable.push(...SQL_TOOLS);
  }

  const detectFromPackageJson = (pkgRoot: string): string[] => {
    const enabled: string[] = [];
    const pkgPath = join(pkgRoot, "package.json");
    if (!existsSync(pkgPath)) return enabled;

    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      /* malformed or unreadable package.json — omit silently */
      return enabled;
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return enabled;

    try {
      const manifest = pkg as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        workspaces?: unknown;
      };
      const allDeps = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
      };
      const hasReact = !!(
        allDeps["react"] ||
        allDeps["next"] ||
        allDeps["@remix-run/react"] ||
        allDeps["@xyflow/react"] ||
        allDeps["preact"]
      );
      if (hasReact && hasJsxFilesShallow(pkgRoot, readdirSync)) {
        enabled.push(...REACT_TOOLS);
      }
      const hasHono = !!(
        allDeps["hono"] ||
        allDeps["@hono/zod-openapi"] ||
        allDeps["@hono/node-server"] ||
        allDeps["hono-openapi"] ||
        allDeps["chanfana"]
      );
      if (hasHono) enabled.push(...HONO_TOOLS);

      // Prisma / Drizzle — schema-driven DB stacks. analyze_prisma_schema
      // works for Prisma; migration_lint (squawk) works for any SQL migration
      // dir, useful for both. We don't condition on @prisma/client because
      // it's runtime-only — the schema work belongs to the `prisma` CLI dep.
      const hasPrismaLike = !!(
        allDeps["prisma"] ||
        allDeps["@prisma/client"] ||
        allDeps["drizzle-kit"] ||
        allDeps["drizzle-orm"]
      );
      if (hasPrismaLike) enabled.push(...PRISMA_TOOLS);

      // npm/yarn/pnpm workspaces field — content-based monorepo signal.
      // Complements the file-based signals (pnpm-workspace.yaml, lerna.json,
      // nx.json, turbo.json) so plain `"workspaces": [...]` setups also fire.
      const ws = manifest.workspaces;
      const hasWorkspaces = Array.isArray(ws) ||
        (ws !== null &&
          typeof ws === "object" &&
          !Array.isArray(ws) &&
          Array.isArray((ws as { packages?: unknown }).packages));
      if (hasWorkspaces) enabled.push(...MONOREPO_TOOLS);
    } catch (err) {
      const detail = err instanceof Error ? err.stack ?? err.message : String(err);
      console.warn(`[codesift-mcp] detectFromPackageJson(${pkgRoot}): ${detail}`);
    }
    return enabled;
  };

  // Root-level detection (existing behavior — unchanged for flat repos).
  toEnable.push(...detectFromPackageJson(cwd));

  // Monorepo workspace walk (Task 15). When monorepo detected at cwd, union
  // each workspace's framework signals into the auto-load set. Hard cap at 50
  // workspaces to bound startup cost (sync FS reads at module-init time);
  // very large monorepos (>50 packages) fall back to root-only auto-load —
  // discover_tools / describe_tools still work for any framework tool needed
  // at query time.
  if (killSwitchOff) {
    try {
      const { resolveWorkspaces } = await import("../storage/workspace-resolver.js");
      const resolved = await resolveWorkspaces(cwd);
      if (resolved && resolved.workspaces.length > 0 && resolved.workspaces.length <= 50) {
        for (const ws of resolved.workspaces) {
          toEnable.push(...detectFromPackageJson(ws.root));
        }
      }
    } catch {
      /* monorepo resolver failure is non-fatal; flat-repo behavior preserved */
    }
  }

  return toEnable;
}

export function detectAutoLoadToolsCached(cwd: string): Promise<string[]> {
  const now = Date.now();
  const cached = autoLoadToolsCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cloneAutoLoadTools(cached.value);
  }

  const value = detectAutoLoadTools(cwd)
    .then((tools) => [...new Set(tools)])
    .catch((err) => {
      autoLoadToolsCache.delete(cwd);
      throw err;
    });

  autoLoadToolsCache.set(cwd, {
    expiresAt: now + AUTO_LOAD_CACHE_TTL_MS,
    value,
  });
  return cloneAutoLoadTools(value);
}

/**
 * Quick recursive scan for .tsx/.jsx files in common source dirs.
 * Limits depth to 3 and stops on first match to stay fast (<10ms on typical repos).
 * Skips node_modules, dist, build, .next, .astro, .git.
 */
function hasJsxFilesShallow(
  cwd: string,
  readdirSyncFn: typeof import("node:fs").readdirSync,
): boolean {
  // ESM-safe path import (avoid `require("node:path")`, which throws under ESM).
  const { join } = pathModule;
  const IGNORE = new Set([
    "node_modules", "dist", "build", ".next", ".astro", ".git",
    "out", "coverage", ".turbo", ".vercel", ".cache",
  ]);
  const ROOTS = ["src", "app", "pages", "components", "."];

  function scan(dir: string, depth: number): boolean {
    if (depth > 3) return false;
    let entries;
    try {
      entries = readdirSyncFn(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && /\.(tsx|jsx)$/.test(e.name)) return true;
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith(".")) {
        if (scan(join(dir, e.name), depth + 1)) return true;
      }
    }
    return false;
  }

  for (const root of ROOTS) {
    const dir = root === "." ? cwd : join(cwd, root);
    try {
      if (scan(dir, 0)) return true;
    } catch { /* skip */ }
  }
  return false;
}

/**
 * Quick scan for *.sql files in conventional schema/migration directories.
 * Used to auto-enable the SQL toolchain on any project that ships raw SQL
 * regardless of language stack. Stops on first hit; depth capped at 3 so
 * nested package dirs (e.g. monorepo apps/*) are still reachable.
 */
function hasSqlFilesShallow(
  cwd: string,
  readdirSyncFn: typeof import("node:fs").readdirSync,
): boolean {
  const { join } = pathModule;
  const IGNORE = new Set([
    "node_modules", "dist", "build", ".next", ".astro", ".git",
    "out", "coverage", ".turbo", ".vercel", ".cache", "vendor",
  ]);
  // SQL conventionally lives in dedicated dirs — scanning every src/ tree
  // would trigger false positives on test fixtures and string-literal SQL.
  const DEEP_ROOTS = [
    "migrations", "migration", "db", "database", "schema", "schemas",
    "sql", "ddl", "seeds", "seed", "supabase",
    "prisma/migrations", "drizzle/migrations",
  ];

  function scanDeep(dir: string, depth: number): boolean {
    if (depth > 3) return false;
    let entries;
    try {
      entries = readdirSyncFn(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && /\.sql$/i.test(e.name)) return true;
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith(".")) {
        if (scanDeep(join(dir, e.name), depth + 1)) return true;
      }
    }
    return false;
  }

  // Top-level: dump files like `schema.sql` / `init.sql` / `database.sql`.
  try {
    const rootEntries = readdirSyncFn(cwd, { withFileTypes: true });
    for (const e of rootEntries) {
      if (e.isFile() && /\.sql$/i.test(e.name)) return true;
    }
  } catch { /* skip */ }

  for (const root of DEEP_ROOTS) {
    try {
      if (scanDeep(join(cwd, root), 0)) return true;
    } catch { /* skip */ }
  }
  return false;
}
