import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { CodeIndex } from "../../types.js";
import type { RouteHandler } from "./types.js";

/**
 * Find Spring Boot Kotlin route handlers via @RestController/@Controller + @GetMapping/etc.
 */
export async function findSpringBootKotlinHandlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const mappingAnnotations: Array<{ ann: string; method: string }> = [
    { ann: "GetMapping", method: "GET" },
    { ann: "PostMapping", method: "POST" },
    { ann: "PutMapping", method: "PUT" },
    { ann: "DeleteMapping", method: "DELETE" },
    { ann: "PatchMapping", method: "PATCH" },
  ];

  const kotlinFiles = index.files.filter((f) => /\.kts?$/.test(f.path));
  if (kotlinFiles.length === 0) return handlers;

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const file of kotlinFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch { continue; }

    // Must have @RestController or @Controller annotation
    if (!/@(?:RestController|Controller)\b/.test(source)) continue;

    // Extract class-level @RequestMapping prefix (optional)
    const classRequestMatch = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']/.exec(source);
    const classPrefix = classRequestMatch?.[1] ?? "";

    for (const { ann, method } of mappingAnnotations) {
      // Match: @GetMapping("/path") fun funcName(...)
      // Or:    @GetMapping(value = "/path") fun funcName(...)
      const re = new RegExp(
        `@${ann}\\s*\\(\\s*(?:value\\s*=\\s*)?["']([^"']*)["'](?:[^)]*)?\\)\\s*(?:fun|\\n\\s*fun)\\s+(\\w+)`,
        "g",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const routePath = match[1] ?? "";
        const funcName = match[2] ?? "";

        const fullPath = `${classPrefix}/${routePath}`.replace(/\/+/g, "/");
        if (!matchPath(fullPath, searchPath)) continue;

        const sym = index.symbols.find(
          (s) => s.file === file.path && s.name === funcName,
        );

        handlers.push({
          symbol: sym
            ? stripSource(sym)
            : {
                id: `${file.path}:${funcName}`,
                name: funcName,
                kind: "method",
                file: file.path,
                start_line: 1,
                end_line: 1,
              } as ReturnType<typeof stripSource>,
          file: file.path,
          method,
          framework: "spring-kotlin",
        });
      }
    }
  }

  return handlers;
}

