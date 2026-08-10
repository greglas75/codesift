import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

/**
 * Find Django route handlers by parsing urlpatterns in urls.py files.
 * Handles path(), re_path(), and include() chains.
 */
export async function findDjangoHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const urlFiles = await readIndexedFiles(index, (path) => path.endsWith("urls.py"));

  for (const file of urlFiles) {
    const { path: filePath, source } = file;

    // Extract path() patterns: path('users/', views.user_list, name='...')
    // and path('users/<int:pk>/', views.user_detail)
    const pathRe = /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*([\w.]+)/g;
    let match: RegExpExecArray | null;

    // Get the URL prefix from the file's directory context
    // e.g., if this urls.py is included from a parent with prefix 'api/'
    while ((match = pathRe.exec(source)) !== null) {
      const routePath = match[1] ?? "";
      const viewRef = match[2] ?? "";

      // Skip include() references
      if (viewRef === "include") continue;

      // Convert Django <type:name> to :name for matchPath
      const normalizedPath = `/${routePath}`.replace(/<\w+:(\w+)>/g, ":$1").replace(/\/+/g, "/");
      if (!matchPath(normalizedPath, searchPath)) continue;

      // Resolve view reference to a symbol
      const viewParts = viewRef.split(".");
      const lastPart = viewParts.at(-1) ?? viewRef;
      const viewName = lastPart === "as_view" ? (viewParts.at(-2) ?? lastPart) : lastPart;
      const sym = index.symbols.find((s) => s.name === viewName && s.file.endsWith(".py"));

      handlers.push({
        symbol: sym
          ? stripSource(sym)
          : {
              id: `${filePath}:${viewName}`,
              name: viewName,
              kind: "function",
              file: filePath,
              start_line: 1,
              end_line: 1,
            } as ReturnType<typeof stripSource>,
        file: sym?.file ?? filePath,
        framework: "django",
      });
    }
  }

  return handlers;
}
