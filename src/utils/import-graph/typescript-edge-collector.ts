import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getCachedParse, setCachedParse } from "../../parser/parse-cache.js";
import { getParser, getParseTimeoutMs } from "../../parser/parser-manager.js";
import { getNativeCore } from "../../native/index.js";

import { extractTypeScriptImports, type TsImportEdge } from "../ts-imports.js";
import { resolveTsAliasedImport } from "../tsconfig-paths.js";
import { resolveImportPath } from "./path-map.js";
import type { AddImportEdge, ImportEdgeExtras, ImportGraphIndex } from "./types.js";

export interface TsCollectionOutcome {
  astHandled: boolean;
}

function resolveRelativeImport(
  importerFile: string,
  importPath: string,
  normalizedPaths: Map<string, string>,
): string | null {
  let normalized = resolveImportPath(importerFile, importPath);
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalizedPaths.get(normalized) ?? null;
}

function resolveAliasedImport(
  index: ImportGraphIndex,
  importerFile: string,
  importPath: string,
  normalizedPaths: Map<string, string>,
): string | null {
  const aliased = resolveTsAliasedImport(join(index.root, importerFile), importPath, index.root);
  if (!aliased) return null;
  const relativePath = relative(resolve(index.root), resolve(aliased));
  const insideRoot = relativePath !== "" && !isAbsolute(relativePath) && !relativePath.startsWith("..");
  if (!insideRoot) return null;
  const normalizedRelativePath = relativePath.split(sep).join("/");
  const indexed = normalizedPaths.has(normalizedRelativePath.replace(/\.[^./]+$/, "")) ||
    index.files.some((file) => file.path === normalizedRelativePath);
  return indexed ? normalizedRelativePath : null;
}

export function isTypeScriptImportFile(filePath: string): boolean {
  return /\.tsx?$/.test(filePath);
}

/**
 * `extractTypeScriptImports` for many files at once, parsed in parallel by the Rust core off the main
 * thread (ADR-006 stage 4) — keyed by path. Measured cold on a 35,357-file repo, the one-at-a-time
 * web-tree-sitter parse here was 95% of the whole graph build.
 *
 * A file missing from the result (no core, a failed batch, a parse the core gave up on) simply goes
 * through `collectTypeScriptEdges`' own parse, so the edges never depend on which path ran.
 */
export async function extractTypeScriptImportsBatch(
  files: ReadonlyArray<{ path: string; source: string }>,
): Promise<Map<string, TsImportEdge[]>> {
  const out = new Map<string, TsImportEdge[]>();
  if (files.length === 0) return out;
  const core = getNativeCore("parser");
  if (!core || typeof core.extractTsImports !== "function") return out;
  try {
    const json = await core.extractTsImports(
      files.map((f) => f.source),
      files.map((f) => f.path.endsWith(".tsx")),
      getParseTimeoutMs(),
    );
    const parsed = JSON.parse(json) as Array<TsImportEdge[] | null>;
    for (let i = 0; i < files.length; i++) {
      const edges = parsed[i];
      if (edges) out.set(files[i]!.path, edges);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[import-graph] native import extraction failed; parsing in TypeScript: ${message}`);
  }
  return out;
}

export async function collectTypeScriptEdges(
  index: ImportGraphIndex,
  filePath: string,
  source: string,
  normalizedPaths: Map<string, string>,
  addEdge: AddImportEdge,
  /** This file's imports, already extracted by `extractTypeScriptImportsBatch`. */
  preextracted?: TsImportEdge[],
): Promise<TsCollectionOutcome> {
  if (!isTypeScriptImportFile(filePath)) return { astHandled: false };
  try {
    let imports = preextracted;
    if (imports === undefined) {
      const language = filePath.endsWith(".tsx") ? "tsx" : "typescript";
      const parser = await getParser(language);
      if (!parser) return { astHandled: false };
      let tree = getCachedParse(language, source);
      if (!tree) {
        tree = parser.parse(source);
        if (!tree) {
          console.warn(
            `[import-graph] TS parser returned null for ${filePath}; falling back to regex`,
          );
          return { astHandled: false };
        }
        setCachedParse(language, source, tree);
      }
      imports = extractTypeScriptImports(tree);
    }
    for (const imported of imports) {
      const resolved = imported.path.startsWith(".")
        ? resolveRelativeImport(filePath, imported.path, normalizedPaths)
        : resolveAliasedImport(index, filePath, imported.path, normalizedPaths);
      if (!resolved) continue;
      const extras: ImportEdgeExtras = { type_only: imported.is_type_only };
      if (imported.kind === "mock") extras.mock = true;
      addEdge(filePath, resolved, extras);
    }
    return { astHandled: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[import-graph] TS AST extraction failed for ${filePath}; falling back to regex: ${message}`);
    return { astHandled: false };
  }
}
