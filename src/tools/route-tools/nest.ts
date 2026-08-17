import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

interface NestHandlerInput {
  handlers: RouteHandler[],
  index: CodeIndex,
  filePath: string,
  functionName: string,
  method: string,
  deduplicate: boolean,
}

interface NestScanContext {
  handlers: RouteHandler[];
  index: CodeIndex;
  filePath: string;
  source: string;
  controllerPrefix: string;
  searchPath: string;
}

function addNestHandler(input: NestHandlerInput): void {
  const { handlers, index, filePath, functionName, method, deduplicate } = input;
  if (deduplicate && handlers.some((handler) =>
    handler.file === filePath &&
    handler.symbol.name === functionName &&
    handler.method === method
  )) return;

  const symbol = index.symbols.find(
    (candidate) => candidate.file === filePath && candidate.name === functionName,
  );
  handlers.push({
    symbol: symbol
      ? stripSource(symbol)
      : {
          id: `${filePath}:${functionName}`,
          name: functionName,
          kind: "method",
          file: filePath,
          start_line: 1,
          end_line: 1,
        } as ReturnType<typeof stripSource>,
    file: filePath,
    method,
    framework: "nestjs",
  });
}

function appendPathDecorators(
  context: NestScanContext,
  decorator: string,
): void {
  const { handlers, index, filePath, source, controllerPrefix, searchPath } = context;
  const pattern = new RegExp(
    `@${decorator}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)\\s*(?:\\n\\s*@[^\\n]+)*\\n\\s*(?:(?:public|private|protected|static|readonly|override|async)\\s+)*(\\w+)`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    const fullPath = `/${controllerPrefix}/${match[1] ?? ""}`.replace(/\/+/g, "/");
    if (matchPath(fullPath, searchPath)) {
      addNestHandler({
        handlers,
        index,
        filePath,
        functionName: match[2] ?? "",
        method: decorator.toUpperCase(),
        deduplicate: false,
      });
    }
  }
}

function appendEmptyDecorators(
  context: NestScanContext,
  decorator: string,
): void {
  const { handlers, index, filePath, source, controllerPrefix, searchPath } = context;
  const pattern = new RegExp(
    `@${decorator}\\s*\\(\\s*\\)\\s*(?:\\n\\s*@[^\\n]+)*\\n\\s*(?:(?:public|private|protected|static|readonly|override|async)\\s+)*(\\w+)`,
    "g",
  );
  const fullPath = `/${controllerPrefix}`.replace(/\/+/g, "/") || "/";
  if (!matchPath(fullPath, searchPath)) return;
  for (const match of source.matchAll(pattern)) {
    addNestHandler({
      handlers,
      index,
      filePath,
      functionName: match[1] ?? "",
      method: decorator.toUpperCase(),
      deduplicate: true,
    });
  }
}

/** Find NestJS handlers from controller and method decorators. */
export async function findNestJSHandlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const controllerFiles = await readIndexedFiles(
    index,
    (path) => path.endsWith(".controller.ts") || path.endsWith(".controller.js"),
  );

  for (const { path, source } of controllerFiles) {
    const controllerPrefix = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source)?.[1] ?? "";
    const context = { handlers, index, filePath: path, source, controllerPrefix, searchPath };
    for (const decorator of ["Get", "Post", "Put", "Delete", "Patch"]) {
      appendPathDecorators(context, decorator);
      appendEmptyDecorators(context, decorator);
    }
  }
  return handlers;
}
