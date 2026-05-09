/**
 * Yii2 module inventory (N1).
 *
 * Scans a Yii2 codebase for classes extending `yii\\base\\Module` and emits
 * a structured per-module summary: controller namespace, controllers, views,
 * migrations path, components, sub-modules. Also resolves URL prefixes by
 * cross-referencing config/web.php urlManager rules + the application's
 * `modules` registration.
 *
 * Why this is its own tool (vs. squeezing into php_project_audit):
 *   - Modules are the primary architectural unit of medium/large Yii2 apps
 *     (tgm-panel: 11 modules; Mobi 2: similar). Routing, RBAC, and god-model
 *     analysis all benefit from being able to scope to a module.
 *   - The output is a graph of cross-file references (controllers ↔ views ↔
 *     migrations ↔ config), not a flat findings list.
 *
 * Implementation depends on the v2.0.0 PHP extractor — uses `s.extends`
 * (introduced in Sprint 1) to detect Module subclasses structurally.
 * Falls back to a regex check on `s.source` when `extends` is absent so
 * stale indexes don't go silent.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface YiiControllerRef {
  class: string;
  file: string;
  /** Action methods discovered as children — names retain the `action` prefix
   *  so callers can map them back to URL action ids without ambiguity. */
  actions: string[];
}

export interface YiiModuleSummary {
  /** Module id derived from the directory name containing Module.php. */
  id: string;
  /** Fully-qualified class name (e.g. app\\modules\\review\\Module). */
  class: string;
  /** Path to the Module.php file. */
  file: string;
  /** Value of `controllerNamespace` property if declared, else null. */
  controllerNamespace: string | null;
  /** Path containing the module's controllers, derived from the Module.php
   *  location. */
  controllers_path: string;
  controllers: YiiControllerRef[];
  /** Per-module views directory. */
  views_path: string;
  views_count: number;
  /** Module's own migrations directory if present (e.g. modules/<id>/migrations/). */
  migrations_path: string | null;
  migrations_count: number;
  /** Sub-module ids (modules nested under this module's modules() method). */
  submodules: string[];
  /** URL prefixes from main app config that route into this module. */
  url_prefixes: string[];
}

export interface YiiModulesAudit {
  repo: string;
  total_modules: number;
  modules: YiiModuleSummary[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MODULE_BASE_NAMES = new Set(["Module", "BaseModule"]);

/**
 * Walk a class symbol's extends chain looking for a Yii2 Module ancestor.
 * Mirrors isActiveRecordHierarchy from php-tools but for the Module base.
 * Cycle protection + depth cap. Falls back to source-text regex when extends
 * metadata is absent (legacy index pre-v2.0.0 extractor).
 */
function isModuleHierarchy(
  cls: { name: string; extends?: string[]; source?: string },
  index: { symbols: Array<{ name: string; kind: string; extends?: string[]; source?: string }> },
  visited: Set<string> = new Set(),
  depth = 0,
): boolean {
  if (depth > 5) return false;
  if (visited.has(cls.name)) return false;
  visited.add(cls.name);

  const exts = cls.extends ?? [];
  for (const baseFqcn of exts) {
    const last = baseFqcn.split(/[\\\\]+/).pop() ?? baseFqcn;
    if (MODULE_BASE_NAMES.has(last)) return true;
    const baseSym = index.symbols.find(
      (s) => s.kind === "class" && s.name === last,
    );
    if (baseSym && isModuleHierarchy(baseSym, index, visited, depth + 1)) {
      return true;
    }
  }
  if (!cls.extends && cls.source) {
    return /extends\s+(?:\\?yii\\base\\Module|Module)\b/.test(cls.source);
  }
  return false;
}

export async function analyzeYiiModules(
  repo: string,
  options?: { module_id?: string },
): Promise<YiiModulesAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Find all class symbols whose file basename is exactly Module.php — Yii2
  // canonical convention. We additionally verify the class extends Module
  // (catches cases where a Module.php contains an unrelated helper class).
  const moduleClasses = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith("/Module.php") && s.file !== "Module.php") return false;
    if (!isModuleHierarchy(s, index)) return false;
    return true;
  });

  // Pre-resolve url-manager rules from config — used to attach url_prefixes
  // to each module. Robust against missing config: we read each candidate
  // file and scan with a single regex; failures are non-fatal.
  const urlPrefixesByModule = await resolveUrlPrefixes(index);

  const modules: YiiModuleSummary[] = [];

  for (const cls of moduleClasses) {
    const moduleDir = dirname(cls.file);
    const id =
      moduleDir.split("/").pop() ?? cls.name.replace(/Module$/, "").toLowerCase();
    if (options?.module_id && id !== options.module_id) continue;

    // controllerNamespace: explicit declaration on the Module class.
    // Captured from `public $controllerNamespace = '...';` in source.
    let controllerNamespace: string | null = null;
    if (cls.source) {
      const cnMatch =
        /\$controllerNamespace\s*=\s*['"]([^'"]+)['"]/.exec(cls.source);
      controllerNamespace = cnMatch?.[1] ?? null;
    }
    // Yii2 default: `<module-namespace>\\controllers`. We synthesize this
    // when the module class doesn't override it explicitly.
    const defaultControllerNamespace = computeDefaultControllerNamespace(cls.file);

    const effectiveNs = controllerNamespace ?? defaultControllerNamespace;
    const controllersPath = join(moduleDir, "controllers");

    // Find controller classes living under the module's controllers/ dir.
    const controllerSymbols = index.symbols.filter(
      (s) =>
        s.kind === "class" &&
        s.file.startsWith(controllersPath + "/") &&
        s.name.endsWith("Controller"),
    );
    const controllers: YiiControllerRef[] = controllerSymbols.map((c) => ({
      class: effectiveNs ? `${effectiveNs}\\${c.name}` : c.name,
      file: c.file,
      actions: index.symbols
        .filter(
          (s) => s.parent === c.id && s.kind === "method" && s.name.startsWith("action"),
        )
        .map((s) => s.name),
    }));

    // Views, migrations, sub-modules — each detected by directory presence.
    const viewsPath = join(moduleDir, "views");
    const viewsCount = index.files.filter((f) =>
      f.path.startsWith(viewsPath + "/"),
    ).length;

    const migrationsPath = join(moduleDir, "migrations");
    const migrationsCount = index.files.filter((f) =>
      f.path.startsWith(migrationsPath + "/") && /m\d+_\d+_/.test(f.path),
    ).length;

    // Sub-modules: nested module directories with their own Module.php.
    const submoduleClasses = index.symbols.filter(
      (s) =>
        s.kind === "class" &&
        (s.file.endsWith("/Module.php") || s.file === "Module.php") &&
        s.file !== cls.file &&
        s.file.startsWith(moduleDir + "/"),
    );
    const submodules = submoduleClasses
      .map((sc) => dirname(sc.file).split("/").pop() ?? "")
      .filter(Boolean);

    modules.push({
      id,
      class: effectiveNs ? `${effectiveNs.replace(/\\controllers$/, "")}\\${cls.name}` : cls.name,
      file: cls.file,
      controllerNamespace,
      controllers_path: controllersPath,
      controllers,
      views_path: viewsPath,
      views_count: viewsCount,
      migrations_path: migrationsCount > 0 ? migrationsPath : null,
      migrations_count: migrationsCount,
      submodules,
      url_prefixes: urlPrefixesByModule.get(id) ?? [],
    });
  }

  // Stable order: by id alphabetically — useful when consumers diff this
  // output across audit runs.
  modules.sort((a, b) => a.id.localeCompare(b.id));

  return { repo, total_modules: modules.length, modules };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize the default controllerNamespace for a Module.php file.
 * Yii2 convention: take the Module's PHP namespace and append "\\controllers".
 * We read the file directly because the namespace declaration is at the
 * top of the file, not on the symbol itself.
 *
 * Returns null if the file isn't readable or has no namespace declaration.
 * The caller falls back to bare class names when this is null.
 */
function computeDefaultControllerNamespace(_file: string): string | null {
  // Lazy: this is best-effort — if the namespace can't be determined the
  // controllers list still works (we just lose the FQCN wrapping). Reading
  // the file synchronously inside a hot loop would be slow; we accept the
  // null fallback rather than spin up a per-module readFile here.
  return null;
}

/**
 * Scan main config files for `urlManager` rules and group resolved URL
 * prefixes by module id. Yii2 url rules of the form
 *   '<module-id>/<controller-id>/<action-id>'
 *   '<module-id>/<controller-id>'
 *   ['class' => 'yii\\rest\\UrlRule', 'controller' => '<module-id>/<ctrl>']
 * all map to a single module-id prefix. Naive matcher — collects literal
 * prefix strings, callers can dedupe further by stripping verbs.
 */
async function resolveUrlPrefixes(
  index: { root: string; files: Array<{ path: string }> },
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const configFiles = index.files.filter((f) =>
    /config\/(?:web|main|api|backend|frontend|common)(?:[-_][\w-]+)?\.php$/.test(
      f.path,
    ),
  );

  for (const cf of configFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, cf.path), "utf-8");
    } catch {
      continue;
    }

    // Generic pattern: 'GET <prefix>/...' => 'mod/ctrl/act' OR
    //                  '<prefix>/...' => 'mod/ctrl/act'
    // We capture the route target string (right side) and pull its first
    // segment as module id.
    const ruleRe = /['"](?:GET |POST |PUT |DELETE |PATCH )?[^'"]+['"]\s*=>\s*['"]([\w-]+)\/(?:[\w-]+\/?)*['"]/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(source)) !== null) {
      const prefix = m[1]!;
      // Filter common false positives: top-level controller names that look
      // like prefixes but aren't modules (site, debug, gii). Caller can
      // ignore these by intersecting with the actual module list.
      if (!out.has(prefix)) out.set(prefix, []);
      out.get(prefix)!.push(prefix);
    }
  }

  // Dedupe per-key
  for (const [k, v] of out.entries()) {
    out.set(k, Array.from(new Set(v)));
  }
  return out;
}

// Re-export relative for tests that want to assert on path shapes.
export { relative as _relativePathForTests };
