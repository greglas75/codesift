import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import type { SymbolKind } from "../types.js";

const ANALYZABLE_KINDS = new Set<SymbolKind>([
  "function", "method", "class", "component", "hook",
]);

// Patterns that increase cyclomatic complexity (decision points)
const BRANCH_PATTERNS = [
  /\bif\s*\(/g,
  /\belse\s+if\s*\(/g,
  /\bcase\s+/g,
  /\bcatch\s*\(/g,
  /\?\s*[^:]/g,       // ternary operator
  /\&\&/g,
  /\|\|/g,
  /\?\?/g,            // nullish coalescing
  // Kotlin branch patterns
  /\bwhen\s*[\({]/g,  // when expression/statement
  /\?\.let\s*\{/g,    // safe call + lambda
  /\?\.run\s*\{/g,    // safe call + run
  /\?:/g,             // Elvis operator
  // PHP branch patterns
  /\bforeach\s*\(/g,  // foreach loop
  /\belseif\s*\(/g,   // PHP elseif (one word)
  /\bmatch\s*\(/g,    // PHP 8 match expression
];

// Patterns that increase nesting
const NESTING_OPENERS = /\b(if|for|foreach|while|switch|try|when|match)\s*[\({]/g;

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
  };
}

/**
 * Estimate cyclomatic complexity from source text.
 * Counts decision points: if, else if, case, catch, &&, ||, ??, ternary.
 * McCabe complexity = branches + 1.
 */
function countBranches(source: string): number {
  let branches = 0;
  for (const pattern of BRANCH_PATTERNS) {
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
function estimateMaxNesting(source: string): number {
  let maxDepth = 0;
  let currentDepth = 0;

  // Track brace depth, only incrementing on control-flow-related braces
  const lines = source.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and strings (rough heuristic)
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Check for nesting openers
    NESTING_OPENERS.lastIndex = 0;
    if (NESTING_OPENERS.test(trimmed)) {
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

  // Filter to analyzable symbols
  const symbols = index.symbols.filter((s) => {
    if (!ANALYZABLE_KINDS.has(s.kind)) return false;
    if (!s.source || s.source.length < 10) return false;
    if (!includeTests && isTestFile(s.file)) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  const results: ComplexityInfo[] = [];

  for (const sym of symbols) {
    const source = sym.source!;
    const lines = source.split("\n").length;
    const branches = countBranches(source);
    const complexity = branches + 1;
    const nesting = estimateMaxNesting(source);

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
    },
  };
}

