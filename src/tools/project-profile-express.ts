import type { ExpressConventions } from "./project-profile-types.js";

export function extractExpressConventions(
  source: string,
  filePath: string,
): ExpressConventions {
  const lines = source.split("\n");
  const middleware: ExpressConventions["middleware"] = [];
  const routers: ExpressConventions["routers"] = [];
  const error_handlers: ExpressConventions["error_handlers"] = [];

  // Import map
  const importMap = new Map<string, string>();
  for (const line of lines) {
    const req = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (req) importMap.set(req[1]!, req[2]!);
    const imp = line.match(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (imp) {
      const names = imp[1] ? imp[1].split(",").map((n) => n.trim()) : [imp[2]!];
      for (const n of names) importMap.set(n, imp[3]!);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // app.use(middleware)
    const useMatch = line.match(/app\.use\s*\(\s*(\w+)\s*\)/);
    if (useMatch) {
      middleware.push({ name: useMatch[1]!, file: filePath, line: lineNum });
      continue;
    }

    // app.use("/path", router)
    const routeMatch = line.match(/app\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/);
    if (routeMatch) {
      routers.push({
        mount_path: routeMatch[1]!,
        file: filePath,
        line: lineNum,
        imported_from: importMap.get(routeMatch[2]!) ?? null,
      });
      continue;
    }

    // Error handler: (err, req, res, next) => ...
    if (/app\.use\s*\(\s*(?:function\s*)?\(\s*err\s*,/.test(line) || /app\.use\s*\(\s*\(\s*err\s*:/.test(line)) {
      error_handlers.push({ file: filePath, line: lineNum });
    }
  }

  return { middleware, routers, error_handlers };
}
