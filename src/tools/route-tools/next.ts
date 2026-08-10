import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import { deriveUrlPath } from "../../utils/nextjs.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

/**
 * Find Next.js App Router handlers — file path IS the route.
 */
export function findNextJSHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const normalized = searchPath.replace(/^\/|\/$/g, "");

  for (const file of index.files) {
    // Match app/api/...route.{ts,tsx,js,jsx} or app/...route.{ts,tsx,js,jsx}
    if (!/\/route\.[jt]sx?$/.test(file.path)) continue;

    // Extract route path from file path: app/api/users/[id]/route.ts → /api/users/[id]
    const routeMatch = file.path.match(/app\/(.*?)\/route\.[jt]sx?$/);
    if (!routeMatch) continue;

    // Strip route groups: (auth)/login → login
    const filePath = routeMatch[1]!.replace(/\([^)]+\)\/?/g, "");
    if (matchPath(filePath, normalized)) {
      // Find exported handler functions (GET, POST, etc.)
      const fileSymbols = index.symbols.filter((s) =>
        s.file === file.path && /^(GET|POST|PUT|DELETE|PATCH)$/.test(s.name),
      );

      for (const sym of fileSymbols) {
        handlers.push({
          symbol: stripSource(sym),
          file: sym.file,
          method: sym.name,
          framework: "nextjs",
          router: "app",
        });
      }

      // If no named exports found, add the file itself
      if (fileSymbols.length === 0) {
        handlers.push({
          symbol: { id: file.path, name: "route", kind: "function", file: file.path, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
          file: file.path,
          framework: "nextjs",
          router: "app",
        });
      }
    }
  }

  return handlers;
}

/**
 * Find Pages Router API route handlers via default exports in pages/api/.
 * @internal exported for unit testing
 */
export function findPagesRouterHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];

  // Require Next.js project signal to disambiguate from Astro's src/pages/api/*.
  // Accept next.config.* at root/src OR an App Router convention file.
  const hasNextSignal = index.files.some((f) =>
    /^(src\/)?next\.config\.[mc]?[jt]sx?$/.test(f.path) ||
    /(^|\/)app\/.*\/(page|layout|route)\.[jt]sx?$/.test(f.path),
  );
  if (!hasNextSignal) return handlers;

  for (const file of index.files) {
    // Only match files under pages/api/ (not src/pages/api/ which is Astro convention)
    if (!/^(\.\/)?pages\/api\//.test(file.path)) continue;

    // Derive URL path from file path
    const urlPath = deriveUrlPath(file.path, "pages");
    const normalizedSearch = searchPath.replace(/^\/|\/$/g, "");
    const normalizedUrl = urlPath.replace(/^\/|\/$/g, "");

    if (normalizedUrl !== normalizedSearch) continue;

    // Find default export or named handler in the file
    const fileSymbols = index.symbols.filter((s) => s.file === file.path);

    // Look for default export
    const defaultExport = fileSymbols.find((s) => s.name === "default" || s.name === "handler");

    if (defaultExport) {
      handlers.push({
        symbol: stripSource(defaultExport),
        file: file.path,
        framework: "nextjs",
        router: "pages",
      });
    } else if (fileSymbols.length > 0) {
      // Try variable indirection: find any exported function
      const exported = fileSymbols.find((s) =>
        s.kind === "function" || s.kind === "variable",
      );
      if (exported) {
        handlers.push({
          symbol: stripSource(exported),
          file: file.path,
          framework: "nextjs",
          router: "pages",
        });
      }
    }

    // Fallback: at least mark the file as having a handler
    if (handlers.filter((h) => h.file === file.path).length === 0) {
      handlers.push({
        symbol: {
          id: file.path, name: "handler", kind: "function",
          file: file.path, start_line: 1, end_line: 1,
        } as ReturnType<typeof stripSource>,
        file: file.path,
        framework: "nextjs",
        router: "pages",
      });
    }
  }

  return handlers;
}
