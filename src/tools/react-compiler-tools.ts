/**
 * React Compiler adoption readiness analysis.
 */
import { getCodeIndex } from "./index-tools.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";

// ─────────────────────────────────────────────────────────────
// audit_compiler_readiness — React Compiler adoption readiness
// ─────────────────────────────────────────────────────────────

const COMPILER_PATTERNS = [
  "compiler-side-effect-in-render",
  "compiler-ref-read-in-render",
  "compiler-prop-mutation",
  "compiler-state-mutation",
  "compiler-try-catch-bailout",
  "compiler-redundant-memo",
  "compiler-redundant-usecallback",
] as const;

export interface CompilerReadinessResult {
  /** 0-100 readiness score (100 = fully compatible) */
  readiness_score: number;
  total_components: number;
  /** Components with 0 bailout patterns */
  compatible_components: number;
  /** Components with ≥1 bailout pattern */
  bailout_components: number;
  /** Count of redundant manual memoization (safe to remove post-adoption) */
  redundant_memoization: number;
  /** Bailout issues by pattern, sorted by frequency */
  issues: Array<{ pattern: string; count: number; description: string }>;
  /** Top components with most bailout issues */
  top_bailout_components: Array<{ name: string; file: string; issues: number }>;
}

/**
 * Audit a React codebase for React Compiler (v1.0) adoption readiness.
 *
 * Scans all components for patterns that cause the compiler to silently
 * bail out of auto-memoization. Returns a readiness score (0-100) with
 * prioritized fix list.
 *
 * No competitor offers codebase-wide compiler readiness analysis.
 */
export async function auditCompilerReadiness(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<CompilerReadinessResult> {
  const { searchPatterns } = await import("./pattern-tools.js");
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository not found: ${repo}`);

  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  // Count total components
  let components = index.symbols.filter((s) => s.kind === "component");
  if (!includeTests) components = components.filter((s) => !isTestFile(s.file));
  if (filePattern) components = components.filter((s) => s.file.includes(filePattern));
  const totalComponents = components.length;

  // Run all compiler patterns in parallel
  const patternResults = await Promise.all(
    COMPILER_PATTERNS.map(async (pattern) => {
      try {
        const result = await searchPatterns(repo, pattern, {
          file_pattern: filePattern,
          include_tests: includeTests,
          max_results: 200,
        });
        return { pattern, matches: result.matches, description: result.pattern };
      } catch {
        return { pattern, matches: [], description: pattern };
      }
    }),
  );

  // Aggregate: which components have bailout issues
  const componentIssues = new Map<string, number>(); // "name@file" → issue count
  let redundantMemoization = 0;
  const issues: CompilerReadinessResult["issues"] = [];

  for (const { pattern, matches, description } of patternResults) {
    if (matches.length === 0) continue;

    const isRedundant = pattern === "compiler-redundant-memo" || pattern === "compiler-redundant-usecallback";
    if (isRedundant) {
      redundantMemoization += matches.length;
    }

    issues.push({
      pattern,
      count: matches.length,
      description: description.split(": ").slice(1).join(": ") || description,
    });

    for (const m of matches) {
      if (!isRedundant) {
        const key = `${m.name}@${m.file}`;
        componentIssues.set(key, (componentIssues.get(key) ?? 0) + 1);
      }
    }
  }

  // Sort issues by count descending
  issues.sort((a, b) => b.count - a.count);

  // Top bailout components
  const top_bailout_components = [...componentIssues.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => {
      const [name, file] = key.split("@");
      return { name: name!, file: file!, issues: count };
    });

  const bailoutCount = componentIssues.size;
  const compatibleCount = Math.max(0, totalComponents - bailoutCount);

  // Readiness score: percentage of components without bailout issues
  const readiness_score = totalComponents > 0
    ? Math.round((compatibleCount / totalComponents) * 100)
    : 100; // empty repo = ready

  return {
    readiness_score,
    total_components: totalComponents,
    compatible_components: compatibleCount,
    bailout_components: bailoutCount,
    redundant_memoization: redundantMemoization,
    issues,
    top_bailout_components,
  };
}
