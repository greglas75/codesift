import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

/**
 * Find Ktor route handlers via `routing { get("/path") { ... } }` DSL.
 * Supports nested `route("/prefix") { get("/sub") { } }` patterns.
 */
export async function findKtorHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"];

  // Ktor handlers are in .kt files, typically in files containing "routing {" or with "Route" in name
  const kotlinFiles = await readIndexedFiles(index, (path) => /\.kts?$/.test(path));
  if (kotlinFiles.length === 0) return handlers;

  for (const file of kotlinFiles) {
    const { path: filePath, source } = file;

    // Skip files without routing DSL
    if (!/\b(routing|route)\s*[({]/.test(source)) continue;

    // Extract route("/prefix") blocks to support nested prefixes
    // Simple approach: find all method calls with path args, combine with enclosing route() prefix via line scan
    const lines = source.split("\n");
    const prefixStack: Array<{ prefix: string; braceDepth: number }> = [];
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Track route("/prefix") { ... } blocks
      const routeMatch = /\broute\s*\(\s*["']([^"']+)["']\s*\)\s*\{/.exec(line);
      if (routeMatch) {
        prefixStack.push({ prefix: routeMatch[1]!, braceDepth });
      }

      // Count braces to detect when route() scope closes
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          braceDepth--;
          // Pop route prefixes whose scope ended
          while (
            prefixStack.length > 0 &&
            prefixStack[prefixStack.length - 1]!.braceDepth >= braceDepth
          ) {
            prefixStack.pop();
          }
        }
      }

      // Match method handlers: get("/path") { ... } or post("/path") { ... }
      for (const method of methods) {
        const re = new RegExp(`\\b${method}\\s*\\(\\s*["']([^"']+)["']\\s*\\)\\s*\\{`);
        const match = re.exec(line);
        if (!match) continue;

        const methodPath = match[1]!;
        const prefix = prefixStack.map((p) => p.prefix).join("");
        const fullPath = `${prefix}/${methodPath}`.replace(/\/+/g, "/");

        if (!matchPath(fullPath, searchPath)) continue;

        // Find enclosing function symbol (if any) for this line
        const lineNum = i + 1;
        const sym = index.symbols.find(
          (s) => s.file === filePath && s.start_line <= lineNum && s.end_line >= lineNum,
        );

        handlers.push({
          symbol: sym
            ? stripSource(sym)
            : {
                id: `${filePath}:${method}:${methodPath}`,
                name: `${method} ${methodPath}`,
                kind: "function",
                file: filePath,
                start_line: lineNum,
                end_line: lineNum,
              } as ReturnType<typeof stripSource>,
          file: filePath,
          method: method.toUpperCase(),
          framework: "ktor",
        });
      }
    }
  }

  return handlers;
}
