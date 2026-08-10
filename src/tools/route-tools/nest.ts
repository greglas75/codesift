import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

/**
 * Find NestJS route handlers via @Controller + @Get/@Post/etc. decorators.
 * Reads raw file content because tree-sitter symbol source may not include decorators.
 */
export async function findNestJSHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const methods = ["Get", "Post", "Put", "Delete", "Patch"];

  const controllerFiles = await readIndexedFiles(
    index,
    (path) => path.endsWith(".controller.ts") || path.endsWith(".controller.js"),
  );

  for (const file of controllerFiles) {
    const { path: filePath, source } = file;

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
          const sym = index.symbols.find((s) => s.file === filePath && s.name === funcName);
          handlers.push({
            symbol: sym ? stripSource(sym) : { id: `${filePath}:${funcName}`, name: funcName, kind: "method", file: filePath, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
            file: filePath,
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
          if (handlers.some((h) => h.file === filePath && h.symbol.name === funcName && h.method === method.toUpperCase())) continue;
          const sym = index.symbols.find((s) => s.file === filePath && s.name === funcName);
          handlers.push({
            symbol: sym ? stripSource(sym) : { id: `${filePath}:${funcName}`, name: funcName, kind: "method", file: filePath, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
            file: filePath,
            method: method.toUpperCase(),
            framework: "nestjs",
          });
        }
      }
    }
  }

  return handlers;
}
