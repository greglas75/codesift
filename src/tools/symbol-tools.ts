import { readFile, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { searchBM25, type BM25Index } from "../search/bm25.js";
import { findReferencesLsp } from "../lsp/lsp-tools.js";
import { loadConfig } from "../config.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { detectFrameworks, isFrameworkEntryPoint } from "../utils/framework-detect.js";
import { getCodeIndex, getBM25Index } from "./index-tools.js";
import { REACT_STDLIB_HOOKS } from "./react-tools.js";
import type { CodeIndex, CodeSymbol, Reference, SymbolKind } from "../types.js";

const MAX_REFERENCES = 100;
const MAX_DEAD_CODE_RESULTS = 100;
const MAX_CONTEXT_LENGTH = 200; // Truncate context lines to prevent huge output from minified files

/** Skip build artifacts and binary files — docs/audits are intentionally kept */
const NOISE_PATH_PREFIXES = [".next/", "dist/", "build/", "coverage/", "node_modules/", "__snapshots__/"];
const NOISE_EXTENSIONS = new Set([".snap", ".lock", ".map", ".svg", ".png", ".jpg", ".ico", ".woff", ".woff2"]);

function isNoisePath(filePath: string): boolean {
  if (NOISE_PATH_PREFIXES.some((p) => filePath.startsWith(p))) return true;
  const dot = filePath.lastIndexOf(".");
  if (dot >= 0 && NOISE_EXTENSIONS.has(filePath.slice(dot))) return true;
  return false;
}

async function requireCodeIndex(repo: string): Promise<CodeIndex> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return index;
}

async function requireBM25Index(repo: string): Promise<BM25Index> {
  const index = await getBM25Index(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return index;
}

function wordBoundaryPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

/**
 * Strip internal/BM25 fields from CodeSymbol for leaner output.
 * Removes: repo, tokens, start_col, end_col. Shortens id (strips repo prefix).
 */
function stripSymbol(sym: CodeSymbol): Omit<CodeSymbol, "repo" | "tokens" | "start_col" | "end_col" | "start_byte" | "end_byte"> {
  const { repo: _repo, tokens: _tokens, start_col: _sc, end_col: _ec, start_byte: _sb, end_byte: _eb, id, ...rest } = sym;
  // Strip "local/reponame:" prefix from id
  const shortId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return { ...rest, id: shortId };
}

/**
 * Read a source file and extract lines for a symbol (1-based, inclusive).
 * Uses byte offsets when available for precise reads without loading full file.
 * Returns undefined if the file cannot be read.
 */
async function extractSource(
  repoRoot: string,
  file: string,
  startLine: number,
  endLine: number,
  startByte?: number,
  endByte?: number,
): Promise<string | undefined> {
  const filePath = join(repoRoot, file);

  // Fast path: use byte offsets to read exact range
  if (startByte != null && endByte != null && endByte > startByte) {
    try {
      const fh = await open(filePath, "r");
      try {
        const length = endByte - startByte;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, startByte);
        return buf.toString("utf-8");
      } finally {
        await fh.close();
      }
    } catch {
      // Fall through to line-based extraction
    }
  }

  // Fallback: line-based extraction
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Retrieve a single symbol by ID with fresh source from disk.
 * When include_related is true (default), auto-prefetches:
 *  - children (for classes/interfaces) — saves follow-up get_symbols call
 *  - symbols in the same file that reference this symbol — saves find_references call
 */
export async function getSymbol(
  repo: string,
  symbolId: string,
  options?: { include_related?: boolean },
): Promise<{ symbol: CodeSymbol; related?: CodeSymbol[] } | null> {
  const index = await requireCodeIndex(repo);
  const includeRelated = options?.include_related ?? true;

  const symbol = index.symbols.find((s) => s.id === symbolId);
  if (!symbol) return null;

  const source = await extractSource(
    index.root,
    symbol.file,
    symbol.start_line,
    symbol.end_line,
    symbol.start_byte,
    symbol.end_byte,
  );

  const result = { ...symbol };
  if (source !== undefined) {
    result.source = source;
  }

  const stripped = stripSymbol(result) as CodeSymbol;

  if (!includeRelated) {
    return { symbol: stripped };
  }

  // Prefetch children for classes/interfaces
  const related: CodeSymbol[] = [];
  if (symbol.kind === "class" || symbol.kind === "interface") {
    const children = index.symbols.filter((s) => s.parent === symbol.id);
    for (const child of children.slice(0, 20)) {
      related.push(stripSymbol(child) as CodeSymbol);
    }
  }

  const out: { symbol: CodeSymbol; related?: CodeSymbol[] } = { symbol: stripped };
  if (related.length > 0) out.related = related;
  return out;
}

/**
 * Retrieve multiple symbols by ID with fresh source from disk.
 * Groups reads by file to minimize disk I/O.
 */
export async function getSymbols(
  repo: string,
  symbolIds: string[],
): Promise<CodeSymbol[]> {
  const index = await requireCodeIndex(repo);

  // Build lookup map for requested symbols
  const requestedIds = new Set(symbolIds);
  const symbolMap = new Map<string, CodeSymbol>();
  for (const sym of index.symbols) {
    if (requestedIds.has(sym.id)) {
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

  // Read all files in parallel, extract source for all symbols in each file
  const results = new Map<string, CodeSymbol>();

  const fileEntries = [...byFile.entries()];
  const fileContents = await Promise.all(
    fileEntries.map(([file]) =>
      readFile(join(index.root, file), "utf-8").catch(() => undefined),
    ),
  );

  for (let i = 0; i < fileEntries.length; i++) {
    const [, symbols] = fileEntries[i]!;
    const lines = fileContents[i]?.split("\n");

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
    if (sym) ordered.push(stripSymbol(sym) as CodeSymbol);
  }

  return ordered;
}

/**
 * Find references to a symbol name across indexed files.
 * Matches whole words only using word-boundary regex.
 */
/**
 * Batch find references for multiple symbols in one pass.
 * Reads each file once instead of N times — critical for large repos.
 */
export async function findReferencesBatch(
  repo: string,
  symbolNames: string[],
  filePattern?: string,
): Promise<Record<string, Reference[]>> {
  const index = await requireCodeIndex(repo);
  const patterns = symbolNames.map((name) => ({
    name,
    regex: wordBoundaryPattern(name),
  }));

  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const result: Record<string, Reference[]> = {};
  for (const name of symbolNames) result[name] = [];

  for (const fileEntry of index.files) {
    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;
    if (!filePattern && isNoisePath(fileEntry.path)) continue;

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
    } catch { continue; }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      for (const { name, regex } of patterns) {
        const refs = result[name]!;
        if (refs.length >= MAX_REFERENCES) continue;
        const match = regex.exec(line);
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
  }

  return result;
}

const SEARCH_TIMEOUT_MS = 30_000;

/** Directories to exclude from ripgrep reference search */
const RG_EXCLUDE_DIRS = [
  "node_modules", ".git", ".next", "dist", ".codesift", "coverage",
  ".playwright-mcp", "__pycache__", "__snapshots__",
];

/** Detect whether `rg` (ripgrep) is available. Cached at module level. */
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/**
 * Find references using ripgrep with word-boundary matching.
 * Returns compact `file:line: context` string when results ≤ threshold.
 */
function findReferencesWithRipgrep(
  root: string,
  symbolName: string,
  maxResults: number,
  filePattern?: string,
): Reference[] | string {
  const args: string[] = [
    "-n", "--no-heading", "-w",
    "--max-columns", String(MAX_CONTEXT_LENGTH),
    "--max-columns-preview",
    "--max-count", String(Math.min(maxResults * 2, 5000)),
  ];

  // Exclude noise dirs
  for (const dir of RG_EXCLUDE_DIRS) {
    args.push("--glob", `!${dir}`);
  }
  // Exclude noise extensions
  for (const ext of [".snap", ".lock", ".map", ".svg", ".png", ".jpg", ".ico", ".woff", ".woff2", ".md", ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".html"]) {
    args.push("--glob", `!*${ext}`);
  }

  if (filePattern) {
    args.push("--glob", filePattern);
  } else {
    // Default to code files only (matches what agent would grep for)
    args.push("--type-add", "code:*.{ts,tsx,js,jsx,py,go,rs,java,kt,kts,rb,php,vue,svelte}");
    args.push("--type", "code");
  }

  args.push("--", symbolName, root);

  let stdout: string;
  try {
    stdout = execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: SEARCH_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      if ((err as { status: number }).status === 1) return []; // no matches
      if ("stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
        stdout = (err as { stdout: string }).stdout;
        if (!stdout) return [];
      } else {
        return [];
      }
    } else {
      return [];
    }
  }

  const rootPrefix = root.endsWith("/") ? root : root + "/";
  const lines = stdout.split("\n").filter(Boolean);
  const refs: Reference[] = [];

  for (const rawLine of lines) {
    if (refs.length >= maxResults) break;

    const match = rawLine.match(/^(.+?):(\d+):(.*)/);
    if (!match || !match[1] || !match[2] || match[3] === undefined) continue;

    const absPath = match[1];
    const relPath = absPath.startsWith(rootPrefix) ? absPath.slice(rootPrefix.length) : absPath;
    if (isNoisePath(relPath)) continue;

    refs.push({
      file: relPath,
      line: parseInt(match[2], 10),
      context: match[3].length > MAX_CONTEXT_LENGTH ? match[3].slice(0, MAX_CONTEXT_LENGTH) + "..." : match[3],
    });
  }

  return refs;
}

export async function findReferences(
  repo: string,
  symbolName: string,
  filePattern?: string,
): Promise<Reference[]> {
  // Try LSP first (type-safe, no false positives)
  const lspRefs = await findReferencesLsp(repo, symbolName);
  if (lspRefs !== null) return lspRefs;

  // Use ripgrep when available (10x+ faster than Node.js file walk)
  if (hasRipgrep()) {
    const index = await requireCodeIndex(repo);
    const result = findReferencesWithRipgrep(index.root, symbolName, MAX_REFERENCES, filePattern);
    // ripgrep helper may return compact string; convert back to Reference[]
    if (typeof result === "string") {
      return result.split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(.+?):(\d+): (.*)/);
        return m ? { file: m[1]!, line: parseInt(m[2]!, 10), context: m[3]! } : { file: "", line: 0, context: line };
      });
    }
    return result;
  }

  // Node.js fallback
  const index = await requireCodeIndex(repo);
  const pattern = wordBoundaryPattern(symbolName);
  const searchStart = Date.now();

  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const refs: Reference[] = [];

  for (const fileEntry of index.files) {
    if (refs.length >= MAX_REFERENCES) break;
    if (Date.now() - searchStart > SEARCH_TIMEOUT_MS) break;

    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;
    if (!filePattern && isNoisePath(fileEntry.path)) continue;

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
    } catch {
      continue;
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
          context: rawContext.length > MAX_CONTEXT_LENGTH
            ? rawContext.slice(0, MAX_CONTEXT_LENGTH) + "..."
            : rawContext,
        });
      }
    }
  }

  return refs;
}

/** Format references as compact string for MCP output. Groups by file to avoid repeating paths. */
export function formatRefsCompact(refs: Reference[]): string {
  if (refs.length === 0) return "";
  // Group by file
  const groups = new Map<string, string[]>();
  for (const r of refs) {
    let g = groups.get(r.file);
    if (!g) { g = []; groups.set(r.file, g); }
    g.push(`  ${r.line}: ${r.context}`);
  }
  if (groups.size === refs.length) {
    // Each file has 1 ref — flat is fine
    return refs.map((r) => `${r.file}:${r.line}: ${r.context}`).join("\n");
  }
  const parts: string[] = [];
  for (const [file, lines] of groups) {
    parts.push(`${file}\n${lines.join("\n")}`);
  }
  return parts.join("\n");
}

/** Format a CodeSymbol as compact text: header line + source. ~70% less tokens than JSON. */
export function formatSymbolCompact(sym: CodeSymbol): string {
  const loc = `${sym.file}:${sym.start_line}-${sym.end_line}`;
  const sig = sym.signature ? ` ${sym.signature}` : "";
  const header = `${loc} ${sym.kind} ${sym.name}${sig}`;
  if (!sym.source) return header;
  return `${header}\n${sym.source}`;
}

/** Format multiple CodeSymbols as compact text, separated by blank lines. */
export function formatSymbolsCompact(syms: CodeSymbol[]): string {
  return syms.map(formatSymbolCompact).join("\n\n");
}

/** Format ContextBundle as compact text. */
export function formatBundleCompact(bundle: { symbol: CodeSymbol; imports: string[]; siblings: Array<{ name: string; kind: string; start_line: number; end_line: number }>; types_used: string[] }): string {
  const parts: string[] = [];
  parts.push(formatSymbolCompact(bundle.symbol as CodeSymbol));
  if (bundle.imports.length > 0) {
    parts.push(`\n--- imports ---\n${bundle.imports.join("\n")}`);
  }
  if (bundle.siblings.length > 0) {
    const sibLines = bundle.siblings.map((s) => `  ${s.kind} ${s.name} :${s.start_line}-${s.end_line}`);
    parts.push(`\n--- siblings ---\n${sibLines.join("\n")}`);
  }
  if (bundle.types_used.length > 0) {
    parts.push(`\n--- types used ---\n${bundle.types_used.join(", ")}`);
  }
  return parts.join("");
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
  const bm25Index = await requireBM25Index(repo);
  const config = loadConfig();
  const results = searchBM25(bm25Index, query, 1, config.bm25FieldWeights);

  const topResult = results[0];
  if (!topResult) return null;

  const fullResult = await getSymbol(repo, topResult.symbol.id, { include_related: false });
  if (!fullResult) return null;
  const fullSymbol = fullResult.symbol;

  if (includeRefs) {
    const references = await findReferences(repo, fullSymbol.name as string);
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
    return trimmed.startsWith("import ") || (trimmed.startsWith("const ") && trimmed.includes("require("));
  });
}

export interface ReactContext {
  /** Props type name extracted from the component's parameter type annotation */
  props_type: string | null;
  /** Source of the props interface/type declaration when found in the index (Tier 4 — Item 16) */
  props_interface_source: string | null;
  /** React hooks called inside this component (use*() patterns) */
  hooks_used: Array<{ name: string; is_stdlib: boolean }>;
  /** Child components rendered via JSX (<PascalCase>) */
  child_components: string[];
  /** Parent components that render this one via JSX */
  parent_components: string[];
  /** Detected wrapper pattern (memo, forwardRef, lazy) or null */
  wrapper: "memo" | "forwardRef" | "lazy" | null;
}

export interface ContextBundle {
  symbol: CodeSymbol;
  imports: string[];
  siblings: Array<{ name: string; kind: SymbolKind; start_line: number; end_line: number }>;
  types_used: string[];  // type/interface names referenced in the symbol's source
  /** Only populated when symbol.kind === "component" */
  react_context?: ReactContext;
}

/**
 * Get a symbol with its file's imports and sibling symbols in one call.
 * Saves 2-3 round-trips vs get_symbol + search_text(imports) + get_file_outline.
 */
export async function getContextBundle(
  repo: string,
  symbolName: string,
): Promise<ContextBundle | null> {
  const bm25Index = await requireBM25Index(repo);
  const config = loadConfig();
  const results = searchBM25(bm25Index, symbolName, 1, config.bm25FieldWeights);
  const topResult = results[0];
  if (!topResult) return null;

  const index = await requireCodeIndex(repo);

  // Get full symbol with source
  const fullResult = await getSymbol(repo, topResult.symbol.id, { include_related: false });
  if (!fullResult) return null;
  const fullSymbol = fullResult.symbol;

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

  // React-specific enrichment for components
  const bundle: ContextBundle = { symbol: fullSymbol, imports, siblings, types_used: typesUsed };
  if (fullSymbol.kind === "component") {
    bundle.react_context = buildReactContext(fullSymbol, index.symbols);
  }

  return bundle;
}

/**
 * Build React-specific context for a component symbol:
 * hooks used, child/parent components via JSX, wrapper pattern.
 *
 * Uses REACT_STDLIB_HOOKS imported from react-tools.js as the single source
 * of truth for stdlib hook detection (CQ14 — no duplication).
 */
function buildReactContext(
  component: CodeSymbol,
  allSymbols: CodeSymbol[],
): ReactContext {
  const source = component.source ?? "";

  // Extract hooks used
  const hooksMap = new Map<string, boolean>();
  const hookPattern = /\b(use[A-Z]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = hookPattern.exec(source)) !== null) {
    const name = m[1]!;
    hooksMap.set(name, REACT_STDLIB_HOOKS.has(name));
  }
  const hooks_used = [...hooksMap.entries()].map(([name, is_stdlib]) => ({ name, is_stdlib }));

  // Extract child components from JSX (<PascalCase>)
  const childSet = new Set<string>();
  const jsxPattern = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
  while ((m = jsxPattern.exec(source)) !== null) {
    const name = m[1]!;
    if (name !== component.name) childSet.add(name);
  }
  const child_components = [...childSet].sort();

  // Extract parent components: find other components whose source uses <ThisComponent>
  const ownPattern = new RegExp(`<${component.name}\\b`);
  const parent_components = allSymbols
    .filter(
      (s) =>
        s.kind === "component" &&
        s.id !== component.id &&
        s.name !== component.name &&
        s.source &&
        ownPattern.test(s.source),
    )
    .map((s) => s.name);

  // Detect wrapper pattern from source — supports TypeScript generics:
  // forwardRef<HTMLDivElement, Props>(...), memo<Props>(...) (Item 9)
  let wrapper: "memo" | "forwardRef" | "lazy" | null = null;
  if (/\b(?:React\.)?memo\s*(?:<[^>]+>)?\s*\(/.test(source)) wrapper = "memo";
  else if (/\b(?:React\.)?forwardRef\s*(?:<[^>]+>)?\s*\(/.test(source)) wrapper = "forwardRef";
  else if (/\b(?:React\.)?lazy\s*(?:<[^>]+>)?\s*\(/.test(source)) wrapper = "lazy";

  // Extract props type from signature: (props: MyProps) or ({ a, b }: Props)
  let props_type: string | null = null;
  const sig = component.signature ?? "";
  // Pattern: (props: TypeName) or (arg: TypeName) or ({ ... }: TypeName)
  const propsMatch = sig.match(/\(\s*(?:\{[^}]*\}|\w+)\s*:\s*([A-Z]\w*)/);
  if (propsMatch) {
    props_type = propsMatch[1]!;
  }

  // Resolve props interface body when type name found in the index (Tier 4 — Item 16).
  // Look for an interface or type alias with the same name as props_type.
  let props_interface_source: string | null = null;
  if (props_type) {
    const decl = allSymbols.find(
      (s) => (s.kind === "interface" || s.kind === "type") && s.name === props_type,
    );
    if (decl?.source) {
      // Cap to 800 chars to keep bundle compact
      props_interface_source = decl.source.length > 800
        ? decl.source.slice(0, 800) + "..."
        : decl.source;
    }
  }

  return { props_type, props_interface_source, hooks_used, child_components, parent_components, wrapper };
}

/**
 * Extract type/interface names referenced in source by matching against known symbols.
 */
function extractTypesUsed(source: string, allSymbols: CodeSymbol[]): string[] {
  const typeNames = allSymbols
    .filter((s) => (s.kind === "interface" || s.kind === "type" || s.kind === "enum") && s.name.length >= 3)
    .map((s) => s.name);

  if (typeNames.length === 0) return [];

  // Single combined regex instead of N separate tests (O(n) vs O(n*m))
  const escaped = typeNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const combined = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
  const used = new Set<string>();
  let m;
  while ((m = combined.exec(source)) !== null) {
    used.add(m[1]!);
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
  truncated?: boolean;
}

// Kinds that are typically exported and should have external references
const EXPORTABLE_KINDS = new Set<SymbolKind>([
  "function", "class", "interface", "type", "variable", "constant", "enum",
  "component", "hook",
]);

/**
 * Collect top-level symbols of exportable kinds, filtered by test/pattern options.
 */
function collectExportedSymbols(
  symbols: CodeSymbol[],
  options: { includeTests: boolean; filePattern?: string | undefined },
): CodeSymbol[] {
  return symbols.filter((s) => {
    if (!EXPORTABLE_KINDS.has(s.kind)) return false;
    if (s.parent) return false;
    if (!options.includeTests && isTestFile(s.file)) return false;
    if (options.filePattern && !s.file.includes(options.filePattern)) return false;
    if (s.name.length < 3) return false;
    if (s.kind === "variable" && s.name === "default") return false;
    return true;
  });
}

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
  const index = await requireCodeIndex(repo);
  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  const exportedSymbols = collectExportedSymbols(index.symbols, { includeTests, filePattern });
  const frameworks = detectFrameworks(index);

  // Read non-test files into memory for scanning (capped to prevent OOM on large repos)
  const MAX_SCAN_FILES = 2000;
  const fileContents = new Map<string, string>();
  for (const file of index.files) {
    if (fileContents.size >= MAX_SCAN_FILES) break;
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
    if (isFrameworkEntryPoint(sym, frameworks)) continue;

    const pattern = wordBoundaryPattern(sym.name);

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
    ...(candidates.length >= MAX_DEAD_CODE_RESULTS ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Unused import detection
// ---------------------------------------------------------------------------

const MAX_UNUSED_IMPORTS = 200;

export interface UnusedImport {
  file: string;
  line: number;
  import_text: string;
  imported_name: string;
}

export interface UnusedImportsResult {
  unused: UnusedImport[];
  scanned_files: number;
  truncated?: boolean;
}

/**
 * Find imports whose imported names are never referenced in the file body.
 * Supports ES module named imports: import { A, B } from '...'
 */
export async function findUnusedImports(
  repo: string,
  options?: { file_pattern?: string; include_tests?: boolean },
): Promise<UnusedImportsResult> {
  const index = await requireCodeIndex(repo);
  const includeTests = options?.include_tests ?? false;

  const unused: UnusedImport[] = [];
  let scannedFiles = 0;

  for (const file of index.files) {
    if (unused.length >= MAX_UNUSED_IMPORTS) break;
    if (!includeTests && isTestFile(file.path)) continue;
    if (options?.file_pattern && !file.path.includes(options.file_pattern)) continue;

    // Only analyze JS/TS/Kotlin files
    if (!/\.(ts|tsx|js|jsx|mjs|kt|kts)$/.test(file.path)) continue;

    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }
    scannedFiles++;

    const lines = source.split("\n");

    // Find named import lines: import { A, B, C } from '...'
    // Also: import A from '...'  and  import * as A from '...'
    const importRegex = /^import\s+(?:type\s+)?(?:\{([^}]+)\}|(\*\s+as\s+\w+)|(\w+)).*from\s+['"][^'"]+['"]/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line.startsWith("import ")) continue;
      // Stop scanning imports when we hit non-import code
      if (i > 0 && !line.startsWith("import") && !line.startsWith("//") && !line.startsWith("/*") && line.length > 0 && !lines[i]!.trim().startsWith("*") && !lines[i]!.trim().startsWith("}")) {
        // Could be multi-line import continuation, keep going
      }

      const match = importRegex.exec(line);
      if (!match) continue;

      const names: string[] = [];
      if (match[1]) {
        // Named imports: { A, B as C, type D }
        for (const part of match[1].split(",")) {
          const trimmed = part.trim().replace(/^type\s+/, "");
          if (!trimmed) continue;
          // Handle "A as B" — the local name is B
          const asMatch = /(\w+)\s+as\s+(\w+)/.exec(trimmed);
          names.push(asMatch ? asMatch[2]! : trimmed);
        }
      } else if (match[2]) {
        // Namespace import: * as A
        const nsMatch = /\*\s+as\s+(\w+)/.exec(match[2]);
        if (nsMatch) names.push(nsMatch[1]!);
      } else if (match[3]) {
        // Default import: import A
        names.push(match[3]);
      }

      // Check each imported name against rest of file
      const bodyAfterImports = lines.slice(i + 1).join("\n");
      for (const name of names) {
        if (name.length < 2) continue;
        const nameRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!nameRegex.test(bodyAfterImports)) {
          unused.push({
            file: file.path,
            line: i + 1,
            import_text: line,
            imported_name: name,
          });
          if (unused.length >= MAX_UNUSED_IMPORTS) break;
        }
      }
    }
  }

  return {
    unused,
    scanned_files: scannedFiles,
    ...(unused.length >= MAX_UNUSED_IMPORTS ? { truncated: true } : {}),
  };
}
