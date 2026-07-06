/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getCodeIndex } from "./index-tools.js";

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
    const aliasMatch = resolveAliasPrefix(viewName, aliases);
    if (aliasMatch) {
      if (aliasMatch.target !== undefined) {
        const candidate = (aliasMatch.target.replace(/\/$/, "") + aliasMatch.remainder).replace(/^\.\//, "");
        const final = candidate.endsWith(".php") ? candidate : candidate + ".php";
        const exists = index.files.some(
          (f) => f.path === final || f.path.endsWith("/" + final),
        );
        return { file: exists ? final : null, alias: aliasMatch.alias };
      }
      return { file: null, alias: aliasMatch.alias };
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
    const aliasMatch = resolveAliasPrefix(layoutName, aliases);
    if (aliasMatch) {
      if (!aliasMatch.target) return null;
      const candidate = (aliasMatch.target.replace(/\/$/, "") + aliasMatch.remainder).replace(/^\.\//, "");
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

function resolveAliasPrefix(
  value: string,
  aliases: Map<string, string>,
): { alias: string; target: string | undefined; remainder: string } | null {
  const configured = [...aliases.keys()]
    .filter((alias) => value === alias || value.startsWith(alias + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (configured) {
    return {
      alias: configured,
      target: aliases.get(configured),
      remainder: value.slice(configured.length),
    };
  }

  const fallback = /^(@[\w-]+)(\/.*)?$/.exec(value);
  if (!fallback) return null;
  return {
    alias: fallback[1]!,
    target: undefined,
    remainder: fallback[2] ?? "",
  };
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

function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
