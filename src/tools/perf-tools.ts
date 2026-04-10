import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { SymbolKind } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PerfFinding {
  pattern: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  name: string;
  kind: SymbolKind;
  context: string;
  fix_hint: string;
}

export interface PerfHotspotsResult {
  findings: PerfFinding[];
  patterns_checked: number;
  symbols_scanned: number;
  summary: { high: number; medium: number; low: number };
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface PerfPattern {
  regex: RegExp;
  description: string;
  severity: "high" | "medium" | "low";
  file_scope?: RegExp;
  fix_hint: string;
}

const PERF_PATTERNS: Record<string, PerfPattern> = {
  "unbounded-query": {
    regex: /\.(findMany|find|findAll|select)\s*\(\s*\{(?:(?!\btake\b|\blimit\b|\bfirst\b|\btop\b)[\s\S])*?\}\s*\)/,
    description: "DB query without take/limit — unbounded result set",
    severity: "high",
    fix_hint: "Add take/limit to cap result size, or use cursor-based pagination",
  },
  "sync-in-handler": {
    regex: /\b(readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|readdirSync|execSync|spawnSync)\s*\(/,
    description: "Synchronous I/O in request handler — blocks event loop",
    severity: "high",
    file_scope: /\b(route|handler|controller|middleware|api|endpoint|server)\b/i,
    fix_hint: "Use async equivalent (readFile, writeFile, exec) to avoid blocking",
  },
  // n-plus-one handled specially — needs balanced-brace loop body extraction.
  // See scanNPlusOne() below.
  "unbounded-parallel": {
    regex: /Promise\.all\s*\(\s*\w+\.map\s*\(/,
    description: "Promise.all(arr.map(...)) without concurrency control",
    severity: "medium",
    fix_hint: "Use pLimit, p-map, or chunk the array to limit concurrent operations",
  },
  "missing-pagination": {
    regex: /\b(res|response|ctx)\.(json|send|status)\s*\([\s\S]*?\b(findMany|find|findAll|select|getAll|list)\b/,
    description: "API response from unbounded list query — missing pagination",
    severity: "medium",
    file_scope: /\b(route|handler|controller|api|endpoint)\b/i,
    fix_hint: "Add skip/take or cursor params, return {data, total, next_cursor}",
  },
  // expensive-recompute handled specially — see scanExpensiveRecompute() below.
};

// N+1 metadata (separate from PERF_PATTERNS because it needs custom scanning)
const N_PLUS_ONE_META = {
  description: "DB/fetch call inside loop — N+1 query pattern",
  severity: "high" as const,
  fix_hint: "Batch queries outside the loop using IN clause or Promise.all with pre-fetched IDs",
};

const EXPENSIVE_RECOMPUTE_META = {
  description: "Same method called multiple times inside loop body",
  severity: "low" as const,
  fix_hint: "Hoist the call before the loop or memoize the result",
};

// DB call regex — matches method calls that typically indicate DB/fetch
const DB_CALL_REGEX = /\.(findMany|findFirst|findUnique|findOne|findById|query)\s*\(|\bfetch\s*\(/;

// Common identifiers to exclude from expensive-recompute backreference
const RECOMPUTE_BLACKLIST = new Set([
  "if", "for", "while", "return", "throw", "yield", "await", "new", "typeof",
  "log", "warn", "error", "info", "debug", "push", "pop", "shift", "unshift",
  "set", "get", "has", "delete", "add", "then", "catch", "finally", "map",
  "filter", "forEach", "reduce", "some", "every", "find", "includes",
]);

/**
 * Extract the body of a loop starting at `loopStartIdx` (position of `{` after
 * `for`/`while` header). Returns the body content between braces, or null if
 * the braces don't match. Does NOT handle strings or comments — acceptable for
 * a pattern scanner (will return overly-large body, not smaller).
 */
function extractLoopBody(source: string, openBraceIdx: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = openBraceIdx; i < source.length; i++) {
    if (source[i] === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) return source.slice(start, i);
    }
  }
  return null;
}

/**
 * Scan a symbol's source for loops and check if any loop body contains a DB call.
 * Returns the first match found (line number relative to source start).
 */
function scanNPlusOne(source: string): { line: number; context: string } | null {
  const loopHeaderRegex = /\b(for|while)\s*\([^)]*\)\s*\{/g;
  let headerMatch;
  while ((headerMatch = loopHeaderRegex.exec(source)) !== null) {
    const openBraceIdx = source.indexOf("{", headerMatch.index);
    if (openBraceIdx === -1) continue;
    const body = extractLoopBody(source, openBraceIdx);
    if (!body) continue;
    const dbMatch = DB_CALL_REGEX.exec(body);
    if (dbMatch) {
      const linesBefore = source.slice(0, openBraceIdx).split("\n").length;
      const contextLine = dbMatch[0].split("\n")[0]!.trim();
      return { line: linesBefore, context: contextLine };
    }
  }
  return null;
}

/**
 * Scan a loop body for the same method called 2+ times.
 * Excludes control flow keywords and common JS methods via RECOMPUTE_BLACKLIST.
 */
function scanExpensiveRecompute(source: string): { line: number; context: string } | null {
  const loopHeaderRegex = /\b(for|while)\s*\([^)]*\)\s*\{/g;
  let headerMatch;
  while ((headerMatch = loopHeaderRegex.exec(source)) !== null) {
    const openBraceIdx = source.indexOf("{", headerMatch.index);
    if (openBraceIdx === -1) continue;
    const body = extractLoopBody(source, openBraceIdx);
    if (!body) continue;

    // Collect dot-method call names (at least 3 chars) and count occurrences
    const methodCounts = new Map<string, number>();
    const callRegex = /\.(\w{3,})\s*\(/g;
    let callMatch;
    while ((callMatch = callRegex.exec(body)) !== null) {
      const name = callMatch[1]!;
      if (RECOMPUTE_BLACKLIST.has(name)) continue;
      methodCounts.set(name, (methodCounts.get(name) ?? 0) + 1);
    }

    for (const [name, count] of methodCounts) {
      if (count >= 2) {
        const linesBefore = source.slice(0, openBraceIdx).split("\n").length;
        return { line: linesBefore, context: `.${name}() called ${count}× in loop body` };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function listPerfPatterns(): Record<string, { description: string; severity: string }> {
  const out: Record<string, { description: string; severity: string }> = {};
  for (const [name, p] of Object.entries(PERF_PATTERNS)) {
    out[name] = { description: p.description, severity: p.severity };
  }
  out["n-plus-one"] = { description: N_PLUS_ONE_META.description, severity: N_PLUS_ONE_META.severity };
  out["expensive-recompute"] = { description: EXPENSIVE_RECOMPUTE_META.description, severity: EXPENSIVE_RECOMPUTE_META.severity };
  return out;
}

export async function findPerfHotspots(
  repo: string,
  options?: {
    patterns?: string[];
    file_pattern?: string;
    include_tests?: boolean;
    max_results?: number;
  },
): Promise<PerfHotspotsResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 50;
  const requestedPatterns = options?.patterns;
  const enabledRegexPatterns = requestedPatterns
    ? Object.entries(PERF_PATTERNS).filter(([name]) => requestedPatterns.includes(name))
    : Object.entries(PERF_PATTERNS);
  const nPlusOneEnabled = !requestedPatterns || requestedPatterns.includes("n-plus-one");
  const expensiveRecomputeEnabled = !requestedPatterns || requestedPatterns.includes("expensive-recompute");

  const findings: PerfFinding[] = [];
  let scanned = 0;

  const addFinding = (sym: typeof index.symbols[0], patternName: string, meta: { severity: "high" | "medium" | "low"; fix_hint: string }, lineOffset: number, context: string): void => {
    findings.push({
      pattern: patternName,
      severity: meta.severity,
      file: sym.file,
      line: sym.start_line + lineOffset - 1,
      name: sym.name,
      kind: sym.kind,
      context: context.length > 120 ? context.slice(0, 117) + "..." : context,
      fix_hint: meta.fix_hint,
    });
  };

  for (const sym of index.symbols) {
    if (findings.length >= maxResults) break;
    if (!sym.source) continue;
    if (!includeTests && isTestFile(sym.file)) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    scanned++;

    // Regex-based patterns
    for (const [patternName, pattern] of enabledRegexPatterns) {
      if (findings.length >= maxResults) break;

      // Apply file_scope filter
      if (pattern.file_scope && !pattern.file_scope.test(sym.file)) continue;

      const match = pattern.regex.exec(sym.source);
      if (match) {
        const matchStart = match.index;
        const linesBefore = sym.source.slice(0, matchStart).split("\n").length;
        const matchedLine = match[0].split("\n")[0]!.trim();
        addFinding(sym, patternName, pattern, linesBefore, matchedLine);
      }
    }

    // Custom scanners (require balanced-brace parsing)
    if (nPlusOneEnabled && findings.length < maxResults) {
      const result = scanNPlusOne(sym.source);
      if (result) addFinding(sym, "n-plus-one", N_PLUS_ONE_META, result.line, result.context);
    }

    if (expensiveRecomputeEnabled && findings.length < maxResults) {
      const result = scanExpensiveRecompute(sym.source);
      if (result) addFinding(sym, "expensive-recompute", EXPENSIVE_RECOMPUTE_META, result.line, result.context);
    }
  }

  // Sort: high first, then medium, then low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const totalPatternsChecked = enabledRegexPatterns.length
    + (nPlusOneEnabled ? 1 : 0)
    + (expensiveRecomputeEnabled ? 1 : 0);

  return {
    findings,
    patterns_checked: totalPatternsChecked,
    symbols_scanned: scanned,
    summary: {
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    },
  };
}
