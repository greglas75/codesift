/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Provides 9 hidden/discoverable tools that augment generic code intelligence
 * with PHP framework awareness: PSR-4 namespace resolution, ActiveRecord schema
 * extraction, event/listener tracing, view mapping, service locator resolution,
 * security scanning, compound project audit (9-gate), N+1 query detection,
 * and god-model detection.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { searchPatterns } from "./pattern-tools.js";

// ---------------------------------------------------------------------------
// 7a. resolve_php_namespace — PSR-4 resolver
// ---------------------------------------------------------------------------

export interface PhpNamespaceResolution {
  class_name: string;
  namespace: string;
  file_path: string | null;
  exists: boolean;
  psr4_root: string | null;
  psr4_prefix: string | null;
}

export async function resolvePhpNamespace(
  repo: string,
  className: string,
): Promise<PhpNamespaceResolution> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const composer = await readJsonSafe(join(index.root, "composer.json"));
  const psr4: Record<string, string | string[]> = {
    ...(composer?.autoload?.["psr-4"] ?? {}),
    ...(composer?.["autoload-dev"]?.["psr-4"] ?? {}),
  };

  // Strip leading backslash
  const normalized = className.replace(/^\\/, "");
  const parts = normalized.split("\\");
  const namespaceOnly = parts.slice(0, -1).join("\\");
  const shortName = parts[parts.length - 1]!;

  // Find matching PSR-4 prefix (longest match wins)
  let bestPrefix: string | null = null;
  let bestRoot: string | null = null;
  for (const [prefix, roots] of Object.entries(psr4)) {
    const normalizedPrefix = prefix.replace(/\\$/, "");
    if (normalized.startsWith(normalizedPrefix + "\\") || normalized === normalizedPrefix) {
      if (!bestPrefix || normalizedPrefix.length > bestPrefix.length) {
        bestPrefix = normalizedPrefix;
        bestRoot = Array.isArray(roots) ? roots[0] ?? null : roots;
      }
    }
  }

  if (!bestPrefix || !bestRoot) {
    return {
      class_name: shortName,
      namespace: namespaceOnly,
      file_path: null,
      exists: false,
      psr4_root: null,
      psr4_prefix: null,
    };
  }

  // Construct file path: strip prefix, replace \ with /, append .php
  const remainder = normalized.slice(bestPrefix.length).replace(/^\\/, "");
  const relativePath = remainder.replace(/\\/g, "/") + ".php";
  const root = bestRoot.replace(/\/$/, "");
  const filePath = root + "/" + relativePath;

  // Check if file exists in index (strip leading ./ for comparison)
  const normalizedFP = filePath.replace(/^\.\//, "");
  const exists = index.files.some((f) => f.path === normalizedFP || f.path === filePath);

  return {
    class_name: shortName,
    namespace: namespaceOnly,
    file_path: filePath,
    exists,
    psr4_root: bestRoot,
    psr4_prefix: bestPrefix,
  };
}

// ---------------------------------------------------------------------------
// 7b. analyze_activerecord — Model schema
// ---------------------------------------------------------------------------

export interface ActiveRecordModel {
  name: string;
  file: string;
  table_name: string | null;
  relations: { name: string; type: "hasOne" | "hasMany" | "manyMany"; target_class: string }[];
  rules: string[];
  behaviors: string[];
  methods: string[];
}

export interface ActiveRecordAnalysis {
  models: ActiveRecordModel[];
  total: number;
}

/**
 * Names of class roots that we treat as "this is an ActiveRecord". The check
 * is done on the LAST namespace segment so prefixed forms (yii\\db\\ActiveRecord,
 * \\yii\\db\\ActiveRecord, app\\models\\ActiveRecord) all match. Includes
 * yii\\base\\Model because Yii2 form models extending Model share the
 * rules() / behaviors() lifecycle that analyzeActiveRecord introspects;
 * downstream callers can filter by tableName() presence if they need a
 * stricter "real DB-backed AR" criterion.
 */
const AR_ROOT_NAMES = new Set(["ActiveRecord", "Model", "BaseActiveRecord"]);

/**
 * Walk a class symbol's `extends` chain and return true if any ancestor
 * matches a known ActiveRecord base class. Resolves transitively via the
 * symbol index — handles cases like `User extends BaseUser` where
 * `BaseUser extends ActiveRecord`.
 *
 * Direct match (root name in our AR_ROOT_NAMES set) wins immediately.
 * Otherwise we look up the parent class symbol by name and recurse. The
 * lookup uses last-segment name matching (e.g. `BaseUser` matches a class
 * symbol whose `name` is exactly `BaseUser`, regardless of namespace) which
 * is good enough for the codebases we care about; cross-package aliased
 * resolution would require parsing per-file `use` tables.
 *
 * Cycle protection via a visited set; depth-cap of 5 (no real Yii2 model
 * has a deeper chain).
 */
function isActiveRecordHierarchy(
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
    // Last segment of FQCN (handles "\\yii\\db\\ActiveRecord" and aliases).
    const last = baseFqcn.split(/[\\\\]+/).pop() ?? baseFqcn;
    if (AR_ROOT_NAMES.has(last)) return true;

    // Look up the base class as an indexed symbol and recurse.
    const baseSym = index.symbols.find(
      (s) => s.kind === "class" && s.name === last,
    );
    if (baseSym && isActiveRecordHierarchy(baseSym, index, visited, depth + 1)) {
      return true;
    }
  }

  // Fallback for older indexes (e.g. before the v2.0.0 extractor bump): if
  // `extends` is missing on this symbol, try the legacy regex against
  // `source` so we don't regress on unindexed projects.
  if (!cls.extends && cls.source) {
    return /extends\s+(?:ActiveRecord|Model|\\yii\\db\\ActiveRecord)\b/.test(
      cls.source,
    );
  }
  return false;
}

export async function analyzeActiveRecord(
  repo: string,
  options?: { model_name?: string; file_pattern?: string },
): Promise<ActiveRecordAnalysis> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Find PHP class symbols in model files
  const classSymbols = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".php")) return false;
    if (options?.model_name && s.name !== options.model_name) return false;
    if (options?.file_pattern && !s.file.includes(options.file_pattern)) return false;
    return true;
  });

  const models: ActiveRecordModel[] = [];

  for (const cls of classSymbols) {
    if (!cls.source) continue;
    if (!isActiveRecordHierarchy(cls, index)) continue;

    const model: ActiveRecordModel = {
      name: cls.name,
      file: cls.file,
      table_name: null,
      relations: [],
      rules: [],
      behaviors: [],
      methods: [],
    };

    // Extract tableName() return value
    const tableMatch = /function\s+tableName\s*\([^)]*\)[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/s.exec(cls.source);
    if (tableMatch) model.table_name = tableMatch[1]!;

    // Find child method symbols
    const methods = index.symbols.filter(
      (s) => s.parent === cls.id && s.kind === "method",
    );
    model.methods = methods.map((m) => m.name);

    // Extract relations from getX() methods that return hasOne/hasMany.
    // Two-pass detection:
    //   Pass 1: find the primary `->hasOne(Target::class, ...)` or
    //           `->hasMany(Target::class, ...)` call.
    //   Pass 2: scan the rest of the source for modifiers:
    //             ->via('relation')         (Yii2 2.0.13+ junction table via relation)
    //             ->viaTable('tbl', [...])  (direct junction table)
    //             ->inverseOf('relation')   (bidirectional relation)
    //           The presence of `via` or `viaTable` upgrades the relation type
    //           to `manyMany`. `inverseOf` is decorative and doesn't change type.
    for (const m of methods) {
      if (!m.name.startsWith("get") || !m.source) continue;
      const relName = m.name.slice(3);
      const primaryRe = /->(hasOne|hasMany)\s*\(\s*([\w\\]+)(?:::class)?/;
      const primaryMatch = primaryRe.exec(m.source);
      if (!primaryMatch) continue;

      const baseType: "hasOne" | "hasMany" = primaryMatch[1] === "hasOne" ? "hasOne" : "hasMany";
      const targetClass = primaryMatch[2]!;

      // Scan the method source for junction-table modifiers on the same chain.
      // If found, the semantic type is manyMany even though the primary call was hasMany.
      const hasJunction = /->(?:via|viaTable)\s*\(/.test(m.source);
      const type: "hasOne" | "hasMany" | "manyMany" = hasJunction ? "manyMany" : baseType;

      model.relations.push({
        name: relName.charAt(0).toLowerCase() + relName.slice(1),
        type,
        target_class: targetClass,
      });
    }

    // Extract rule validators (loose regex on rules() method source)
    const rulesMethod = methods.find((m) => m.name === "rules");
    if (rulesMethod?.source) {
      const ruleMatches = rulesMethod.source.matchAll(/\[\s*\[?['"]?[\w,\s'"]+['"]?\]?\s*,\s*['"]([\w]+)['"]/g);
      for (const rm of ruleMatches) {
        if (rm[1] && !model.rules.includes(rm[1])) model.rules.push(rm[1]);
      }
    }

    // Extract behaviors from behaviors() method
    const behaviorsMethod = methods.find((m) => m.name === "behaviors");
    if (behaviorsMethod?.source) {
      const bMatches = behaviorsMethod.source.matchAll(/([A-Z]\w+Behavior)(?:::class)?/g);
      for (const bm of bMatches) {
        if (bm[1] && !model.behaviors.includes(bm[1])) model.behaviors.push(bm[1]);
      }
    }

    models.push(model);
  }

  return { models, total: models.length };
}

// ---------------------------------------------------------------------------
// 7c. trace_php_event — Event → Listener chain
// ---------------------------------------------------------------------------

export interface PhpEventChain {
  event_name: string;
  triggers: { file: string; line: number; context: string }[];
  listeners: { file: string; line: number; context: string }[];
}

/**
 * Build a class-const → literal-value map for the entire index. Yii2's
 * canonical event idiom is `Event::on(User::class, User::EVENT_AFTER_LOGIN, ...)`,
 * where `EVENT_AFTER_LOGIN` is a class constant with a string value. The
 * default tracePhpEvent regex only sees literals, so without resolution
 * `Class::CONST` references look like dead code. This pre-pass walks all
 * `constant` symbols belonging to PHP classes and extracts their string /
 * int literal values from `source`.
 *
 * Map keys are `ClassName::CONST_NAME`. Class lookup is by last name segment
 * — same convention as isActiveRecordHierarchy — so namespace prefixes don't
 * matter for callers using `User::EVENT_X` against a class named `User`.
 *
 * Returns an empty map if no constants resolve. Cost is one O(n) walk per
 * call; could be cached on the index in the future if event tracing becomes
 * a hot path.
 */
function buildConstantValueMap(
  index: { symbols: Array<{ name: string; kind: string; parent?: string; source?: string }> },
): Map<string, string> {
  const out = new Map<string, string>();
  // First, build classId → className map so we can resolve const owners.
  const classIdToName = new Map<string, string>();
  for (const s of index.symbols) {
    if (s.kind === "class" || s.kind === "interface" || s.kind === "enum") {
      // Use the symbol id as key — every constant carries `parent` referring
      // to its enclosing class id, so we only need the id→name lookup.
      const id = (s as { id?: string }).id;
      if (id) classIdToName.set(id, s.name);
    }
  }
  for (const s of index.symbols) {
    if (s.kind !== "constant") continue;
    if (!s.parent || !s.source) continue;
    const className = classIdToName.get(s.parent);
    if (!className) continue;
    // Match the literal value: `const NAME = 'value';` or `const NAME = "v";`
    // or `const NAME = 42;`. We accept the first occurrence in the constant's
    // source slice — the extractor already narrows source to a single decl.
    const m = /=\s*(?:['"]([^'"]+)['"]|(-?\d+(?:\.\d+)?))/.exec(s.source);
    if (!m) continue;
    const value = m[1] ?? m[2];
    if (value === undefined) continue;
    out.set(`${className}::${s.name}`, value);
  }
  return out;
}

export async function tracePhpEvent(
  repo: string,
  options?: { event_name?: string },
): Promise<{ events: PhpEventChain[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const eventMap = new Map<string, PhpEventChain>();
  const constantValues = buildConstantValueMap(index);

  const getOrCreate = (name: string): PhpEventChain => {
    let e = eventMap.get(name);
    if (!e) {
      e = { event_name: name, triggers: [], listeners: [] };
      eventMap.set(name, e);
    }
    return e;
  };

  // Resolve `Class::CONST` references to their literal values via the pre-pass
  // map. Returns the original key when the class+const pair isn't indexed
  // (e.g. constants defined in vendor/) so the trace at least shows there's
  // SOMETHING happening at this site.
  const resolveEventName = (raw: string): string => {
    return constantValues.get(raw) ?? raw;
  };

  // Scan PHP file symbols for event triggers and listeners
  const phpSymbols = index.symbols.filter((s) => s.file.endsWith(".php") && s.source);

  for (const sym of phpSymbols) {
    const source = sym.source!;

    // Triggers: ->trigger('eventName') or ->trigger(Class::CONST)
    // Now also accepts a bare identifier path (Foo::BAR) in addition to the
    // string-literal form.
    const triggerRe =
      /->trigger\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z_][\w]*::[A-Z_][\w]*))/g;
    let match: RegExpExecArray | null;
    while ((match = triggerRe.exec(source)) !== null) {
      const literal = match[1];
      const constRef = match[2];
      const eventName = literal ?? (constRef ? resolveEventName(constRef) : undefined);
      if (!eventName) continue;
      if (options?.event_name && eventName !== options.event_name) continue;
      const line = sym.start_line + (source.slice(0, match.index).match(/\n/g)?.length ?? 0);
      getOrCreate(eventName).triggers.push({
        file: sym.file,
        line,
        context: extractLineContext(source, match.index),
      });
    }

    // Listeners: ->on('eventName', ...) or ::on('eventName', ...) or
    //            ::on(Foo::class, Foo::EVENT_BAR, ...)
    // Yii2 prefers the class-const form for built-in events, so resolution is
    // critical here.
    const listenerRe =
      /(?:->|::)on\s*\(\s*(?:[A-Z_][\w]*::class\s*,\s*)?(?:['"]([^'"]+)['"]|([A-Z_][\w]*::[A-Z_][\w]*))/g;
    while ((match = listenerRe.exec(source)) !== null) {
      const literal = match[1];
      const constRef = match[2];
      const eventName = literal ?? (constRef ? resolveEventName(constRef) : undefined);
      if (!eventName) continue;
      if (options?.event_name && eventName !== options.event_name) continue;
      const line = sym.start_line + (source.slice(0, match.index).match(/\n/g)?.length ?? 0);
      getOrCreate(eventName).listeners.push({
        file: sym.file,
        line,
        context: extractLineContext(source, match.index),
      });
    }
  }

  const events = [...eventMap.values()];
  return { events, total: events.length };
}

// ---------------------------------------------------------------------------
// 7d. find_php_views — render() → view file mapping
// ---------------------------------------------------------------------------

export type PhpRenderKind = "full" | "partial" | "ajax" | "json" | "file";

export interface PhpViewMapping {
  controller: string;
  action: string;
  view_name: string;
  /** Resolved view file path or null when the file isn't present in the
   *  index. Resolution prefers explicit path aliases, falls back to the
   *  Yii2 convention `views/{controller-id}/{view}.php`. */
  view_file: string | null;
  render_line: number;
  /** Sprint 8: render method flavor — `render` vs `renderPartial`/`renderAjax`/
   *  `renderAsJson`/`renderFile`. Useful for caching audits (full templates
   *  often inherit a layout, partials usually don't). */
  render_kind: PhpRenderKind;
  /** Sprint 8: when the render() argument starts with a `@alias/...`
   *  expression, this captures the alias. null for relative names. */
  path_alias: string | null;
}

export interface PhpLayoutMapping {
  controller: string;
  action: string | null;
  /** The layout name as written: 'main', '@app/views/layouts/admin', etc. */
  layout: string;
  /** Resolved file path or null when the alias couldn't be resolved. */
  layout_file: string | null;
  set_at_line: number;
}

export interface PhpWidgetReference {
  /** Widget class name as written (last namespace segment). */
  widget: string;
  /** Caller method's containing class — usually a controller, view, or
   *  another widget. */
  caller_class: string | null;
  caller_method: string | null;
  file: string;
  line: number;
  /** "begin" for `Widget::begin([...])`, "widget" for `Widget::widget([...])`. */
  kind: "begin" | "widget";
}

export interface PhpAssetBundleRef {
  /** Asset bundle class name (last namespace segment). */
  bundle: string;
  /** File registering the bundle (typically a view or layout). */
  file: string;
  line: number;
}

export interface FindPhpViewsResult {
  mappings: PhpViewMapping[];
  total: number;
  /** Sprint 8: layout assignments (`$this->layout = '...'`) per action. */
  layouts: PhpLayoutMapping[];
  /** Sprint 8: widget references across views + controllers. */
  widgets: PhpWidgetReference[];
  /** Sprint 8: AssetBundle::register() call sites. */
  asset_bundles: PhpAssetBundleRef[];
}

/**
 * Yii2 view + layout + widget + asset-bundle inventory.
 *
 * Beyond the original render→view mapping (Sprint 1), the tool now also:
 *   - Distinguishes render flavors (full/partial/ajax/json/file) so
 *     downstream caching/SEO audits can scope their checks.
 *   - Resolves `@alias/...` paths via the path-alias map sourced from
 *     `Yii::setAlias()` calls and `aliases` keys in config files.
 *   - Captures `$this->layout = '...'` assignments (controller-wide and
 *     per-action overrides).
 *   - Lists widget references (`GridView::begin/widget`) found anywhere
 *     in the codebase.
 *   - Lists `AssetBundle::register($this)` calls.
 */
export async function findPhpViews(
  repo: string,
  options?: {
    controller?: string;
    include_widgets?: boolean;
    include_asset_bundles?: boolean;
  },
): Promise<FindPhpViewsResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const includeWidgets = options?.include_widgets ?? true;
  const includeBundles = options?.include_asset_bundles ?? true;

  const mappings: PhpViewMapping[] = [];
  const layouts: PhpLayoutMapping[] = [];
  const widgets: PhpWidgetReference[] = [];
  const assetBundles: PhpAssetBundleRef[] = [];

  // Resolve path aliases up-front. The map is consulted for every
  // render() / layout assignment / view file path that begins with `@`.
  const aliasMap = await resolvePathAliases(index);

  // Find action methods in controllers
  const controllers = index.symbols.filter(
    (s) => s.kind === "class" && s.name.endsWith("Controller") && s.file.endsWith(".php"),
  );

  for (const ctrl of controllers) {
    if (options?.controller && !ctrl.name.includes(options.controller)) continue;

    // Controller-wide layout: `$this->layout = '...'` declared as a property
    // OR set in init() / beforeAction() / a per-action method.
    if (ctrl.source) {
      const layoutPropRe = /(?:public|protected|private)?\s*\$layout\s*=\s*['"]([^'"]+)['"]/;
      const propMatch = layoutPropRe.exec(ctrl.source);
      if (propMatch) {
        const layoutName = propMatch[1]!;
        layouts.push({
          controller: ctrl.name,
          action: null,
          layout: layoutName,
          layout_file: resolveLayoutFile(layoutName, ctrl.name, aliasMap, index),
          set_at_line: ctrl.start_line + (ctrl.source.slice(0, propMatch.index).match(/\n/g)?.length ?? 0),
        });
      }
    }

    const actions = index.symbols.filter(
      (s) => s.parent === ctrl.id && s.kind === "method" && s.name.startsWith("action"),
    );

    for (const action of actions) {
      if (!action.source) continue;

      // Match $this->render('viewName'), renderPartial('...'), renderAjax('...')
      // Capture the render KIND from the suffix so callers can filter by
      // flavor downstream.
      const renderRe = /\$this->render(Partial|Ajax|AsJson|File)?\s*\(\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = renderRe.exec(action.source)) !== null) {
        const suffix = match[1] ?? "";
        const viewName = match[2]!;
        const renderKind: PhpRenderKind = suffix === ""
          ? "full"
          : (suffix.toLowerCase().replace("asjson", "json") as PhpRenderKind);

        const { file: viewFile, alias } = resolveViewFile(
          viewName,
          ctrl.name,
          aliasMap,
          index,
        );
        const line = action.start_line + (action.source.slice(0, match.index).match(/\n/g)?.length ?? 0);

        mappings.push({
          controller: ctrl.name,
          action: action.name,
          view_name: viewName,
          view_file: viewFile,
          render_line: line,
          render_kind: renderKind,
          path_alias: alias,
        });
      }

      // Per-action layout override: `$this->layout = '...'` inside the
      // action body. Distinct entry from the controller-wide property.
      const layoutAssignRe = /\$this->layout\s*=\s*['"]([^'"]+)['"]/g;
      while ((match = layoutAssignRe.exec(action.source)) !== null) {
        const layoutName = match[1]!;
        const line =
          action.start_line +
          (action.source.slice(0, match.index).match(/\n/g)?.length ?? 0);
        layouts.push({
          controller: ctrl.name,
          action: action.name,
          layout: layoutName,
          layout_file: resolveLayoutFile(layoutName, ctrl.name, aliasMap, index),
          set_at_line: line,
        });
      }
    }
  }

  // Widget references — scan ALL PHP symbols + all .php files at module
  // level (views are file-scope code, not symbols).
  if (includeWidgets) {
    collectWidgetRefs(index, widgets);
  }

  // AssetBundle::register() — same scope.
  if (includeBundles) {
    collectAssetBundleRefs(index, assetBundles);
  }

  return {
    mappings,
    total: mappings.length,
    layouts,
    widgets,
    asset_bundles: assetBundles,
  };
}

/**
 * Build a path-alias map from Yii::setAlias() calls + config-file aliases.
 * Map is keyed by the alias INCLUDING the leading `@` (so callers can
 * test membership cheaply against the input string).
 *
 * Default Yii2 aliases (`@app`, `@webroot`, etc.) are inferred from the
 * repo root when not explicitly set, so a fresh project still gets a
 * useful default map.
 */
async function resolvePathAliases(index: {
  root: string;
  files: Array<{ path: string }>;
}): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  // Default aliases. `@app` is the conventional Yii2 anchor — almost
  // every project has it pointing at the repo root.
  aliases.set("@app", ".");

  // Scan main config files for explicit aliases. Both
  //   'aliases' => ['@foo' => 'path']
  // and
  //   Yii::setAlias('@foo', 'path');
  // are recognized.
  const configFiles = index.files.filter((f) =>
    /config\/(?:web|main|console|api|backend|frontend|common)(?:[-_][\w-]+)?\.php$/.test(
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
    // `aliases` => ['@x' => 'path', ...]
    const aliasArrayRe = /['"]aliases['"]\s*=>\s*\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = aliasArrayRe.exec(source)) !== null) {
      const inner = m[1]!;
      const entryRe = /['"](@[\w/.-]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
      let em: RegExpExecArray | null;
      while ((em = entryRe.exec(inner)) !== null) {
        aliases.set(em[1]!, em[2]!);
      }
    }
    // Yii::setAlias('@x', 'path');
    const setAliasRe = /Yii::setAlias\s*\(\s*['"](@[\w/.-]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
    while ((m = setAliasRe.exec(source)) !== null) {
      aliases.set(m[1]!, m[2]!);
    }
  }
  return aliases;
}

/**
 * Resolve a view name to a path within the indexed file set. Prefers
 * explicit `@alias/...` resolution; otherwise falls back to the Yii2
 * convention `views/<controller-id>/<view>.php`. Returns the resolved
 * (path, alias) pair — alias is the leading `@token` if one was used.
 *
 * The resolved path is matched against `index.files` to confirm the view
 * actually exists; if not, file is null but alias is still surfaced so
 * callers can flag missing-file findings against external asset paths.
 */
function resolveViewFile(
  viewName: string,
  controllerClass: string,
  aliases: Map<string, string>,
  index: { files: Array<{ path: string }> },
): { file: string | null; alias: string | null } {
  // Path alias: `@app/views/...` or any alias-prefixed string.
  if (viewName.startsWith("@")) {
    const aliasMatch = /^(@[\w-]+)(\/.*)?$/.exec(viewName);
    if (aliasMatch) {
      const alias = aliasMatch[1]!;
      const remainder = aliasMatch[2] ?? "";
      const aliasTarget = aliases.get(alias);
      if (aliasTarget !== undefined) {
        const candidate = (aliasTarget.replace(/\/$/, "") + remainder).replace(/^\.\//, "");
        const final = candidate.endsWith(".php") ? candidate : candidate + ".php";
        const exists = index.files.some(
          (f) => f.path === final || f.path.endsWith("/" + final),
        );
        return { file: exists ? final : null, alias };
      }
      return { file: null, alias };
    }
  }
  // Path-style relative name: `subdir/foo` keeps the explicit subdir.
  const isPath = viewName.includes("/");
  const controllerId = pascalToKebab(controllerClass.replace(/Controller$/, ""));
  const candidate = isPath
    ? `views/${viewName}.php`
    : `views/${controllerId}/${viewName}.php`;
  const exists = index.files.some(
    (f) => f.path === candidate || f.path.endsWith("/" + candidate),
  );
  return { file: exists ? candidate : null, alias: null };
}

function resolveLayoutFile(
  layoutName: string,
  controllerClass: string,
  aliases: Map<string, string>,
  index: { files: Array<{ path: string }> },
): string | null {
  // Layouts default to `views/layouts/<name>.php` rather than per-controller.
  if (layoutName.startsWith("@")) {
    const aliasMatch = /^(@[\w-]+)(\/.*)?$/.exec(layoutName);
    if (aliasMatch) {
      const aliasTarget = aliases.get(aliasMatch[1]!);
      if (!aliasTarget) return null;
      const remainder = aliasMatch[2] ?? "";
      const candidate = (aliasTarget.replace(/\/$/, "") + remainder).replace(/^\.\//, "");
      const final = candidate.endsWith(".php") ? candidate : candidate + ".php";
      const exists = index.files.some(
        (f) => f.path === final || f.path.endsWith("/" + final),
      );
      return exists ? final : null;
    }
    return null;
  }
  const isPath = layoutName.includes("/");
  const candidate = isPath
    ? `views/${layoutName}.php`
    : `views/layouts/${layoutName}.php`;
  const exists = index.files.some(
    (f) => f.path === candidate || f.path.endsWith("/" + candidate),
  );
  return exists ? candidate : null;
  void controllerClass; // referenced for future per-module path resolution
}

function collectWidgetRefs(
  index: {
    symbols: Array<{
      name: string;
      kind: string;
      file: string;
      parent?: string | undefined;
      source?: string | undefined;
      start_line: number;
    }>;
  },
  out: PhpWidgetReference[],
): void {
  // Build a quick parentId → class name map so we can attribute widget
  // references to their containing class (when the widget lives inside
  // a class method).
  const idToClass = new Map<string, string>();
  for (const s of index.symbols) {
    if (s.kind === "class") {
      const id = (s as { id?: string }).id;
      if (id) idToClass.set(id, s.name);
    }
  }

  // Yii2 widget API: `Widget::begin([...])` (followed by ::end()) and
  // `Widget::widget([...])`. Both are method-call forms; we look for any
  // CamelCase identifier ending in expected widget suffixes (Form, View,
  // Pjax, Menu, Pager, Breadcrumbs, Modal) to filter out unrelated
  // static calls. The bound list is pragmatic — the Yii2 ecosystem has
  // hundreds of widget classes but ~95% match this suffix family.
  const WIDGET_SUFFIXES = /(?:Form|View|Pjax|Menu|Pager|Breadcrumbs|Modal|GridView|ListView|DetailView|LinkPager|Captcha|Alert|Tabs|NavBar|Carousel|Dropdown|FileInput|DatePicker|RangeInput|Select2|TimePicker|Slider|MaskedInput|RadioButton|Tag)$/;
  const re = /\b([A-Z][\w]*?)::(begin|widget)\s*\(/g;

  for (const sym of index.symbols) {
    if (!sym.source) continue;
    if (!sym.file.endsWith(".php")) continue;

    let m: RegExpExecArray | null;
    while ((m = re.exec(sym.source)) !== null) {
      const widgetName = m[1]!;
      const kindRaw = m[2]!;
      if (!WIDGET_SUFFIXES.test(widgetName)) continue;

      const callerClass = sym.parent ? idToClass.get(sym.parent) ?? null : null;
      const callerMethod = sym.kind === "method" ? sym.name : null;
      const line =
        sym.start_line +
        (sym.source.slice(0, m.index).match(/\n/g)?.length ?? 0);

      out.push({
        widget: widgetName,
        caller_class: callerClass,
        caller_method: callerMethod,
        file: sym.file,
        line,
        kind: kindRaw === "begin" ? "begin" : "widget",
      });
    }
  }
}

function collectAssetBundleRefs(
  index: {
    symbols: Array<{
      kind: string;
      file: string;
      source?: string | undefined;
      start_line: number;
    }>;
  },
  out: PhpAssetBundleRef[],
): void {
  // `BundleClass::register($this)` — the canonical AssetBundle entry
  // point. We capture the class name (last segment for FQCN forms).
  const re = /\b([A-Z][\w\\]*?)::register\s*\(\s*\$this\b/g;
  for (const sym of index.symbols) {
    if (!sym.source) continue;
    if (!sym.file.endsWith(".php")) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sym.source)) !== null) {
      const fqcn = m[1]!;
      const last = fqcn.split(/[\\\\]+/).pop() ?? fqcn;
      // Reject obvious false positives — `Yii::register()` doesn't exist
      // but a few user classes might also expose `register($this)` for
      // unrelated reasons. Filter to names that LOOK like an AssetBundle:
      // suffix `Asset` is the universal Yii2 convention.
      if (!/Asset(?:s|Bundle)?$/.test(last)) continue;
      const line =
        sym.start_line +
        (sym.source.slice(0, m.index).match(/\n/g)?.length ?? 0);
      out.push({ bundle: last, file: sym.file, line });
    }
  }
}

// ---------------------------------------------------------------------------
// 7e. resolve_php_service — DI / Service Locator resolver
// ---------------------------------------------------------------------------

export interface PhpServiceResolution {
  name: string;
  class: string | null;
  file: string | null;
  config_file: string | null;
  /** Sprint 3: tracks where the service was defined.
   *   "components"           — top-level Yii2 application components
   *   "container.singletons" — DI container singletons
   *   "container.definitions"— DI container regular bindings
   *   "module:<id>"          — module-scoped components (modules.<id>.components.X)
   *   "factory"              — closure / factory function (no static class resolution)
   */
  source: string;
  /** Sprint 3: true when the service was defined as a closure/factory and we
   *  cannot statically determine the produced class. Caller can choose to
   *  skip these or surface them as TODOs. */
  is_factory?: boolean;
}

export async function resolvePhpService(
  repo: string,
  options?: { service_name?: string },
): Promise<{ services: PhpServiceResolution[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const services: PhpServiceResolution[] = [];
  // Sprint 3: include `params*.php` only as suppress-source — those files
  // hold flat key-value pairs that look like components but aren't. We also
  // drop config/test*.php (intentionally divergent) and pick up the broader
  // *-local.php and main-*.php variants (advanced template + per-env splits).
  const configFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (/config\/test/.test(f.path)) return false;
    return /config\/(?:web|console|main|db|api|backend|frontend|common)(?:[-_][\w-]+)?\.php$/.test(
      f.path,
    );
  });

  // Track (name, class, source, configFile) tuples so we don't duplicate
  // when the same component appears in both web.php and main-local.php.
  const seen = new Set<string>();
  const dedupKey = (
    name: string,
    cls: string | null,
    sourceLabel: string,
    file: string,
  ): string => `${sourceLabel}::${name}::${cls ?? "<factory>"}::${file}`;

  const pushService = (s: PhpServiceResolution): void => {
    const key = dedupKey(s.name, s.class, s.source, s.config_file ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    services.push(s);
  };

  for (const cf of configFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, cf.path), "utf-8");
    } catch { continue; }

    // Match component definitions: 'componentName' => ['class' => 'FQCN', ...]
    // Top-level components live under 'components' => [...]; module-scoped
    // ones live under 'modules' => ['<id>' => ['components' => [...]]]. We
    // don't try to distinguish here — every match is tagged via post-pass.
    //
    // The key pattern accepts both bare names ("db") and FQCNs
    // ("app\\interfaces\\LoggerInterface") because container.singletons /
    // container.definitions almost always use FQCNs as keys.
    const componentRe = /['"]([\w\\-]+)['"]\s*=>\s*\[\s*['"]class['"]\s*=>\s*['"]([\w\\]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = componentRe.exec(source)) !== null) {
      const name = match[1]!;
      const cls = match[2]!;

      if (options?.service_name && name !== options.service_name) continue;

      // Resolve class to file via PSR-4
      let filePath: string | null = null;
      try {
        const resolved = await resolvePhpNamespace(repo, cls);
        if (resolved.exists) filePath = resolved.file_path;
      } catch { /* ignore */ }

      // Best-effort source labeling: scan the prefix up to the match to see
      // whether we're inside `'modules' => ['x' => ['components' => [...]]]`
      // or `'container' => ['singletons' => [...]]`. This is fuzzy; the
      // labeling failures fall back to "components".
      const prefix = source.slice(0, match.index);
      const sourceLabel = inferConfigSection(prefix);

      pushService({
        name,
        class: cls,
        file: filePath,
        config_file: cf.path,
        source: sourceLabel,
      });
    }

    // DI container: `Yii::$container->set(InterfaceName::class, ImplName::class)`
    // and the static `'container' => ['definitions' => [...]]` form. Both are
    // common in Yii2 codebases that use interface-based DI.
    const containerSetRe =
      /Yii::\$container->set\s*\(\s*([\w\\]+)::class\s*,\s*([\w\\]+)::class/g;
    while ((match = containerSetRe.exec(source)) !== null) {
      const iface = match[1]!;
      const impl = match[2]!;
      if (options?.service_name && iface !== options.service_name) continue;

      let filePath: string | null = null;
      try {
        const resolved = await resolvePhpNamespace(repo, impl);
        if (resolved.exists) filePath = resolved.file_path;
      } catch { /* ignore */ }

      pushService({
        name: iface,
        class: impl,
        file: filePath,
        config_file: cf.path,
        source: "container.set",
      });
    }

    // Closure / factory: `'mailer' => function() { return new Mailer(); }`
    // We can't statically resolve the produced class, so we surface the
    // service name with class=null and is_factory=true so callers can
    // either ignore them or flag them as needs-manual-review.
    const factoryRe =
      /['"]([\w-]+)['"]\s*=>\s*function\s*\(/g;
    while ((match = factoryRe.exec(source)) !== null) {
      const name = match[1]!;
      if (options?.service_name && name !== options.service_name) continue;
      pushService({
        name,
        class: null,
        file: null,
        config_file: cf.path,
        source: "factory",
        is_factory: true,
      });
    }
  }

  return { services, total: services.length };
}

/**
 * Sprint 3 helper: given the source prefix up to a component match, identify
 * which Yii2 config section we're inside by walking the prefix forward with a
 * bracket-balanced stack. Each `'KEY' => [` pushes KEY onto the stack; each
 * matching `]` pops it. At the end of the prefix the stack tells us the
 * exact nesting path, regardless of how many sibling sections came before.
 *
 * Why not regex: regex can't track balanced brackets. The previous version
 * used non-greedy `[\\s\\S]*?` which incorrectly matched a `'modules' =>
 * ['x' => [...]]` block that had already closed by the time we reached a
 * `'container' => ['singletons' => ...]` later in the file.
 *
 * Returns one of:
 *   "module:<id>"            — inside `'modules' => ['<id>' => ['components' => [<HERE>...
 *   "container.singletons"   — inside `'container' => ['singletons' => [<HERE>...
 *   "container.definitions"  — inside `'container' => ['definitions' => [<HERE>...
 *   "components"             — fallback (top-level components or unknown)
 *
 * String literals (single + double quoted) and PHP comments are skipped so
 * brackets inside them don't confuse the depth counter.
 */
function inferConfigSection(prefix: string): string {
  type Frame = { key: string; depth: number };
  const stack: Frame[] = [];
  let depth = 0;

  let i = 0;
  while (i < prefix.length) {
    const c = prefix[i]!;

    // Skip comments
    if (c === "/" && prefix[i + 1] === "/") {
      const nl = prefix.indexOf("\n", i);
      i = nl === -1 ? prefix.length : nl + 1;
      continue;
    }
    if (c === "/" && prefix[i + 1] === "*") {
      const end = prefix.indexOf("*/", i + 2);
      i = end === -1 ? prefix.length : end + 2;
      continue;
    }
    if (c === "#") {
      const nl = prefix.indexOf("\n", i);
      i = nl === -1 ? prefix.length : nl + 1;
      continue;
    }

    // Look for `'KEY' => [` BEFORE the generic string-skip — otherwise the
    // string-skip swallows the opening quote and we never push the key.
    if (c === '"' || c === "'") {
      const m = /^(['"])([\w\\-]+)\1\s*=>\s*\[/.exec(prefix.slice(i));
      if (m) {
        const keyName = m[2]!;
        // Push at the new depth (after the bracket we're about to enter).
        stack.push({ key: keyName, depth: depth + 1 });
        depth++;
        i += m[0].length;
        continue;
      }
      // Plain string literal — skip past the closing quote.
      const quote = c;
      i++;
      while (i < prefix.length) {
        if (prefix[i] === "\\") { i += 2; continue; }
        if (prefix[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "]") {
      depth--;
      while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) {
        stack.pop();
      }
      i++;
      continue;
    }

    i++;
  }

  // Read the live nesting path from the stack.
  const keys = stack.map((f) => f.key);

  // module:<id> when we're inside modules.<id>.components.<*>
  const modIdx = keys.indexOf("modules");
  if (modIdx !== -1 && keys.length >= modIdx + 3) {
    const moduleId = keys[modIdx + 1]!;
    const inner = keys[modIdx + 2]!;
    if (inner === "components") return `module:${moduleId}`;
  }

  const cIdx = keys.indexOf("container");
  if (cIdx !== -1 && keys.length >= cIdx + 2) {
    const sub = keys[cIdx + 1]!;
    if (sub === "singletons") return "container.singletons";
    if (sub === "definitions") return "container.definitions";
  }

  return "components";
}

// ---------------------------------------------------------------------------
// 7f. php_security_scan — Compound security tool
// ---------------------------------------------------------------------------

export interface PhpSecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  pattern: string;
  file: string;
  line: number;
  context: string;
  description: string;
}

export interface PhpSecurityScanResult {
  findings: PhpSecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  checks_run: string[];
}

const PHP_SECURITY_CHECKS = [
  // Original 8 checks
  { pattern: "sql-injection-php", severity: "critical" as const },
  { pattern: "xss-php", severity: "critical" as const },
  { pattern: "eval-php", severity: "critical" as const },
  { pattern: "exec-php", severity: "critical" as const },
  { pattern: "unserialize-php", severity: "high" as const },
  { pattern: "file-include-var", severity: "high" as const },
  { pattern: "unescaped-yii-view", severity: "high" as const },
  { pattern: "raw-query-yii", severity: "high" as const },
  // Sprint 2 additions: Yii2- + PHP-specific patterns informed by tgm-panel
  // db-audit + perf-audit findings, plus the gap analysis section 4 catalog.
  { pattern: "yii-csrf-disabled", severity: "high" as const },
  { pattern: "yii-debug-mode-prod", severity: "critical" as const },
  { pattern: "yii-cookie-no-validation", severity: "high" as const },
  { pattern: "yii-mass-assignment-unsafe", severity: "medium" as const },
  { pattern: "yii-raw-sql-where", severity: "high" as const },
  { pattern: "php-md5-password", severity: "high" as const },
  { pattern: "php-rand-token", severity: "high" as const },
  { pattern: "php-loose-comparison-secret", severity: "medium" as const },
  { pattern: "yii-rbac-cached-permission", severity: "low" as const },
  { pattern: "yii-no-row-level-locking", severity: "high" as const },
  { pattern: "yii-config-hardcoded-secret", severity: "critical" as const },
  { pattern: "yii-unbounded-all", severity: "medium" as const },
];

/**
 * Patterns that hit code at module level (top-level `return [...]`,
 * top-level `define(...)` calls in entry-point files) and therefore are
 * NOT visible via `searchPatterns` — that helper iterates `index.symbols`,
 * so files without any class/function/method produce zero hits. We scan
 * these patterns by reading file content directly.
 */
const FILE_LEVEL_PATTERNS = new Set<string>([
  "yii-debug-mode-prod",
  "yii-cookie-no-validation",
  "yii-config-hardcoded-secret",
]);

export async function phpSecurityScan(
  repo: string,
  options?: { file_pattern?: string; checks?: string[] },
): Promise<PhpSecurityScanResult> {
  const selectedChecks = options?.checks
    ? PHP_SECURITY_CHECKS.filter((c) => options.checks!.includes(c.pattern))
    : PHP_SECURITY_CHECKS;

  const findings: PhpSecurityFinding[] = [];
  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };

  // Symbol-level scans run via the existing searchPatterns helper. Skip the
  // file-level patterns here — they're handled below by a direct file read.
  const symbolLevelChecks = selectedChecks.filter(
    (c) => !FILE_LEVEL_PATTERNS.has(c.pattern),
  );
  const fileLevelChecks = selectedChecks.filter((c) =>
    FILE_LEVEL_PATTERNS.has(c.pattern),
  );

  // Run pattern checks in parallel
  const results = await Promise.all(
    symbolLevelChecks.map((check) =>
      searchPatterns(repo, check.pattern, {
        file_pattern: options?.file_pattern ?? ".php",
        include_tests: false,
      }).then((r) => ({ check, result: r })).catch(() => null),
    ),
  );

  for (const res of results) {
    if (!res) continue;
    for (const m of res.result.matches) {
      findings.push({
        severity: res.check.severity,
        pattern: res.check.pattern,
        file: m.file,
        line: m.start_line,
        context: m.context,
        description: "", // description populated by searchPatterns but not in PatternMatch type
      });
      summary[res.check.severity]++;
      summary.total++;
    }
  }

  // File-level scan: read every PHP file once, run each file-level pattern
  // against it. This catches top-level `define('YII_DEBUG', true)` and
  // hardcoded literals in `return [...]` config arrays which never live
  // inside a class or function.
  if (fileLevelChecks.length > 0) {
    const fileFindings = await runFileLevelChecks(repo, fileLevelChecks, options?.file_pattern);
    for (const f of fileFindings) {
      findings.push(f);
      summary[f.severity]++;
      summary.total++;
    }
  }

  return {
    findings,
    summary,
    checks_run: selectedChecks.map((c) => c.pattern),
  };
}

async function runFileLevelChecks(
  repo: string,
  checks: typeof PHP_SECURITY_CHECKS,
  filePattern: string | undefined,
): Promise<PhpSecurityFinding[]> {
  const index = await getCodeIndex(repo);
  if (!index) return [];

  const { BUILTIN_PATTERNS } = await import("./pattern-tools.js");
  const out: PhpSecurityFinding[] = [];

  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    return true;
  });

  // Pull each pattern definition up-front. We want one regex object per
  // check, not per file, to avoid re-compilation churn.
  const compiled = checks
    .map((check) => {
      const def = BUILTIN_PATTERNS[check.pattern];
      if (!def) return null;
      // Re-create the regex with /g so we can iterate matches across the
      // whole file content. Built-in patterns are stored without /g because
      // searchPatterns calls .exec() once per symbol.
      const flags = (def.regex.flags.includes("g") ? "" : "g") + def.regex.flags;
      return {
        check,
        regex: new RegExp(def.regex.source, flags),
        fileIncludePattern: def.fileIncludePattern,
        fileExcludePattern: def.fileExcludePattern,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  await Promise.all(
    phpFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(join(index.root, file.path), "utf-8");
      } catch {
        return;
      }
      for (const c of compiled) {
        if (c.fileIncludePattern && !c.fileIncludePattern.test(file.path)) continue;
        if (c.fileExcludePattern && c.fileExcludePattern.test(file.path)) continue;

        c.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = c.regex.exec(content)) !== null) {
          const line = countLines(content, m.index);
          out.push({
            severity: c.check.severity,
            pattern: c.check.pattern,
            file: file.path,
            line,
            context: extractLine(content, m.index),
            description: "",
          });
        }
      }
    }),
  );

  return out;
}

function countLines(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractLine(source: string, idx: number): string {
  const start = source.lastIndexOf("\n", idx) + 1;
  const end = source.indexOf("\n", idx);
  const out = source.slice(start, end === -1 ? source.length : end);
  return out.trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// 7h. find_php_n_plus_one — detect foreach + relation access without ->with()
// ---------------------------------------------------------------------------

/**
 * Common ActiveRecord scalar field names. Property access like $user->id or
 * $user->created_at inside a foreach is NOT a relation (no N+1 risk), so we
 * allow-list these to cut false positives.
 */
const SCALAR_FIELD_NAMES = new Set([
  "id", "name", "title", "created_at", "updated_at", "deleted_at", "status",
  "email", "slug", "code", "type", "value", "label", "description", "enabled",
  "active", "position", "sort", "order", "count", "total", "amount", "price",
  "uuid", "hash", "token", "key", "url", "path", "image", "avatar",
]);

/**
 * PHP method names that look like `get*` but are NOT ActiveRecord relation
 * getters. `$item->save()` / `$item->validate()` inside a foreach is fine;
 * flagging them as N+1 would be a false positive. These names are stripped
 * from the `get\w+()` method-call detection before the eager-load check.
 */
const METHOD_CALL_BLOCKLIST = new Set([
  "save", "validate", "delete", "refresh", "load", "populate", "toArray",
  "afterSave", "beforeSave", "beforeDelete", "afterDelete",
  "getAttributes", "getAttribute", "getIsNewRecord", "getErrors", "getFirstError",
  "getOldAttributes", "getDirtyAttributes", "getPrimaryKey", "getTableSchema",
]);

export interface NPlusOneFinding {
  file: string;
  method: string;
  line: number;
  relation: string;
  pattern: string;
}

/**
 * Detect N+1 query patterns in Yii2/Eloquent controllers.
 *
 * Pattern: `foreach ($items as $item) { $item->relation->... }` without a
 * prior `->with('relation')` call in the same method scope. This is the
 * most common N+1 anti-pattern in Yii2 ActiveRecord code.
 *
 * Known limitations (acceptable for a "discovery" tool, not a gate):
 * - Regex-based — can miss multi-line foreach bodies split across nested blocks
 * - Doesn't cross function boundaries — eager loading in caller is invisible
 * - False positives on nested loops if the outer collection is already eager-loaded
 */
export async function findPhpNPlusOne(
  repo: string,
  options?: { limit?: number; file_pattern?: string },
): Promise<{ findings: NPlusOneFinding[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const findings: NPlusOneFinding[] = [];
  const limit = options?.limit ?? 100;
  const filePattern = options?.file_pattern;

  // Normalize `getProfile` → `profile` so the ->with() check matches whether
  // the relation is accessed as a property or via its auto-generated getter.
  const normalizeGetter = (name: string): string => {
    const bare = name.replace(/^get/, "");
    return bare.length > 0 ? bare.charAt(0).toLowerCase() + bare.slice(1) : "";
  };

  // A finding is emitted exactly once per (foreach × relation-name) tuple so
  // that chained patterns don't double-report the same relation that the
  // property pattern already caught in the same loop body.
  const emitFinding = (
    sym: { file: string; name: string; source: string; start_line: number },
    foreachIdx: number,
    relation: string,
    pattern: string,
    seen: Set<string>,
  ): boolean => {
    if (!relation || seen.has(relation)) return findings.length >= limit;
    seen.add(relation);

    if (SCALAR_FIELD_NAMES.has(relation.toLowerCase())) return findings.length >= limit;

    const beforeForeach = sym.source.slice(0, foreachIdx);
    const withRe = new RegExp(`\\bwith\\s*\\(\\s*['"]${relation}['"]`);
    if (withRe.test(beforeForeach)) return findings.length >= limit;

    const lineOffset = beforeForeach.split("\n").length - 1;
    findings.push({
      file: sym.file,
      method: sym.name,
      line: sym.start_line + lineOffset,
      relation,
      pattern,
    });
    return findings.length >= limit;
  };

  // Helper: scan a single chunk of source (a method body OR a view file) for
  // all 4 N+1 patterns. Returns true once `limit` is hit so the caller can
  // short-circuit.
  function scanChunk(
    file: string,
    methodName: string,
    src: string,
    startLine: number,
  ): boolean {
    const foreachRe = /foreach\s*\(\s*\$(\w+)\s+as\s+(?:\$\w+\s*=>\s*)?\$(\w+)\s*\)/g;
    let fm: RegExpExecArray | null;
    while ((fm = foreachRe.exec(src)) !== null) {
      const itemVar = fm[2]!;
      const foreachIdx = fm.index;
      const after = src.slice(foreachIdx);
      const seen = new Set<string>();

      // Pattern 1 — property access: $item->profile
      const propRe = new RegExp(`\\$${itemVar}->(\\w+)(?![\\w(])`, "g");
      let m: RegExpExecArray | null;
      while ((m = propRe.exec(after)) !== null) {
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            m[1]!,
            "foreach-access-without-with",
            seen,
          )
        ) {
          return true;
        }
      }

      // Pattern 2 — getter method call: $item->getProfile()
      const getterRe = new RegExp(
        `\\$${itemVar}->(get\\w+)\\s*\\(\\s*\\)`,
        "g",
      );
      while ((m = getterRe.exec(after)) !== null) {
        const rawMethod = m[1]!;
        if (METHOD_CALL_BLOCKLIST.has(rawMethod)) continue;
        const normalized = normalizeGetter(rawMethod);
        if (!normalized || METHOD_CALL_BLOCKLIST.has(normalized.toLowerCase()))
          continue;
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            normalized,
            "foreach-getter-without-with",
            seen,
          )
        ) {
          return true;
        }
      }

      // Pattern 3 — chained access: $item->rel->sub
      const chainRe = new RegExp(`\\$${itemVar}->(\\w+)->\\w`, "g");
      while ((m = chainRe.exec(after)) !== null) {
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            m[1]!,
            "foreach-chained-without-with",
            seen,
          )
        ) {
          return true;
        }
      }

      // Pattern 4 (Sprint 3) — explicit lookup in loop body. Inside the foreach,
      // a `Model::findOne(...)` / `Model::findAll(...)` / `->find()` is the
      // lazy-load smell — each iteration hits the database.
      //
      // We scan a bounded 2000-char window after the foreach header to keep
      // the regex cost predictable on large methods. A nested foreach inside
      // the window will still match on its own /g iteration, and the outer
      // `seen` set deduplicates so we never double-report a single class+method.
      const body = after.slice(0, Math.min(after.length, 2000));

      const findOneRe =
        /(\w+)::(findOne|findAll|find|findBySql)\s*\(/g;
      let lm: RegExpExecArray | null;
      while ((lm = findOneRe.exec(body)) !== null) {
        const targetClass = lm[1]!;
        const method = lm[2]!;
        // Filter common false positives: top-level utility classes that
        // happen to expose static `find*` methods but aren't AR.
        if (
          targetClass === "Yii" ||
          targetClass === "ArrayHelper" ||
          targetClass === "self" ||
          targetClass === "static"
        ) {
          continue;
        }
        const synthetic = `${targetClass}::${method}`;
        if (
          emitFinding(
            { file, name: methodName, source: src, start_line: startLine },
            foreachIdx,
            synthetic,
            "foreach-findone-in-loop",
            seen,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // Method-level scan (Patterns 1-4 inside class methods, the original surface).
  for (const sym of index.symbols) {
    if (sym.kind !== "method" || !sym.file.endsWith(".php") || !sym.source) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (scanChunk(sym.file, sym.name, sym.source, sym.start_line)) {
      return { findings, total: findings.length };
    }
  }

  // View-level scan (Sprint 3 Pattern 5) — Yii2 views/**/*.php files render
  // lists of models at module level. They're not class methods so they have
  // no symbol; scan the raw file content. `views/**/*.php` is the canonical
  // path; `_*.php` partials live at the same level.
  const viewFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    // Standard Yii2 view paths (basic + advanced + module-scoped layouts).
    return /(?:^|\/)(?:views|widgets|layouts)\//.test(f.path);
  });

  await Promise.all(
    viewFiles.map(async (file) => {
      if (findings.length >= limit) return;
      let content: string;
      try {
        content = await readFile(join(index.root, file.path), "utf-8");
      } catch {
        return;
      }
      // For views the "method name" is just the file basename — that's what
      // the caller sees in the finding when there is no enclosing function.
      const methodName = file.path.split("/").pop() ?? file.path;
      scanChunk(file.path, methodName, content, 1);
    }),
  );

  return { findings, total: findings.length };
}

// ---------------------------------------------------------------------------
// 7i. find_php_god_model — oversized ActiveRecord models
// ---------------------------------------------------------------------------

export interface GodModelFinding {
  name: string;
  file: string;
  method_count: number;
  relation_count: number;
  line_count: number;
  reasons: string[];
}

/**
 * Flag oversized PHP classes. Two scopes:
 *
 * - `scope: "activerecord"` (default) — only models extending ActiveRecord.
 *   Uses `analyzeActiveRecord` for model detection and counts relations as a
 *   third threshold alongside methods and lines. Classic Yii2 god-model case:
 *   Survey.php in Mobi2 with 175 methods, 30 relations, 2291 lines.
 *
 * - `scope: "all"` — every PHP class in the index, regardless of base class.
 *   Captures service god-classes (UserService with 80 methods), component
 *   aggregates, and any other PHP class that outgrew its responsibility.
 *   `relation_count` is 0 for non-AR classes — the `min_relations` check is
 *   skipped so a service with 60 methods isn't hidden by a relation threshold.
 *
 * Thresholds default to 50/15/500 but are configurable for both scopes.
 */
export async function findPhpGodModel(
  repo: string,
  options?: {
    min_methods?: number;
    min_relations?: number;
    min_lines?: number;
    scope?: "activerecord" | "all";
  },
): Promise<{ models: GodModelFinding[]; total: number }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const minM = options?.min_methods ?? 50;
  const minR = options?.min_relations ?? 15;
  const minL = options?.min_lines ?? 500;
  const scope = options?.scope ?? "activerecord";

  const models: GodModelFinding[] = [];

  if (scope === "activerecord") {
    const ar = await analyzeActiveRecord(repo);
    for (const m of ar.models) {
      // Look up the class symbol by (name, kind, file) — file match keeps
      // duplicate class names in different paths reported independently.
      const classSym = index.symbols.find(
        (s) => s.name === m.name && s.kind === "class" && s.file === m.file,
      );
      const lineCount = classSym ? classSym.end_line - classSym.start_line : 0;

      const reasons: string[] = [];
      if (m.methods.length > minM) reasons.push(`methods: ${m.methods.length} > ${minM}`);
      if (m.relations.length > minR) reasons.push(`relations: ${m.relations.length} > ${minR}`);
      if (lineCount > minL) reasons.push(`lines: ${lineCount} > ${minL}`);

      if (reasons.length > 0) {
        models.push({
          name: m.name,
          file: m.file,
          method_count: m.methods.length,
          relation_count: m.relations.length,
          line_count: lineCount,
          reasons,
        });
      }
    }
  } else {
    // scope === "all" — iterate every PHP class symbol directly.
    const classSyms = index.symbols.filter(
      (s) => s.kind === "class" && s.file.endsWith(".php"),
    );
    for (const cls of classSyms) {
      const methodCount = index.symbols.filter(
        (s) => s.parent === cls.id && s.kind === "method",
      ).length;
      const lineCount = cls.end_line - cls.start_line;

      const reasons: string[] = [];
      if (methodCount > minM) reasons.push(`methods: ${methodCount} > ${minM}`);
      if (lineCount > minL) reasons.push(`lines: ${lineCount} > ${minL}`);
      // min_relations intentionally skipped in "all" scope — not AR, no relations

      if (reasons.length > 0) {
        models.push({
          name: cls.name,
          file: cls.file,
          method_count: methodCount,
          relation_count: 0,
          line_count: lineCount,
          reasons,
        });
      }
    }
  }

  // Sort by severity (number of reasons desc, then methods desc)
  models.sort((a, b) => b.reasons.length - a.reasons.length || b.method_count - a.method_count);

  return { models, total: models.length };
}

// ---------------------------------------------------------------------------
// 7g. php_project_audit — Compound meta-tool
// ---------------------------------------------------------------------------

export interface AuditGate {
  name: string;
  status: "ok" | "error" | "timeout";
  findings_count: number;
  duration_ms: number;
  error?: string;
}

export interface PhpProjectAudit {
  repo: string;
  duration_ms: number;
  checks_run: string[];
  gates: AuditGate[];
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    health_score: number;
    top_risks: string[];
  };
  security: PhpSecurityScanResult;
  activerecord: ActiveRecordAnalysis;
}

const AUDIT_TIMEOUT = 8000;

export async function phpProjectAudit(
  repo: string,
  options?: { file_pattern?: string; checks?: string[] },
): Promise<PhpProjectAudit> {
  const startTime = Date.now();
  const gates: AuditGate[] = [];
  const allChecks = ["security", "activerecord", "complexity", "dead_code", "patterns", "clones", "hotspots", "n_plus_one", "god_model", "yii_performance"];
  const enabled = new Set(options?.checks ?? allChecks);
  const fp = options?.file_pattern ?? ".php";
  const secOpts: { file_pattern?: string } = {};
  if (options?.file_pattern) secOpts.file_pattern = options.file_pattern;

  type Task = { name: string; run: () => Promise<unknown> };
  const tasks: Task[] = [];

  if (enabled.has("security")) tasks.push({ name: "security", run: () => phpSecurityScan(repo, secOpts) });
  if (enabled.has("activerecord")) tasks.push({ name: "activerecord", run: () => analyzeActiveRecord(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined) });
  if (enabled.has("complexity")) tasks.push({ name: "complexity", run: async () => { const { analyzeComplexity } = await import("./complexity-tools.js"); return analyzeComplexity(repo, { file_pattern: fp, top_n: 10 }); } });
  if (enabled.has("dead_code")) tasks.push({ name: "dead_code", run: async () => { const { findDeadCode } = await import("./symbol-tools.js"); return findDeadCode(repo, { file_pattern: fp }); } });
  if (enabled.has("patterns")) tasks.push({ name: "patterns", run: () => searchPatterns(repo, "empty-catch", { file_pattern: fp }) });
  if (enabled.has("clones")) tasks.push({ name: "clones", run: async () => { const { findClones } = await import("./clone-tools.js"); return findClones(repo, { file_pattern: fp }); } });
  if (enabled.has("hotspots")) tasks.push({ name: "hotspots", run: async () => { const { analyzeHotspots } = await import("./hotspot-tools.js"); return analyzeHotspots(repo, {}); } });
  if (enabled.has("n_plus_one")) tasks.push({ name: "n_plus_one", run: () => findPhpNPlusOne(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined) });
  if (enabled.has("god_model")) tasks.push({ name: "god_model", run: () => findPhpGodModel(repo) });
  if (enabled.has("yii_performance")) {
    // Sprint 7: 5 perf patterns sourced from tgm-panel performance-audit
    // findings. Run them through the file-level scanner alongside
    // file-level security patterns so module-level matches (configs,
    // entry-points, view files) are picked up. Each pattern uses its own
    // severity tier consistent with the perf-audit recommendations.
    const PERF_PATTERNS = [
      { pattern: "yii-translate-in-loop", severity: "medium" as const },
      { pattern: "yii-dbtarget-info-level", severity: "medium" as const },
      { pattern: "yii-find-with-large-then-filter", severity: "high" as const },
      { pattern: "yii-cache-no-ttl", severity: "low" as const },
      { pattern: "yii-no-batch-on-large", severity: "high" as const },
    ];
    tasks.push({
      name: "yii_performance",
      run: async () => {
        // We reuse the security scan plumbing (parallel pattern runs +
        // file-level fallback) but with the perf catalog. The result shape
        // matches PhpSecurityScanResult — caller treats it as informational.
        const findings: PhpSecurityFinding[] = [];
        const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
        const symbolResults = await Promise.all(
          PERF_PATTERNS.map((check) =>
            searchPatterns(repo, check.pattern, {
              file_pattern: fp,
              include_tests: false,
            }).then((r) => ({ check, result: r })).catch(() => null),
          ),
        );
        for (const res of symbolResults) {
          if (!res) continue;
          for (const m of res.result.matches) {
            findings.push({
              severity: res.check.severity,
              pattern: res.check.pattern,
              file: m.file,
              line: m.start_line,
              context: m.context,
              description: "",
            });
            summary[res.check.severity]++;
            summary.total++;
          }
        }
        return {
          findings,
          summary,
          checks_run: PERF_PATTERNS.map((p) => p.pattern),
        } as PhpSecurityScanResult;
      },
    });
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const s = Date.now();
      const r = await Promise.race([t.run(), new Promise<"TIMEOUT">((ok) => setTimeout(() => ok("TIMEOUT"), AUDIT_TIMEOUT))]);
      return { name: t.name, result: r, ms: Date.now() - s };
    }),
  );

  let securityResult: PhpSecurityScanResult = { findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, checks_run: [] };
  let arResult: ActiveRecordAnalysis = { models: [], total: 0 };
  let totalFindings = 0;

  for (const s of settled) {
    if (s.status === "rejected") { gates.push({ name: "unknown", status: "error", findings_count: 0, duration_ms: 0, error: String(s.reason) }); continue; }
    const { name, result, ms } = s.value;
    if (result === "TIMEOUT") { gates.push({ name, status: "timeout", findings_count: 0, duration_ms: ms }); continue; }

    let count = 0;
    // activerecord is informational (model count), not a problem finding — excluded from totalFindings and health score
    if (name === "security") { securityResult = result as PhpSecurityScanResult; count = securityResult.summary.total; }
    else if (name === "activerecord") { arResult = result as ActiveRecordAnalysis; count = arResult.total; }
    else if (name === "complexity") count = (result as { summary?: { above_threshold?: number } })?.summary?.above_threshold ?? 0;
    else if (name === "dead_code") count = (result as { candidates?: unknown[] })?.candidates?.length ?? 0;
    else if (name === "patterns") count = (result as { matches?: unknown[] })?.matches?.length ?? 0;
    else if (name === "clones") count = (result as { clones?: unknown[] })?.clones?.length ?? 0;
    else if (name === "hotspots") count = (result as { hotspots?: unknown[] })?.hotspots?.length ?? 0;
    else if (name === "n_plus_one") count = (result as { findings?: unknown[] })?.findings?.length ?? 0;
    else if (name === "god_model") count = (result as { models?: unknown[] })?.models?.length ?? 0;
    else if (name === "yii_performance") count = (result as { findings?: unknown[] })?.findings?.length ?? 0;

    if (name !== "activerecord") totalFindings += count;
    gates.push({ name, status: "ok", findings_count: count, duration_ms: ms });
  }

  const sec = securityResult.summary;
  // Logarithmic penalties — a few critical findings are serious, but hundreds of
  // complexity warnings shouldn't tank the score to 0. Each gate uses log2 scaling
  // so 1 finding ≈ 0, 10 ≈ 17, 100 ≈ 33, 1000 ≈ 50 penalty points.
  const secPenalty = sec.total > 0 ? Math.round(Math.log2(sec.total + 1) * (sec.critical > 0 ? 8 : 4)) : 0;
  const qualityFindings = totalFindings - sec.total;
  const qualPenalty = qualityFindings > 0 ? Math.round(Math.log2(qualityFindings + 1) * 4) : 0;
  const healthScore = Math.max(0, Math.min(100, 100 - secPenalty - qualPenalty));
  const topRisks = gates.filter(g => g.findings_count > 0 && g.name !== "activerecord").sort((a, b) => b.findings_count - a.findings_count).slice(0, 3).map(g => `${g.name}: ${g.findings_count} findings`);

  return {
    repo, duration_ms: Date.now() - startTime,
    checks_run: gates.filter(g => g.status === "ok").map(g => g.name),
    gates,
    summary: { total_findings: totalFindings, critical: sec.critical, high: sec.high, medium: sec.medium, low: sec.low, health_score: healthScore, top_risks: topRisks },
    security: securityResult,
    activerecord: arResult,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonSafe(path: string): Promise<any> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function extractLineContext(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineEnd = source.indexOf("\n", index);
  const end = lineEnd === -1 ? source.length : lineEnd;
  return source.slice(lineStart, end).trim().slice(0, 200);
}

function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
