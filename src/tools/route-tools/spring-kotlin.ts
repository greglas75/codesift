import type { CodeIndex } from "../../types.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

const MAPPINGS = [
  { annotation: "GetMapping", method: "GET" },
  { annotation: "PostMapping", method: "POST" },
  { annotation: "PutMapping", method: "PUT" },
  { annotation: "DeleteMapping", method: "DELETE" },
  { annotation: "PatchMapping", method: "PATCH" },
];

interface SpringScanContext {
  index: CodeIndex;
  file: string;
  source: string;
  classPrefix: string;
  searchPath: string;
}

function scanMapping(
  context: SpringScanContext,
  mapping: typeof MAPPINGS[number],
): RouteHandler[] {
  const { index, file, source, classPrefix, searchPath } = context;
  const pattern = new RegExp(
    `@${mapping.annotation}\\s*\\(\\s*(?:value\\s*=\\s*)?["']([^"']*)["'](?:[^)]*)?\\)\\s*(?:fun|\\n\\s*fun)\\s+(\\w+)`,
    "g",
  );
  const handlers: RouteHandler[] = [];
  for (const match of source.matchAll(pattern)) {
    const fullPath = `${classPrefix}/${match[1] ?? ""}`.replace(/\/+/g, "/");
    if (!matchPath(fullPath, searchPath)) continue;

    const functionName = match[2] ?? "";
    const symbol = index.symbols.find(
      (candidate) => candidate.file === file && candidate.name === functionName,
    );
    handlers.push({
      symbol: symbol
        ? stripSource(symbol)
        : {
            id: `${file}:${functionName}`,
            name: functionName,
            kind: "method",
            file,
            start_line: 1,
            end_line: 1,
          } as ReturnType<typeof stripSource>,
      file,
      method: mapping.method,
      framework: "spring-kotlin",
    });
  }
  return handlers;
}

function scanSpringFile(
  index: CodeIndex,
  file: string,
  source: string,
  searchPath: string,
): RouteHandler[] {
  if (!/@(?:RestController|Controller)\b/.test(source)) return [];

  const classPrefix = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']/
    .exec(source)?.[1] ?? "";
  const context = { index, file, source, classPrefix, searchPath };
  return MAPPINGS.flatMap((mapping) => scanMapping(context, mapping));
}

/** Find Spring Boot Kotlin handlers from controller mapping annotations. */
export async function findSpringBootKotlinHandlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const files = await readIndexedFiles(index, (path) => /\.kts?$/.test(path));
  return files.flatMap(({ path, source }) => scanSpringFile(index, path, source, searchPath));
}
