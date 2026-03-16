import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { searchBM25 } from "../search/bm25.js";
import { loadConfig } from "../config.js";
import { getCodeIndex, getBM25Index } from "./index-tools.js";
import type { CodeSymbol, Reference, SymbolKind } from "../types.js";

const MAX_REFERENCES = 200;
const MAX_DEAD_CODE_RESULTS = 100;
const MAX_CONTEXT_LENGTH = 200; // Truncate context lines to prevent huge output from minified files

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
        const rawContext = line.trimEnd();
        refs.push({
          file: fileEntry.path,
          line: i + 1,
          col: match.index + 1,
          context: rawContext.length > MAX_CONTEXT_LENGTH
            ? rawContext.slice(0, MAX_CONTEXT_LENGTH) + "..."
            : rawContext,
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

/**
 * Extract full import lines from file source.
 */
function extractImportLines(source: string): string[] {
  const lines = source.split("\n");
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("import ") || trimmed.startsWith("const ") && trimmed.includes("require(");
  });
}

export interface ContextBundle {
  symbol: CodeSymbol;
  imports: string[];
  siblings: Array<{ name: string; kind: SymbolKind; start_line: number; end_line: number }>;
  types_used: string[];  // type/interface names referenced in the symbol's source
}

/**
 * Get a symbol with its file's imports and sibling symbols in one call.
 * Saves 2-3 round-trips vs get_symbol + search_text(imports) + get_file_outline.
 */
export async function getContextBundle(
  repo: string,
  symbolName: string,
): Promise<ContextBundle | null> {
  const bm25Index = await getBM25Index(repo);
  if (!bm25Index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const config = loadConfig();
  const results = searchBM25(bm25Index, symbolName, 1, config.bm25FieldWeights);
  const topResult = results[0];
  if (!topResult) return null;

  const index = await getCodeIndex(repo);
  if (!index) return null;

  // Get full symbol with source
  const fullSymbol = await getSymbol(repo, topResult.symbol.id);
  if (!fullSymbol) return null;

  // Read the file to extract imports
  let fileSource: string;
  try {
    fileSource = await readFile(join(index.root, fullSymbol.file), "utf-8");
  } catch {
    return { symbol: fullSymbol, imports: [], siblings: [], types_used: [] };
  }

  const imports = extractImportLines(fileSource);

  // Get sibling symbols (other symbols in the same file)
  const siblings = index.symbols
    .filter((s) => s.file === fullSymbol.file && s.id !== fullSymbol.id)
    .map((s) => ({
      name: s.name,
      kind: s.kind,
      start_line: s.start_line,
      end_line: s.end_line,
    }));

  // Extract type names used in the symbol's source
  const typesUsed = extractTypesUsed(fullSymbol.source ?? "", index.symbols);

  return { symbol: fullSymbol, imports, siblings, types_used: typesUsed };
}

/**
 * Extract type/interface names referenced in source by matching against known symbols.
 */
function extractTypesUsed(source: string, allSymbols: CodeSymbol[]): string[] {
  const typeSymbols = allSymbols.filter((s) =>
    s.kind === "interface" || s.kind === "type" || s.kind === "enum",
  );

  const used = new Set<string>();
  for (const sym of typeSymbols) {
    if (sym.name.length < 3) continue;
    // Check if the type name appears in the source (word boundary)
    const pattern = new RegExp(`\\b${sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (pattern.test(source)) {
      used.add(sym.name);
    }
  }

  return [...used].sort();
}

export interface DeadCodeCandidate {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  reason: string;
}

export interface DeadCodeResult {
  candidates: DeadCodeCandidate[];
  scanned_symbols: number;
  scanned_files: number;
}

// Kinds that are typically exported and should have external references
const EXPORTABLE_KINDS = new Set<SymbolKind>([
  "function", "class", "interface", "type", "variable", "constant", "enum",
]);

/**
 * Find potentially dead code: exported symbols with 0 references outside their own file.
 * Scans all indexed files for word-boundary matches of each exported symbol name.
 */
export async function findDeadCode(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<DeadCodeResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  // Filter to top-level symbols of relevant kinds
  // Note: tree-sitter source may not include 'export' keyword, so we check
  // kind + top-level position (no parent = not nested in a class/namespace)
  const exportedSymbols = index.symbols.filter((s) => {
    if (!EXPORTABLE_KINDS.has(s.kind)) return false;
    if (s.parent) return false; // Skip nested symbols (class methods, etc.)
    if (!includeTests && isTestFile(s.file)) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    if (s.name.length < 3) return false;
    if (s.kind === "variable" && s.name === "default") return false;
    return true;
  });

  // Read all non-test files into memory for scanning
  const fileContents = new Map<string, string>();
  for (const file of index.files) {
    if (!includeTests && isTestFile(file.path)) continue;
    try {
      fileContents.set(file.path, await readFile(join(index.root, file.path), "utf-8"));
    } catch {
      // File may have been deleted
    }
  }

  const candidates: DeadCodeCandidate[] = [];

  for (const sym of exportedSymbols) {
    if (candidates.length >= MAX_DEAD_CODE_RESULTS) break;

    const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`);

    let externalRefs = 0;
    for (const [filePath, content] of fileContents) {
      if (filePath === sym.file) continue; // Skip own file
      if (pattern.test(content)) {
        externalRefs++;
        break; // One external ref is enough — not dead
      }
    }

    if (externalRefs === 0) {
      candidates.push({
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        start_line: sym.start_line,
        end_line: sym.end_line,
        reason: "exported but no references found outside defining file",
      });
    }
  }

  return {
    candidates,
    scanned_symbols: exportedSymbols.length,
    scanned_files: fileContents.size,
  };
}

function isTestFile(path: string): boolean {
  return /\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(path)
    || path.includes("__tests__")
    || path.includes("/test/");
}
