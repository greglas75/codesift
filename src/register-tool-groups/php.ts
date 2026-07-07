import { z, lazySchema, type ToolDefinitionEntry } from "./shared.js";
import { resolvePhpNamespace, tracePhpEvent, findPhpViews, resolvePhpService, phpSecurityScan, phpProjectAudit, yii3MigrationAudit, php8CompatCheck, analyzeYiiModules, analyzeYiiMigrations, analyzeYiiRbac, findPhp8MigrationCandidates, analyzePhpStanBaseline, analyzeYiiConsoleCommands, findYii3AttributeCandidates } from "./deps.js";

export const PHP_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // --- PHP / Yii2 tools (all discoverable via discover_tools(query="php")) ---
  { order: 3028, definition: {
    name: "resolve_php_namespace",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php namespace resolve PSR-4 autoload composer class file path yii2 laravel symfony",
    description: "Resolve a PHP FQCN to file path via composer.json PSR-4 autoload mapping.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      class_name: z.string().describe("Fully-qualified class name, e.g. 'App\\\\Models\\\\User'"),
    })),
    handler: async (args) => {
      return await resolvePhpNamespace(args.repo as string, args.class_name as string);
    },
  } },
  { order: 3042, definition: {
    name: "trace_php_event",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php event listener trigger handler chain yii2 laravel observer dispatch",
    description: "Trace PHP event → listener chains: find trigger() calls and matching on() handlers.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      event_name: z.string().optional().describe("Filter by specific event name"),
    })),
    handler: async (args) => {
      const opts: { event_name?: string } = {};
      if (typeof args.event_name === "string") opts.event_name = args.event_name;
      return await tracePhpEvent(args.repo as string, opts);
    },
  } },
  { order: 3058, definition: {
    name: "find_php_views",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php view render template controller widget yii2 laravel blade",
    description: "Map PHP controller render() calls to view files. Yii2/Laravel convention-aware.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      controller: z.string().optional().describe("Filter by controller class name"),
    })),
    handler: async (args) => {
      const opts: { controller?: string } = {};
      if (typeof args.controller === "string") opts.controller = args.controller;
      return await findPhpViews(args.repo as string, opts);
    },
  } },
  { order: 3074, definition: {
    name: "resolve_php_service",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php service locator DI container component resolve yii2 laravel facade provider",
    description: "Resolve PHP service locator references (Yii::$app->X, Laravel facades) to concrete classes via config parsing.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      service_name: z.string().optional().describe("Filter by specific service name (e.g. 'db', 'user', 'cache')"),
    })),
    handler: async (args) => {
      const opts: { service_name?: string } = {};
      if (typeof args.service_name === "string") opts.service_name = args.service_name;
      return await resolvePhpService(args.repo as string, opts);
    },
  } },
  { order: 3090, definition: {
    name: "php_security_scan",
    category: "security",
    requiresLanguage: "php",
    searchHint: "php security scan audit vulnerability injection XSS CSRF SQL eval exec unserialize",
    description: "Scan PHP code for security vulnerabilities: SQL injection, XSS, eval, exec, unserialize, file inclusion. Parallel pattern checks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter scanned files (default: '*.php')"),
      checks: z.array(z.string()).optional().describe("Subset of checks to run: sql-injection-php, xss-php, eval-php, exec-php, unserialize-php, file-include-var, unescaped-yii-view, raw-query-yii"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string; checks?: string[] } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (Array.isArray(args.checks)) opts.checks = args.checks as string[];
      return await phpSecurityScan(args.repo as string, opts);
    },
  } },
  { order: 3108, definition: {
    name: "php_project_audit",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php project audit health quality technical debt code review comprehensive yii2 laravel activerecord eloquent model schema relations rules behaviors table orm n+1 query foreach eager loading relation god class anti-pattern too many methods oversized",
    description: "Compound PHP project audit: security scan + ActiveRecord analysis + N+1 detection + god model detection + health score. Runs checks in parallel.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Glob pattern to filter analyzed files"),
      checks: z.string().optional().describe("Comma-separated checks: security, activerecord, complexity, dead_code, patterns, clones, hotspots, n_plus_one, god_model, yii_performance. Deprecated events/views/services/namespace return error gates. Default: all"),
    })),
    handler: async (args) => {
      const opts: { file_pattern?: string; checks?: string[] } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.checks === "string" && args.checks.trim()) {
        opts.checks = args.checks.split(",").map((c) => c.trim()).filter(Boolean);
      }
      return await phpProjectAudit(args.repo as string, opts);
    },
  } },
  { order: 3128, definition: {
    name: "yii3_migration_audit",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "yii2 yii3 migration audit decision support upgrade php8 active record module rbac authmanager service locator yii::$app legacy modernization effort estimate",
    description:
      "Yii2→Yii3 migration audit. Inventories Yii2-specific API usage across 21 categories (service-locator, ActiveRecord, Module, RBAC, console, migrations, widgets, view, url-manager, ...) with severity, sample evidence, and an effort_estimate. Returns a decision_signal (stay-on-yii2 / consider-yii3 / high-effort-yii3 / blocked) so engineering leadership can choose between staying on Yii 2.0.49+ with PHP 8 vs migrating to Yii3.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Substring filter on file paths"),
      max_samples_per_category: z.number().optional().describe("Cap on sample evidence per category (default 5)"),
      include_vendor: z.boolean().optional().describe("Include vendor/ paths in scan (default false)"),
    })),
    handler: async (args) => {
      const opts: {
        file_pattern?: string;
        max_samples_per_category?: number;
        include_vendor?: boolean;
      } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.max_samples_per_category === "number") {
        opts.max_samples_per_category = args.max_samples_per_category;
      }
      if (typeof args.include_vendor === "boolean") opts.include_vendor = args.include_vendor;
      return await yii3MigrationAudit(args.repo as string, opts);
    },
  } },
  { order: 3155, definition: {
    name: "php8_compat_check",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php 8 upgrade compatibility breaking changes deprecation each create_function real cast money_format array_key_exists null string param utf8 spread operator dynamic property merge gate yii2 2.0.49",
    description:
      "PHP 7→8 upgrade compatibility check. Pre-merge gating tool: scans for breaking changes (8.0) and deprecations (8.1/8.2) and flags Yii < 2.0.49 (which has known PHP 8 bugs). Run before merging the PHP 8 upgrade branch into main. Returns blocker_for_merge=true when any breaking_8_0 finding is present.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Substring filter on file paths"),
      max_samples_per_rule: z.number().optional().describe("Cap on sample evidence per rule (default 5)"),
      include_vendor: z.boolean().optional().describe("Include vendor/ paths in scan (default false)"),
      rules: z.string().optional().describe("Comma-separated rule IDs to run (default: all)"),
    })),
    handler: async (args) => {
      const opts: {
        file_pattern?: string;
        max_samples_per_rule?: number;
        include_vendor?: boolean;
        rules?: import("../tools/php8-compat-tools.js").Php8RuleId[];
      } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.max_samples_per_rule === "number") {
        opts.max_samples_per_rule = args.max_samples_per_rule;
      }
      if (typeof args.include_vendor === "boolean") opts.include_vendor = args.include_vendor;
      if (typeof args.rules === "string" && args.rules.trim()) {
        opts.rules = args.rules.split(",").map((s) => s.trim()).filter(Boolean) as import("../tools/php8-compat-tools.js").Php8RuleId[];
      }
      return await php8CompatCheck(args.repo as string, opts);
    },
  } },
  { order: 3187, definition: {
    name: "analyze_yii_modules",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "yii2 module modules controllerNamespace structure routing inventory submodule per-module migrations views",
    description:
      "Inventory Yii2 modules in a codebase. For each module returns id, controllerNamespace (declared or default), controllers + actions, views_count, migrations_path/count, sub-modules, and URL prefixes resolved from urlManager rules. Yii2 advanced/standard template friendly.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      module_id: z.string().optional().describe("Filter to a single module id"),
    })),
    handler: async (args) => {
      const opts: { module_id?: string } = {};
      if (typeof args.module_id === "string") opts.module_id = args.module_id;
      return await analyzeYiiModules(args.repo as string, opts);
    },
  } },
  { order: 3204, definition: {
    name: "analyze_yii_migrations",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "yii2 migration migrations PHP DSL safeUp safeDown createTable dropTable addColumn dropColumn alterColumn addForeignKey createIndex online ddl ALGORITHM INPLACE LOCK NONE irreversible audit",
    description:
      "Audit Yii2 PHP-DSL migrations. Parses extends Migration classes — createTable / dropTable / addColumn / dropColumn / alterColumn / createIndex / addForeignKey / etc — into structured operations and runs per-migration audit checks: missing-safe-down, alter-without-online-ddl (high — destructive ops on large tables without ALGORITHM=INPLACE/LOCK=NONE hint), fk-without-index (medium — addForeignKey without preceding createIndex), raw-sql-without-comment. Closes the gap that the generic SQL toolchain (migration_lint) misses because it only parses .sql files.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Substring filter on migration file paths"),
      rules: z.string().optional().describe("Comma-separated rule IDs to run (default: all). Available: missing-safe-down, alter-without-online-ddl, fk-without-index, raw-sql-without-comment, drop-without-safety"),
    })),
    handler: async (args) => {
      const opts: {
        file_pattern?: string;
        rules?: import("../tools/yii-migrations-tools.js").YiiMigrationAuditFinding["rule_id"][];
      } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.rules === "string" && args.rules.trim()) {
        opts.rules = args.rules.split(",").map((s) => s.trim()).filter(Boolean) as import("../tools/yii-migrations-tools.js").YiiMigrationAuditFinding["rule_id"][];
      }
      return await analyzeYiiMigrations(args.repo as string, opts);
    },
  } },
  { order: 3228, definition: {
    name: "analyze_yii_rbac",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "yii2 rbac authManager createPermission createRole addChild can() AccessControl behaviors orphan unused permission audit dektrium dbmanager phpmanager",
    description:
      "Yii2 RBAC permission graph audit. Cross-references permission/role definitions in seed migrations + RBAC seeders against runtime checks (Yii::$app->user->can() + AccessControl behaviors). Returns orphan_checks (checked but never defined — typo / dead code), unused_definitions (defined but never checked — dead seed), controllers_without_access_control (classes named *Controller without AccessControl in behaviors() and no can() calls), and dynamic_creates (createPermission(\\$var) sites that need manual review).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      include_vendor: z.boolean().optional().describe("Include vendor/ paths (default false)"),
    })),
    handler: async (args) => {
      const opts: { include_vendor?: boolean } = {};
      if (typeof args.include_vendor === "boolean") opts.include_vendor = args.include_vendor;
      return await analyzeYiiRbac(args.repo as string, opts);
    },
  } },
  { order: 3245, definition: {
    name: "find_php8_migration_candidates",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "php 8 modernization candidates promoted constructor typed properties readonly enum match docblock @var migration upgrade modernize",
    description:
      "Find PHP 8 modernization candidates after a 7→8 upgrade. Surfaces 6 rule classes: promotable-ctor (collapse self-assignment ctor to promoted form), docblock-to-typed-property (convert /** @var T */ to inline `public T $x`), nullable-flag-to-syntax (`@var T|null` → `?T`), readonly-candidate (ctor-only assigned property → add readonly), enum-from-class-consts (pre-enum bag-of-constants → backed enum), match-from-switch (all-return switch → match expression). Each finding includes a suggested_replacement string and confidence rating; the tool never auto-applies changes.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Substring filter on file paths"),
      max_samples_per_rule: z.number().optional().describe("Cap on sample evidence per rule (default 5)"),
      include_vendor: z.boolean().optional().describe("Include vendor/ paths (default false)"),
      rules: z.string().optional().describe("Comma-separated rule IDs to run (default: all)"),
    })),
    handler: async (args) => {
      const opts: {
        file_pattern?: string;
        max_samples_per_rule?: number;
        include_vendor?: boolean;
        rules?: import("../tools/php8-migration-candidates-tools.js").Php8MigrationRuleId[];
      } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.max_samples_per_rule === "number") {
        opts.max_samples_per_rule = args.max_samples_per_rule;
      }
      if (typeof args.include_vendor === "boolean") opts.include_vendor = args.include_vendor;
      if (typeof args.rules === "string" && args.rules.trim()) {
        opts.rules = args.rules.split(",").map((s) => s.trim()).filter(Boolean) as import("../tools/php8-migration-candidates-tools.js").Php8MigrationRuleId[];
      }
      return await findPhp8MigrationCandidates(args.repo as string, opts);
    },
  } },
  { order: 3277, definition: {
    name: "analyze_phpstan_baseline",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "phpstan baseline neon parse error categorize quick wins debt ledger triage",
    description:
      "Parse a phpstan-baseline.neon file and triage ignored errors. Returns by_path (files ranked by error count), by_category (no-return-type, undefined-property, iterable-no-value-type, ...), quick_wins (files with ≤3 errors — fastest to clear), and full entries list. Universal PHP tool — works on any project that uses PHPStan, not Yii2-only.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      baseline_path: z.string().optional().describe("Override baseline file path (default: phpstan-baseline.neon)"),
      max_paths: z.number().optional().describe("Cap on by_path entries (default 50)"),
    })),
    handler: async (args) => {
      const opts: { baseline_path?: string; max_paths?: number } = {};
      if (typeof args.baseline_path === "string") opts.baseline_path = args.baseline_path;
      if (typeof args.max_paths === "number") opts.max_paths = args.max_paths;
      return await analyzePhpStanBaseline(args.repo as string, opts);
    },
  } },
  { order: 3296, definition: {
    name: "analyze_yii_console_commands",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "yii2 console commands controllers cron jobs cli action arguments ExitCode flags risk audit unbounded",
    description:
      "Inventory Yii2 console controllers (extends yii\\console\\Controller). For each action returns CLI id, typed argument list, variadic flag, docstring, and risk flags: exits-without-return-status (cron can't tell success from failure), has-unbounded-all (memory bomb), has-no-error-handling (no try/catch), uses-output-via-echo (use stdout/stderr instead). Cross-controller `high_risk_actions` summary surfaces actions with ≥2 flags.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      controller_id: z.string().optional().describe("Filter to a single controller cli_id"),
    })),
    handler: async (args) => {
      const opts: { controller_id?: string } = {};
      if (typeof args.controller_id === "string") opts.controller_id = args.controller_id;
      return await analyzeYiiConsoleCommands(args.repo as string, opts);
    },
  } },
  { order: 3313, definition: {
    name: "find_yii3_attribute_candidates",
    category: "analysis",
    requiresLanguage: "php",
    searchHint: "yii3 attribute candidates conversion behaviors rules urlManager route migration php8 attributes",
    description:
      "Find Yii2→Yii3 attribute conversion candidates. Three rule classes: behaviors-to-attributes (behaviors() with TimestampBehavior etc → #[Behavior(class)]), rules-to-attributes (rules() entries → #[Required], #[Email], etc on properties), urlmanager-rule-to-route (urlManager rules → #[Route(method, path)] on controller actions, with <id:\\d+> placeholders converted to {id}). Each candidate ships current_form, suggested_replacement, confidence, and blockers[] for cases that need manual review (closures in config, regex constraints, module-prefixed targets).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Substring filter on file paths"),
      max_samples_per_rule: z.number().optional().describe("Cap on sample evidence per rule (default 5)"),
      include_vendor: z.boolean().optional().describe("Include vendor/ paths (default false)"),
      rules: z.string().optional().describe("Comma-separated rule IDs to run (default: all)"),
    })),
    handler: async (args) => {
      const opts: {
        file_pattern?: string;
        max_samples_per_rule?: number;
        include_vendor?: boolean;
        rules?: import("../tools/yii3-attribute-candidates-tools.js").Yii3AttributeRuleId[];
      } = {};
      if (typeof args.file_pattern === "string") opts.file_pattern = args.file_pattern;
      if (typeof args.max_samples_per_rule === "number") {
        opts.max_samples_per_rule = args.max_samples_per_rule;
      }
      if (typeof args.include_vendor === "boolean") opts.include_vendor = args.include_vendor;
      if (typeof args.rules === "string" && args.rules.trim()) {
        opts.rules = args.rules.split(",").map((s) => s.trim()).filter(Boolean) as import("../tools/yii3-attribute-candidates-tools.js").Yii3AttributeRuleId[];
      }
      return await findYii3AttributeCandidates(args.repo as string, opts);
    },
  } },
];
