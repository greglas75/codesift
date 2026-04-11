import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { SymbolKind } from "../types.js";

export interface PatternMatch {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  matched_pattern: string;
  context: string;            // the matching line(s)
}

export interface PatternResult {
  matches: PatternMatch[];
  pattern: string;
  scanned_symbols: number;
}

// Built-in patterns inspired by CQ checklist + common React/TS anti-patterns
export const BUILTIN_PATTERNS: Record<string, {
  regex: RegExp;
  description: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
}> = {
  "useEffect-no-cleanup": {
    regex: /useEffect\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{(?:(?!return\s*\(\s*\)\s*=>|return\s+\(\)\s*=>|return\s*\(\s*\)\s*\{|return\s+function)[\s\S])*\}\s*,/,
    description: "useEffect without cleanup return — potential memory leak (CQ22)",
  },
  "empty-catch": {
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
    description: "Empty catch block — swallowed error (CQ8)",
  },
  "any-type": {
    regex: /:\s*any\b|as\s+any\b/,
    description: "Usage of 'any' type — lose type safety",
  },
  "console-log": {
    regex: /console\.(log|debug|info)\s*\(/,
    description: "console.log in production code — use structured logger (CQ13)",
  },
  "await-in-loop": {
    regex: /for\s*\([\s\S]*?\)\s*\{[\s\S]*?await\s/,
    description: "Sequential await inside loop — use Promise.all (CQ17)",
  },
  "no-error-type": {
    regex: /catch\s*\(\s*(\w+)\s*\)\s*\{(?:(?!instanceof\s+Error)[\s\S])*\}/,
    description: "Catch without instanceof Error narrowing (CQ8)",
  },
  "toctou": {
    regex: /findFirst|findUnique[\s\S]{0,200}update\s*\(/,
    description: "Potential TOCTOU: read then write without atomic operation (CQ21)",
  },
  "unbounded-findmany": {
    regex: /findMany\s*\(\s*\{(?:(?!take\b|limit\b)[\s\S])*\}\s*\)/,
    description: "findMany without take/limit — unbounded query (CQ7)",
  },
  "scaffolding": {
    regex: /\/\/\s*(TODO|FIXME|HACK|XXX|TEMP|TEMPORARY)\b|\/\/\s*(Phase|Step|Stage)\s*\d|\/\/\s*(placeholder|stub|dummy)\b|throw new Error\(['"]not implemented['"]\)|console\.(log|warn)\(['"]TODO\b/i,
    description: "Scaffolding markers: TODO/FIXME/HACK, Phase/Step markers, placeholder stubs, not-implemented throws (tech debt)",
  },
  "nextjs-wrong-router": {
    regex: /from\s+['"]next\/router['"]|require\s*\(\s*['"]next\/router['"]\s*\)/,
    description: "Using next/router (Pages Router) in App Router file — use next/navigation instead",
    fileExcludePattern: /(^|\/)pages\//,
  },
  "nextjs-fetch-waterfall": {
    regex: /await\s+fetch\s*\([^)]*\)[\s\S]{0,300}await\s+fetch\s*\(/,
    description: "Sequential await fetch calls — use Promise.all to avoid waterfall (Next.js performance)",
  },
  "nextjs-unnecessary-use-client": {
    regex: /['"]use client['"](?![\s\S]*(?:useState|useEffect|useRef|useCallback|useMemo|useContext|useReducer|onClick|onChange|onSubmit|window\.|document\.|localStorage\.))/,
    description: "File has 'use client' but may not need it — no hooks, events, or browser globals detected",
  },
  "nextjs-pages-in-app": {
    regex: /./,
    description: "Pages Router convention (index.tsx) inside app/ directory — use page.tsx for App Router",
    fileIncludePattern: /(^|\/)app\/.*\/index\.(tsx|jsx|ts|js)$|^app\/index\.(tsx|jsx|ts|js)$/,
  },
  "nextjs-missing-error-boundary": {
    regex: /./,
    description: "Page file without sibling error.tsx — no error boundary for graceful error handling",
    fileIncludePattern: /(^|\/)app\/.*\/page\.[jt]sx?$/,
  },
  "nextjs-use-client-in-layout": {
    regex: /^[\s\S]{0,512}['"]use client['"]/,
    description: "Layout file with 'use client' — layouts should be Server Components for optimal performance",
    fileIncludePattern: /(^|\/)app\/.*\/layout\.[jt]sx?$|^app\/layout\.[jt]sx?$/,
  },
  "nextjs-missing-metadata": {
    regex: /./,
    description: "Page file without metadata or generateMetadata export — missing SEO metadata",
    fileIncludePattern: /(^|\/)app\/.*\/page\.[jt]sx?$/,
  },
};

/**
 * Search for structural code patterns across indexed symbols.
 * Supports built-in patterns (by name) or custom regex.
 */
export async function searchPatterns(
  repo: string,
  pattern: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
    max_results?: number | undefined;
  },
): Promise<PatternResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 50;

  // Resolve pattern: built-in name or custom regex
  let regex: RegExp;
  let patternName: string;
  let fileExcludePattern: RegExp | undefined;
  let fileIncludePattern: RegExp | undefined;

  const builtin = BUILTIN_PATTERNS[pattern];
  if (builtin) {
    regex = builtin.regex;
    patternName = `${pattern}: ${builtin.description}`;
    fileExcludePattern = builtin.fileExcludePattern;
    fileIncludePattern = builtin.fileIncludePattern;
  } else {
    try {
      regex = new RegExp(pattern);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex pattern: ${msg}`);
    }
    patternName = pattern;
  }

  const matches: PatternMatch[] = [];
  let scanned = 0;

  for (const sym of index.symbols) {
    if (matches.length >= maxResults) break;
    if (!sym.source) continue;
    if (!includeTests && isTestFile(sym.file)) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (fileExcludePattern && fileExcludePattern.test(sym.file)) continue;
    if (fileIncludePattern && !fileIncludePattern.test(sym.file)) continue;

    scanned++;
    const match = regex.exec(sym.source);
    if (match) {
      // Extract context: the matching line(s)
      const matchStart = match.index;
      const linesBefore = sym.source.slice(0, matchStart).split("\n").length;
      const matchedText = match[0].split("\n")[0]!; // First line of match

      matches.push({
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        start_line: sym.start_line + linesBefore - 1,
        end_line: sym.end_line,
        matched_pattern: patternName,
        context: matchedText.trim().slice(0, 200),
      });
    }
  }

  return {
    matches,
    pattern: patternName,
    scanned_symbols: scanned,
  };
}

/**
 * List all available built-in patterns.
 */
export function listPatterns(): Array<{
  name: string;
  description: string;
  fileExcludePattern?: string;
  fileIncludePattern?: string;
}> {
  return Object.entries(BUILTIN_PATTERNS).map(([name, p]) => ({
    name,
    description: p.description,
    ...(p.fileExcludePattern ? { fileExcludePattern: p.fileExcludePattern.source } : {}),
    ...(p.fileIncludePattern ? { fileIncludePattern: p.fileIncludePattern.source } : {}),
  }));
}

