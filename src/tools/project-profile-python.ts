import type { PythonConventions } from "./project-profile-types.js";

export function extractPythonConventions(
  files: { path: string }[],
): PythonConventions {
  const routers: PythonConventions["routers"] = [];
  const middlewareSet = new Set<string>();
  let models_dir: string | null = null;
  let framework_type: PythonConventions["framework_type"] = null;

  for (const f of files) {
    // FastAPI routers
    if (/router\.py$|routes?\.py$/.test(f.path)) {
      routers.push({ path: f.path, file: f.path });
      if (!framework_type) framework_type = "fastapi";
    }
    // Django views/urls
    if (/views\.py$|urls\.py$/.test(f.path)) {
      routers.push({ path: f.path, file: f.path });
      if (!framework_type) framework_type = "django";
    }
    // Flask blueprints
    if (/blueprint/.test(f.path)) {
      routers.push({ path: f.path, file: f.path });
      if (!framework_type) framework_type = "flask";
    }
    // Middleware
    if (/middleware/.test(f.path) && f.path.endsWith(".py")) {
      middlewareSet.add(f.path);
    }
    // Models
    if (/models?\.py$/.test(f.path) && !models_dir) {
      const dir = f.path.split("/").slice(0, -1).join("/");
      models_dir = dir || null;
    }
  }

  // Test framework detection
  let test_framework: string | null = null;
  if (files.some((f) => /conftest\.py$/.test(f.path) || /test_.*\.py$/.test(f.path))) {
    test_framework = "pytest";
  } else if (files.some((f) => /tests?\.py$/.test(f.path))) {
    test_framework = "unittest";
  }

  return {
    framework_type,
    routers,
    middleware: [...middlewareSet],
    models_dir,
    test_framework,
  };
}
