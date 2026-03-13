import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBM25Index, getCodeIndex } from "./index-tools.js";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import type { SearchResult, TextMatch, SymbolKind } from "../types.js";

const MAX_TEXT_MATCHES = 100;

export interface SearchSymbolsOptions {
  kind?: SymbolKind | undefined;
  file_pattern?: string | undefined;
  include_source?: boolean | undefined;
  top_k?: number | undefined;
}

export interface SearchTextOptions {
  regex?: boolean | undefined;
  file_pattern?: string | undefined;
  context_lines?: number | undefined;
}

/**
 * Match a file path against a simple glob pattern.
 * Supports: "*.ts", "src/*.ts", "src/**\/*.ts", "**\/*.test.ts"
 */
function matchFilePattern(filePath: string, pattern: string): boolean {
  // Exact match
  if (filePath === pattern) return true;

  // "**\/" prefix — match anywhere in path
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    // Recursively match the suffix against every segment tail
    return matchFilePattern(filePath, suffix) ||
      filePath.includes("/" + suffix) ||
      matchFileSuffix(filePath, suffix);
  }

  // "*" at the start — match extension-style patterns like "*.ts"
  if (pattern.startsWith("*") && !pattern.includes("/")) {
    const suffix = pattern.slice(1);
    return filePath.endsWith(suffix);
  }

  // Pattern with "**" in the middle (e.g., "src/**/*.ts")
  if (pattern.includes("/**/")) {
    const [prefix, suffix] = splitFirst(pattern, "/**/");
    if (!filePath.startsWith(prefix + "/") && filePath !== prefix) return false;
    const rest = filePath.slice(prefix.length + 1);
    return matchFilePattern(rest, suffix) ||
      matchFilePattern(rest, "**/" + suffix);
  }

  // Simple directory prefix + filename pattern (e.g., "src/*.ts")
  if (pattern.includes("/") && pattern.includes("*")) {
    const lastSlash = pattern.lastIndexOf("/");
    const dirPart = pattern.slice(0, lastSlash);
    const filePart = pattern.slice(lastSlash + 1);
    const fileLastSlash = filePath.lastIndexOf("/");
    const fileDir = fileLastSlash >= 0 ? filePath.slice(0, fileLastSlash) : "";
    const fileName = fileLastSlash >= 0 ? filePath.slice(fileLastSlash + 1) : filePath;

    if (fileDir !== dirPart) return false;
    return matchFilePattern(fileName, filePart);
  }

  // Plain startsWith for directory prefixes without wildcards
  if (!pattern.includes("*")) {
    return filePath.startsWith(pattern);
  }

  return false;
}

function matchFileSuffix(filePath: string, suffix: string): boolean {
  if (suffix.startsWith("*")) {
    const ext = suffix.slice(1);
    return filePath.endsWith(ext);
  }
  return filePath.endsWith("/" + suffix) || filePath === suffix;
}

function splitFirst(str: string, sep: string): [string, string] {
  const idx = str.indexOf(sep);
  if (idx < 0) return [str, ""];
  return [str.slice(0, idx), str.slice(idx + sep.length)];
}

/**
 * Search symbols by name/signature/docstring using BM25 ranking.
 * Supports filtering by symbol kind and file pattern.
 */
export async function searchSymbols(
  repo: string,
  query: string,
  options?: SearchSymbolsOptions,
): Promise<SearchResult[]> {
  const index = await getBM25Index(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const config = loadConfig();
  const topK = options?.top_k ?? config.defaultTopK;
  const includeSource = options?.include_source ?? true;

  let results = searchBM25(index, query, topK, config.bm25FieldWeights);

  // Filter by symbol kind
  if (options?.kind) {
    const kind = options.kind;
    results = results.filter((r) => r.symbol.kind === kind);
  }

  // Filter by file pattern
  if (options?.file_pattern) {
    const pattern = options.file_pattern;
    results = results.filter((r) => matchFilePattern(r.symbol.file, pattern));
  }

  // Strip source if not requested
  if (!includeSource) {
    results = results.map((r) => {
      const { source: _source, ...symbolWithoutSource } = r.symbol;
      return { ...r, symbol: symbolWithoutSource as typeof r.symbol };
    });
  }

  return results;
}

/**
 * Full-text search across all files in a repository.
 * Reads files from disk and searches line by line.
 */
export async function searchText(
  repo: string,
  query: string,
  options?: SearchTextOptions,
): Promise<TextMatch[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const contextLines = options?.context_lines ?? 2;
  const useRegex = options?.regex ?? false;
  const filePattern = options?.file_pattern;

  let regex: RegExp | null = null;
  if (useRegex) {
    try {
      regex = new RegExp(query);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex pattern: ${message}`);
    }
  }

  const matches: TextMatch[] = [];

  for (const file of index.files) {
    if (matches.length >= MAX_TEXT_MATCHES) break;

    // Filter by file pattern
    if (filePattern && !matchFilePattern(file.path, filePattern)) {
      continue;
    }

    const fullPath = join(index.root, file.path);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue; // File may have been deleted or moved
    }

    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_TEXT_MATCHES) break;

      const line = lines[i];
      if (line === undefined) continue;

      const isMatch = regex ? regex.test(line) : line.includes(query);
      if (!isMatch) continue;

      const contextBefore: string[] = [];
      const contextAfter: string[] = [];

      for (let j = Math.max(0, i - contextLines); j < i; j++) {
        const ctxLine = lines[j];
        if (ctxLine !== undefined) {
          contextBefore.push(ctxLine);
        }
      }

      for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextLines); j++) {
        const ctxLine = lines[j];
        if (ctxLine !== undefined) {
          contextAfter.push(ctxLine);
        }
      }

      const match: TextMatch = {
        file: file.path,
        line: i + 1, // 1-based
        content: line,
      };
      if (contextBefore.length > 0) {
        match.context_before = contextBefore;
      }
      if (contextAfter.length > 0) {
        match.context_after = contextAfter;
      }
      matches.push(match);
    }
  }

  return matches;
}
