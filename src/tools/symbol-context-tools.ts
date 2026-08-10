import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { searchBM25 } from "../search/bm25.js";
import type { CodeSymbol, Reference, SymbolKind } from "../types.js";
import { extractHookNames, REACT_STDLIB_HOOKS } from "./react-tools.js";
import {
  resolveSearchHit,
  type SymbolIdAmbiguity,
} from "./symbol-lookup-tools.js";
import { findReferences } from "./symbol-reference-tools.js";
import {
  requireBM25Index,
  requireCodeIndex,
} from "./symbol-tool-internals.js";

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
): Promise<
  { symbol: CodeSymbol; references?: Reference[]; id_ambiguity: SymbolIdAmbiguity } | null
> {
  const bm25Index = await requireBM25Index(repo);
  const config = loadConfig();
  const results = searchBM25(bm25Index, query, 1, config.bm25FieldWeights);

  const topResult = results[0];
  if (!topResult) return null;

  const resolved = await resolveSearchHit(repo, topResult.symbol);
  if (!resolved) return null;
  const { symbol: fullSymbol, ambiguity } = resolved;

  if (includeRefs) {
    const references = await findReferences(repo, fullSymbol.name as string);
    return { symbol: fullSymbol, references, id_ambiguity: ambiguity };
  }

  return { symbol: fullSymbol, id_ambiguity: ambiguity };
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
  /** Always present. Says whether `symbol` is a unique resolution or the search's top hit among
   *  several sharing one id — a distinction the caller cannot otherwise make from the result. */
  id_ambiguity: SymbolIdAmbiguity;
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
  const resolved = await resolveSearchHit(repo, topResult.symbol);
  if (!resolved) return null;
  const { symbol: fullSymbol, ambiguity } = resolved;

  // Read the file to extract imports
  let fileSource: string;
  try {
    fileSource = await readFile(join(index.root, fullSymbol.file), "utf-8");
  } catch {
    return {
      symbol: fullSymbol,
      imports: [],
      siblings: [],
      types_used: [],
      id_ambiguity: ambiguity,
    };
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
  const bundle: ContextBundle = {
    symbol: fullSymbol,
    imports,
    siblings,
    types_used: typesUsed,
    id_ambiguity: ambiguity,
  };
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

  // Extract hooks used (uses shared extractHookNames from react-tools.ts — CQ14)
  const hooks_used = [...extractHookNames(source)].map((name) => ({
    name,
    is_stdlib: REACT_STDLIB_HOOKS.has(name),
  }));

  // Extract child components from JSX (<PascalCase>)
  const childSet = new Set<string>();
  const jsxPattern = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
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
