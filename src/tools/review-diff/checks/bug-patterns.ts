import { listPatterns, searchPatterns } from "../../pattern-tools.js";
import type { CodeIndex } from "../../../types.js";
import type { CheckResult, ReviewFinding } from "../types.js";

interface PatternMatch {
  file: string;
  start_line: number;
  matched_pattern: string;
  context: string;
  name?: string;
}

interface PatternSearchOutput {
  matches: PatternMatch[];
}

/** Pattern names that only apply to React/JSX code — filtered out when no .tsx/.jsx changes (Item 12). */
const REACT_ONLY_PATTERNS = new Set([
  // Wave 2 + 4b core
  "hook-in-condition",
  "useEffect-async",
  "useEffect-no-cleanup",
  "useEffect-object-dep",
  "missing-display-name",
  "index-as-key",
  "inline-handler",
  "conditional-render-hook",
  "dangerously-set-html",
  "direct-dom-access",
  "unstable-default-value",
  "jsx-falsy-and",
  "nested-component-def",
  "usecallback-no-deps",
  // Tier 4 — React 19 + RSC + oxlint
  "hook-usestate-destructure",
  "prefer-function-component",
  "react19-use-without-suspense",
  "react19-server-action-not-async",
  "react19-form-action-non-function",
  "react19-useoptimistic-no-transition",
  "rsc-non-serializable-prop",
  "rsc-date-prop",
  // useEffect pain points + deps validation
  "useEffect-missing-cleanup",
  "useEffect-setstate-loop",
  "useEffect-missing-deps-identifier",
  // React Compiler bailout patterns
  "compiler-side-effect-in-render",
  "compiler-ref-read-in-render",
  "compiler-prop-mutation",
  "compiler-state-mutation",
  "compiler-try-catch-bailout",
  "compiler-redundant-memo",
  "compiler-redundant-usecallback",
  // TanStack Query
  "tanstack-missing-invalidation",
]);

/** Pattern names that only apply to Astro files — filtered out when no .astro changes. */
const ASTRO_ONLY_PATTERNS = new Set([
  "astro-client-on-astro",
  "astro-glob-usage",
  "astro-set-html-xss",
  "astro-img-element",
  "astro-missing-getStaticPaths",
  "astro-legacy-content-collections",
  "astro-no-image-dimensions",
  "astro-inline-script-no-is-inline",
  "astro-env-secret-in-client",
  "astro-hardcoded-site-url",
  "astro-missing-lang-attr",
  "astro-form-without-action",
  "astro-view-transitions-deprecated",
]);

/**
 * Bug-patterns check: run all BUILTIN_PATTERNS via searchPatterns, merge and
 * deduplicate findings across patterns.
 */
export async function checkBugPatterns(
  index: CodeIndex,
  changedFiles: string[],
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const patterns = reviewablePatternNames(changedFiles);
    const searchOutputs = await runPatternSearches(
      index.repo,
      patterns,
      changedFilePattern(changedFiles),
    );
    const findings = toPatternFindings(searchOutputs);

    return {
      check: "bug-patterns",
      status: findings.length > 0 ? "warn" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} bug pattern(s) found`
        : "No bug patterns detected",
    };
  } catch (err: unknown) {
    return {
      check: "bug-patterns",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function changedFilePattern(changedFiles: string[]): string {
  return changedFiles.length === 1
    ? changedFiles[0]!
    : `{${changedFiles.join(",")}}`;
}

function reviewablePatternNames(changedFiles: string[]): string[] {
  const hasReactChanges = changedFiles.some((f) => /\.(tsx|jsx)$/.test(f));
  const hasAstroChanges = changedFiles.some((f) => f.endsWith(".astro"));

  return listPatterns()
    .map((p) => p.name)
    .filter((p) => shouldRunPattern(p, hasReactChanges, hasAstroChanges));
}

function shouldRunPattern(
  pattern: string,
  hasReactChanges: boolean,
  hasAstroChanges: boolean,
): boolean {
  if (REACT_ONLY_PATTERNS.has(pattern) && !hasReactChanges) return false;
  if (ASTRO_ONLY_PATTERNS.has(pattern) && !hasAstroChanges) return false;
  return true;
}

async function runPatternSearches(
  repo: string,
  patterns: string[],
  filePattern: string,
): Promise<PatternSearchOutput[]> {
  return Promise.all(
    patterns.map((p) =>
      searchPatterns(repo, p, { file_pattern: filePattern }),
    ),
  );
}

function toPatternFindings(searchOutputs: PatternSearchOutput[]): ReviewFinding[] {
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];

  for (const output of searchOutputs) {
    for (const match of output.matches) {
      const key = `${match.file}:${match.start_line}:${match.matched_pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const finding: ReviewFinding = {
        check: "bug-patterns",
        severity: "warn",
        message: `Pattern match: ${match.matched_pattern} — "${match.context}"`,
        file: match.file,
        line: match.start_line,
      };
      if (match.name !== undefined) finding.symbol = match.name;
      findings.push(finding);
    }
  }

  return findings;
}
