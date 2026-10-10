import { asRouteIndex, type RouteIndex, type RouteIndexInput } from "./route-index.js";
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
  index: RouteIndex;
  file: string;
  source: string;
  classPrefix: string;
  searchPath: string;
}

async function scanMapping(
  context: SpringScanContext,
  mapping: typeof MAPPINGS[number],
): Promise<RouteHandler[]> {
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
    const [symbol] = await index.find({ file, name: functionName, withSource: false, limit: 1 });
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

async function scanSpringFile(
  index: RouteIndex,
  file: string,
  source: string,
  searchPath: string,
): Promise<RouteHandler[]> {
  if (!/@(?:RestController|Controller)\b/.test(source)) return [];

  // `.exec(source)` took the FIRST @RequestMapping anywhere in the file. A method-level mapping
  // declared above the class annotation therefore became the prefix for every route in it. Anchor
  // on the one that actually precedes the class declaration.
  const classPrefix = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["'][\s\S]{0,400}?\bclass\b/
    .exec(source)?.[1] ?? "";
  const context = { index, file, source, classPrefix, searchPath };
  const handlers: RouteHandler[] = [];
  for (const mapping of MAPPINGS) handlers.push(...await scanMapping(context, mapping));
  return handlers;
}

/** Find Spring Boot Kotlin handlers from controller mapping annotations. */
export async function findSpringBootKotlinHandlers(
  input: RouteIndexInput,
  searchPath: string,
): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  const files = await readIndexedFiles(index, (path) => /\.kts?$/.test(path));
  const handlers: RouteHandler[] = [];
  for (const { path, source } of files) handlers.push(...await scanSpringFile(index, path, source, searchPath));
  return handlers;
}
