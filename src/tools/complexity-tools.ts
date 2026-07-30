import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { SymbolKind } from "../types.js";

const ANALYZABLE_KINDS = new Set<SymbolKind>([
  "function", "method", "class", "component", "hook",
]);

// Decision-point patterns shared by every language.
//
// The ternary regex deliberately excludes `?` when followed by `?`, `.`, `:` or
// `-`, and when preceded by `?`. Without those guards it fires on constructs that
// are not branches at all: `name?: string` (optional TS property/param),
// `a?.b` (optional chaining), `a ?? b` (nullish, counted separately below) and
// `$a?->b` (PHP nullsafe).
const COMMON_BRANCH_PATTERNS = [
  /\bif\s*\(/g,
  /\belse\s+if\s*\(/g,
  /\bcase\s+/g,
  /\bcatch\s*\(/g,
  /(?<!\?)\?(?![?.:\-])/g, // ternary operator
  /\&\&/g,
  /\|\|/g,
  /\?\?/g,            // nullish coalescing
];

// Language-specific decision points. These MUST stay gated by file language:
// applied globally they produce large false positives in other languages —
// Kotlin's Elvis `?:` matches every optional TypeScript property (`field?: T`),
// and PHP's `match(` matches every JavaScript `str.match(...)` call. A 126-field
// NestJS DTO scored cyclomatic_complexity=82 with max_nesting_depth=0 before
// this gating, and got queued for a refactor it did not need.
const KOTLIN_BRANCH_PATTERNS = [
  /\bwhen\s*[\({]/g,  // when expression/statement
  /\?\.let\s*\{/g,    // safe call + lambda
  /\?\.run\s*\{/g,    // safe call + run
  /\?:/g,             // Elvis operator
];

const PHP_BRANCH_PATTERNS = [
  /\bforeach\s*\(/g,  // foreach loop
  /\belseif\s*\(/g,   // PHP elseif (one word)
  /\bmatch\s*\(/g,    // PHP 8 match expression
  /\?:/g,             // short ternary
];

function branchPatternsFor(language: string | undefined): RegExp[] {
  if (language === "kotlin") return [...COMMON_BRANCH_PATTERNS, ...KOTLIN_BRANCH_PATTERNS];
  if (language === "php") return [...COMMON_BRANCH_PATTERNS, ...PHP_BRANCH_PATTERNS];
  return COMMON_BRANCH_PATTERNS;
}

// Patterns that increase nesting — gated for the same reason as branches.
const COMMON_NESTING_OPENERS = /\b(if|for|while|switch|try)\s*[\({]/g;
const KOTLIN_NESTING_OPENERS = /\b(if|for|while|switch|try|when)\s*[\({]/g;
const PHP_NESTING_OPENERS = /\b(if|for|foreach|while|switch|try|match)\s*[\({]/g;

function nestingOpenersFor(language: string | undefined): RegExp {
  if (language === "kotlin") return KOTLIN_NESTING_OPENERS;
  if (language === "php") return PHP_NESTING_OPENERS;
  return COMMON_NESTING_OPENERS;
}

/**
 * Cooperative wall-clock budget for the synchronous per-symbol scan. This loop
 * runs regexes over every symbol's source (up to ~77k symbols on large repos);
 * raceWallClock cannot interrupt a synchronous loop, so instead we check elapsed
 * time inside it and return partial — but still useful, since results are ranked
 * top-N by complexity — output with a `truncated` flag. Telemetry (2026-07):
 * analyze_complexity had a 1,006,938ms (~16 min) max that blocked the agent.
 * Override via CODESIFT_COMPLEXITY_CAP_MS.
 */
const COMPLEXITY_WALL_CLOCK_MS = (() => {
  const env = process.env["CODESIFT_COMPLEXITY_CAP_MS"];
  const parsed = env ? Number(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();

export interface ComplexityInfo {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  lines: number;
  cyclomatic_complexity: number;
  max_nesting_depth: number;
  branches: number;
  // React-specific metrics (only populated for kind === "component" or "hook")
  hook_count?: number;       // total use*() calls
  state_count?: number;      // useState() calls
  effect_count?: number;     // useEffect() calls
  jsx_depth?: number;        // max nesting of <Component>
}

export interface ComplexityResult {
  functions: ComplexityInfo[];
  summary: {
    total_functions: number;
    avg_complexity: number;
    avg_lines: number;
    max_complexity: number;
    max_nesting: number;
    above_threshold: number;
    /** Set when the per-symbol scan hit COMPLEXITY_WALL_CLOCK_MS and stopped early. */
    truncated?: boolean;
    /** Symbols actually scanned before truncation (present only when truncated). */
    analyzed_symbols?: number;
    /** Total candidate symbols that would have been scanned (present only when truncated). */
    total_symbols?: number;
  };
}

/**
 * Estimate cyclomatic complexity from source text.
 * Counts decision points: if, else if, case, catch, &&, ||, ??, ternary.
 * McCabe complexity = branches + 1.
 */
function countBranches(source: string, language?: string): number {
  let branches = 0;
  for (const pattern of branchPatternsFor(language)) {
    pattern.lastIndex = 0;
    while (pattern.exec(source) !== null) {
      branches++;
    }
  }
  return branches;
}

/**
 * Count React hook calls in source text.
 * Returns { total, state, effect } for useState, useEffect, and generic use*() calls.
 */
function countReactHooks(source: string): { total: number; state: number; effect: number } {
  let total = 0;
  let state = 0;
  let effect = 0;
  const pattern = /\b(use[A-Z]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const name = m[1]!;
    total++;
    if (name === "useState") state++;
    else if (name === "useEffect") effect++;
  }
  return { total, state, effect };
}

/**
 * Estimate max JSX nesting depth by tracking < and </.
 * Counts opening tags (<PascalCase or <lowercase) minus self-closing.
 * Heuristic: scan linearly and track stack depth.
 */
function estimateJsxDepth(source: string): number {
  let maxDepth = 0;
  let depth = 0;
  // Match: <TagName ...>  or  </TagName>  or  <TagName .../>
  const tagPattern = /<(\/?)([A-Za-z][\w.]*)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagPattern.exec(source)) !== null) {
    const closing = m[1] === "/";
    const selfClosing = m[3] === "/";
    if (closing) {
      if (depth > 0) depth--;
    } else if (!selfClosing) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    }
    // self-closing: no change to depth
  }
  return maxDepth;
}

/**
 * Estimate max nesting depth by tracking brace depth around control flow.
 * Simple heuristic: count opening braces after control flow keywords.
 */
function estimateMaxNesting(source: string, language?: string): number {
  const nestingOpeners = nestingOpenersFor(language);
  let maxDepth = 0;
  let currentDepth = 0;

  // Track brace depth, only incrementing on control-flow-related braces
  const lines = source.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and strings (rough heuristic)
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Check for nesting openers
    nestingOpeners.lastIndex = 0;
    if (nestingOpeners.test(trimmed)) {
      currentDepth++;
      if (currentDepth > maxDepth) maxDepth = currentDepth;
    }

    // Closing brace that likely ends a control flow block
    if (trimmed === "}" || trimmed === "} else {" || trimmed.startsWith("} catch") || trimmed.startsWith("} finally")) {
      if (currentDepth > 0) currentDepth--;
    }
  }

  return maxDepth;
}

/**
 * Analyze complexity of functions in a repository.
 * Returns top N most complex functions sorted by cyclomatic complexity.
 */
export async function analyzeComplexity(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    top_n?: number | undefined;
    min_complexity?: number | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<ComplexityResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const topN = options?.top_n ?? 30;
  const minComplexity = options?.min_complexity ?? 1;
  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  // Per-file language drives both SQL exclusion and which branch/nesting
  // patterns apply — Kotlin- and PHP-only decision points must not be counted
  // in other languages (see branchPatternsFor).
  const fileLanguage = new Map(index.files.map((f) => [f.path, f.language]));
  const sqlFiles = new Set(
    index.files
      .filter((f) => f.language === "sql" || f.language === "sql-jinja")
      .map((f) => f.path),
  );

  // Filter to analyzable symbols
  const symbols = index.symbols.filter((s) => {
    if (!ANALYZABLE_KINDS.has(s.kind)) return false;
    // Skip SQL files — cyclomatic complexity is meaningless for DDL
    if (sqlFiles.has(s.file)) return false;
    if (!s.source || s.source.length < 10) return false;
    if (!includeTests && isTestFile(s.file)) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  const results: ComplexityInfo[] = [];

  const scanStart = Date.now();
  let scanned = 0;
  let truncated = false;
  for (const sym of symbols) {
    // Cooperative time budget — checked every 512 symbols so the check itself is
    // negligible. Stops a pathological huge-repo scan from hanging the agent.
    if ((scanned++ & 0x1ff) === 0 && Date.now() - scanStart > COMPLEXITY_WALL_CLOCK_MS) {
      truncated = true;
      break;
    }
    const source = sym.source!;
    const language = fileLanguage.get(sym.file);
    const lines = source.split("\n").length;
    const branches = countBranches(source, language);
    const complexity = branches + 1;
    const nesting = estimateMaxNesting(source, language);

    if (complexity >= minComplexity) {
      const info: ComplexityInfo = {
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        start_line: sym.start_line,
        end_line: sym.end_line,
        lines,
        cyclomatic_complexity: complexity,
        max_nesting_depth: nesting,
        branches,
      };

      // React-specific metrics for components and hooks
      if (sym.kind === "component" || sym.kind === "hook") {
        const hooks = countReactHooks(source);
        info.hook_count = hooks.total;
        info.state_count = hooks.state;
        info.effect_count = hooks.effect;
        if (sym.kind === "component") {
          info.jsx_depth = estimateJsxDepth(source);
        }
      }

      results.push(info);
    }
  }

  // Sort by complexity descending
  results.sort((a, b) => b.cyclomatic_complexity - a.cyclomatic_complexity);
  const top = results.slice(0, topN);

  // Summary stats
  const totalFunctions = results.length;
  const avgComplexity = totalFunctions > 0
    ? Math.round((results.reduce((s, r) => s + r.cyclomatic_complexity, 0) / totalFunctions) * 10) / 10
    : 0;
  const avgLines = totalFunctions > 0
    ? Math.round(results.reduce((s, r) => s + r.lines, 0) / totalFunctions)
    : 0;
  const maxComplexity = top[0]?.cyclomatic_complexity ?? 0;
  const maxNesting = Math.max(0, ...results.map((r) => r.max_nesting_depth));
  const aboveThreshold = results.filter((r) => r.cyclomatic_complexity > 10).length;

  return {
    functions: top,
    summary: {
      total_functions: totalFunctions,
      avg_complexity: avgComplexity,
      avg_lines: avgLines,
      max_complexity: maxComplexity,
      max_nesting: maxNesting,
      above_threshold: aboveThreshold,
      ...(truncated
        ? { truncated: true, analyzed_symbols: scanned - 1, total_symbols: symbols.length }
        : {}),
    },
  };
}

