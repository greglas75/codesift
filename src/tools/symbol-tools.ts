import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { getCodeIndex, getBM25Index } from "./index-tools.js";
import type { CodeSymbol, Reference } from "../types.js";

const MAX_REFERENCES = 200;

/**
 * Read a source file and extract lines for a symbol (1-based, inclusive).
 * Returns undefined if the file cannot be read.
 */
async function extractSource(
  repoRoot: string,
  file: string,
  startLine: number,
  endLine: number,
): Promise<string | undefined> {
  try {
    const content = await readFile(join(repoRoot, file), "utf-8");
    const lines = content.split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Retrieve a single symbol by ID with fresh source from disk.
 */
export async function getSymbol(
  repo: string,
  symbolId: string,
): Promise<CodeSymbol | null> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const symbol = index.symbols.find((s) => s.id === symbolId);
  if (!symbol) return null;

  const source = await extractSource(
    index.root,
    symbol.file,
    symbol.start_line,
    symbol.end_line,
  );

  const result = { ...symbol };
  if (source !== undefined) {
    result.source = source;
  }
  return result;
}

/**
 * Retrieve multiple symbols by ID with fresh source from disk.
 * Groups reads by file to minimize disk I/O.
 */
export async function getSymbols(
  repo: string,
  symbolIds: string[],
): Promise<CodeSymbol[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  // Build lookup map for requested symbols
  const symbolMap = new Map<string, CodeSymbol>();
  for (const sym of index.symbols) {
    if (symbolIds.includes(sym.id)) {
      symbolMap.set(sym.id, sym);
    }
  }

  // Group symbols by file to read each file only once
  const byFile = new Map<string, CodeSymbol[]>();
  for (const id of symbolIds) {
    const sym = symbolMap.get(id);
    if (!sym) continue;

    let group = byFile.get(sym.file);
    if (!group) {
      group = [];
      byFile.set(sym.file, group);
    }
    group.push(sym);
  }

  // Read each file once, extract source for all symbols in that file
  const results = new Map<string, CodeSymbol>();

  for (const [file, symbols] of byFile) {
    let fileContent: string | undefined;
    try {
      fileContent = await readFile(join(index.root, file), "utf-8");
    } catch {
      // File may have been deleted since indexing
    }

    const lines = fileContent?.split("\n");

    for (const sym of symbols) {
      const result = { ...sym };
      if (lines) {
        result.source = lines.slice(sym.start_line - 1, sym.end_line).join("\n");
      }
      results.set(sym.id, result);
    }
  }

  // Return in the same order as requested, skipping missing IDs
  const ordered: CodeSymbol[] = [];
  for (const id of symbolIds) {
    const sym = results.get(id);
    if (sym) ordered.push(sym);
  }

  return ordered;
}

/**
 * Find references to a symbol name across indexed files.
 * Matches whole words only using word-boundary regex.
 */
export async function findReferences(
  repo: string,
  symbolName: string,
  filePattern?: string,
): Promise<Reference[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  // Escape special regex characters in symbol name
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`);

  // Optional file pattern filter
  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const refs: Reference[] = [];

  for (const fileEntry of index.files) {
    if (refs.length >= MAX_REFERENCES) break;

    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
    } catch {
      continue; // File may have been deleted
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (refs.length >= MAX_REFERENCES) break;

      const line = lines[i];
      if (line === undefined) continue;
      const match = pattern.exec(line);
      if (match) {
        refs.push({
          file: fileEntry.path,
          line: i + 1,
          col: match.index + 1,
          context: line.trimEnd(),
        });
      }
    }
  }

  return refs;
}

/**
 * Search for a symbol by query and return it with full source.
 * Optionally includes references across the codebase.
 */
export async function findAndShow(
  repo: string,
  query: string,
  includeRefs?: boolean,
): Promise<{ symbol: CodeSymbol; references?: Reference[] } | null> {
  const bm25Index = await getBM25Index(repo);
  if (!bm25Index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const config = loadConfig();
  const results = searchBM25(bm25Index, query, 1, config.bm25FieldWeights);

  const topResult = results[0];
  if (!topResult) return null;

  const fullSymbol = await getSymbol(repo, topResult.symbol.id);
  if (!fullSymbol) return null;

  if (includeRefs) {
    const references = await findReferences(repo, fullSymbol.name);
    return { symbol: fullSymbol, references };
  }

  return { symbol: fullSymbol };
}
