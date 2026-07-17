import type { PhpConventions, Yii2Conventions } from "./project-profile-types.js";

export function extractPhpConventions(
  files: { path: string }[],
): PhpConventions {
  const controllers: PhpConventions["controllers"] = [];
  const middleware: PhpConventions["middleware"] = [];
  const models: PhpConventions["models"] = [];
  const routes_files: string[] = [];
  let migrations_count = 0;

  for (const f of files) {
    const name = f.path.split("/").pop()?.replace(/\.php$/, "") ?? "";

    if (/Controller\.php$/.test(f.path)) {
      controllers.push({ name, path: f.path });
    }
    if (/(^|\/)[Mm]iddleware\//.test(f.path) && f.path.endsWith(".php")) {
      middleware.push({ name, path: f.path });
    }
    if (/(^|\/)[Mm]odels?\//.test(f.path) && f.path.endsWith(".php")) {
      models.push({ name, path: f.path });
    }
    if (/(^|\/)routes\//.test(f.path) && f.path.endsWith(".php")) {
      routes_files.push(f.path);
    }
    if (/(^|\/)migrations?\//.test(f.path)) {
      migrations_count++;
    }
  }

  return { controllers, middleware, models, routes_files, migrations_count };
}

// ---------------------------------------------------------------------------
// Yii2 Convention Extractor
// ---------------------------------------------------------------------------

export function extractYii2Conventions(
  files: { path: string }[],
): Yii2Conventions {
  const base = extractPhpConventions(files);
  const modules: Yii2Conventions["modules"] = [];
  const widgets: Yii2Conventions["widgets"] = [];
  const behaviors: Yii2Conventions["behaviors"] = [];
  const components: Yii2Conventions["components"] = [];
  const assets: Yii2Conventions["assets"] = [];
  const config_files: string[] = [];

  for (const f of files) {
    const name = f.path.split("/").pop()?.replace(/\.php$/, "") ?? "";

    // Modules: Module.php in modules/*/ directories
    if (/(^|\/)modules\/[^/]+\/Module\.php$/.test(f.path)) {
      modules.push({ name, path: f.path });
    }

    // Widgets: files in widgets/ directories or named *Widget.php
    if ((/(^|\/)widgets\//.test(f.path) || /Widget\.php$/.test(f.path)) && f.path.endsWith(".php")) {
      widgets.push({ name, path: f.path });
    }

    // Behaviors: files in behaviors/ directories or named *Behavior.php
    if ((/(^|\/)behaviors\//.test(f.path) || /Behavior\.php$/.test(f.path)) && f.path.endsWith(".php")) {
      behaviors.push({ name, path: f.path });
    }

    // Components: files in components/ directory
    if (/(^|\/)components\//.test(f.path) && f.path.endsWith(".php")) {
      components.push({ name, path: f.path });
    }

    // Assets: files named *Asset.php in assets/ directory
    if (/(^|\/)assets\//.test(f.path) && /Asset\.php$/.test(f.path)) {
      assets.push({ name, path: f.path });
    }

    // Config files
    if (/config\/(web|console|db|params|main|test)\.php$/.test(f.path)) {
      config_files.push(f.path);
    }
  }

  return {
    ...base,
    framework_type: "yii2",
    modules,
    widgets,
    behaviors,
    components,
    assets,
    config_files,
  };
}
