import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

/**
 * Find NestJS route handlers via @Controller + @Get/@Post/etc. decorators.
 * Reads raw file content because tree-sitter symbol source may not include decorators.
 */
export async function findNestJSHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const methods = ["Get", "Post", "Put", "Delete", "Patch"];

  // Find controller files
  const controllerFiles = index.files.filter((f) =>
    f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );

  const { readFile } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");

  for (const file of controllerFiles) {
    let source: string;
    try {
      source = await readFile(joinPath(index.root, file.path), "utf-8");
    } catch { continue; }

    // Extract controller prefix — supports both @Controller('prefix') and @Controller()
    const ctrlMatchStr = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source);
    const ctrlMatchEmpty = !ctrlMatchStr ? /@Controller\s*\(\s*\)/.exec(source) : null;
    const controllerPrefix = ctrlMatchStr?.[1] ?? (ctrlMatchEmpty ? "" : "");

    for (const method of methods) {
      // Pass 1: string-literal paths — @Get('path')
      const re = new RegExp(`@${method}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)\\s*\\n\\s*(?:async\\s+)?(\\w+)`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const routePath = match[1] ?? "";
        const funcName = match[2] ?? "";

        const fullPath = `/${controllerPrefix}/${routePath}`.replace(/\/+/g, "/");
        if (matchPath(fullPath, searchPath)) {
          const sym = index.symbols.find((s) => s.file === file.path && s.name === funcName);
          handlers.push({
            symbol: sym ? stripSource(sym) : { id: `${file.path}:${funcName}`, name: funcName, kind: "method", file: file.path, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
            file: file.path,
            method: method.toUpperCase(),
            framework: "nestjs",
          });
        }
      }

      // Pass 2: empty decorator — @Get() with no path argument
      const reEmpty = new RegExp(`@${method}\\s*\\(\\s*\\)\\s*\\n\\s*(?:async\\s+)?(\\w+)`, "g");
      let emptyMatch: RegExpExecArray | null;
      while ((emptyMatch = reEmpty.exec(source)) !== null) {
        const funcName = emptyMatch[1] ?? "";
        const fullPath = `/${controllerPrefix}`.replace(/\/+/g, "/") || "/";
        if (matchPath(fullPath, searchPath)) {
          if (handlers.some((h) => h.file === file.path && h.symbol.name === funcName && h.method === method.toUpperCase())) continue;
          const sym = index.symbols.find((s) => s.file === file.path && s.name === funcName);
          handlers.push({
            symbol: sym ? stripSource(sym) : { id: `${file.path}:${funcName}`, name: funcName, kind: "method", file: file.path, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
            file: file.path,
            method: method.toUpperCase(),
            framework: "nestjs",
          });
        }
      }
    }
  }

  return handlers;
}
