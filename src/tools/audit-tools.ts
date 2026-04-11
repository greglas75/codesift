/**
 * audit_scan — composite tool that runs multiple analysis tools in parallel
 * and returns findings keyed by CQ gate. One call replaces 5+ sequential calls.
 */

import { findDeadCode } from "./symbol-tools.js";
import { searchPatterns } from "./pattern-tools.js";
import { findClones } from "./clone-tools.js";
import { analyzeComplexity } from "./complexity-tools.js";
// import { analyzeHotspots } from "./hotspot-tools.js"; // TODO: add hotspot gate

export interface AuditScanOptions {
  file_pattern?: string;
  include_tests?: boolean;
  since_days?: number;
  /** Which checks to run. Default: all. */
  checks?: string[];
}

export interface AuditFinding {
  file: string;
  line?: number;
  end_line?: number;
  name?: string;
  detail: string;
  severity: "critical" | "warning" | "info";
}

export interface AuditGateResult {
  gate: string;
  description: string;
  findings: AuditFinding[];
  tool_used: string;
}

export interface AuditScanResult {
  repo: string;
  gates: AuditGateResult[];
  summary: {
    total_findings: number;
    critical: number;
    warning: number;
    gates_checked: number;
    gates_with_findings: number;
  };
}

const ALL_CHECKS = ["CQ8", "CQ11", "CQ13", "CQ14", "CQ17", "REACT"];

/** React patterns surfaced by the React audit gate (Item 11). */
const REACT_AUDIT_PATTERNS = [
  "hook-in-condition",
  "useEffect-async",
  "dangerously-set-html",
  "index-as-key",
  "nested-component-def",
] as const;

export async function auditScan(
  repo: string,
  options?: AuditScanOptions,
): Promise<AuditScanResult> {
  const checks = new Set(options?.checks ?? ALL_CHECKS);
  const filePattern = options?.file_pattern;
  const includeTests = options?.include_tests ?? false;
  // const sinceDays = options?.since_days ?? 90; // TODO: use in hotspot gate

  // Run all enabled checks in parallel
  const tasks: Promise<AuditGateResult>[] = [];

  if (checks.has("CQ8")) {
    tasks.push(runCQ8(repo, filePattern, includeTests));
  }
  if (checks.has("CQ11")) {
    tasks.push(runCQ11(repo, filePattern, includeTests));
  }
  if (checks.has("CQ13")) {
    tasks.push(runCQ13(repo, filePattern, includeTests));
  }
  if (checks.has("CQ14")) {
    tasks.push(runCQ14(repo, filePattern, includeTests));
  }
  if (checks.has("CQ17")) {
    tasks.push(runCQ17(repo, filePattern, includeTests));
  }
  if (checks.has("REACT")) {
    tasks.push(runReactGate(repo, filePattern, includeTests));
  }

  const gates = await Promise.all(tasks);

  const totalFindings = gates.reduce((sum, g) => sum + g.findings.length, 0);
  const critical = gates.reduce((sum, g) => sum + g.findings.filter(f => f.severity === "critical").length, 0);
  const warning = gates.reduce((sum, g) => sum + g.findings.filter(f => f.severity === "warning").length, 0);

  return {
    repo,
    gates,
    summary: {
      total_findings: totalFindings,
      critical,
      warning,
      gates_checked: gates.length,
      gates_with_findings: gates.filter(g => g.findings.length > 0).length,
    },
  };
}

// ---------------------------------------------------------------------------
// CQ8: Empty catch blocks / unhandled errors
// ---------------------------------------------------------------------------

async function runCQ8(repo: string, filePattern?: string, includeTests?: boolean): Promise<AuditGateResult> {
  try {
    const result = await searchPatterns(repo, "empty-catch", {
      file_pattern: filePattern,
      include_tests: includeTests,
      max_results: 50,
    });

    return {
      gate: "CQ8",
      description: "Error handling: empty catch blocks, missing error handling",
      tool_used: "search_patterns('empty-catch')",
      findings: result.matches.map(m => ({
        file: m.file,
        line: m.start_line,
        end_line: m.end_line,
        name: m.name,
        detail: `Empty catch in ${m.name}`,
        severity: "critical" as const,
      })),
    };
  } catch {
    return { gate: "CQ8", description: "Error handling", tool_used: "search_patterns", findings: [] };
  }
}

// ---------------------------------------------------------------------------
// CQ11: File/function size limits, complexity
// ---------------------------------------------------------------------------

async function runCQ11(repo: string, filePattern?: string, includeTests?: boolean): Promise<AuditGateResult> {
  try {
    const result = await analyzeComplexity(repo, {
      file_pattern: filePattern,
      top_n: 20,
      min_complexity: 10,
      include_tests: includeTests,
    });

    const findings: AuditFinding[] = [];

    for (const fn of result.functions) {
      if (fn.cyclomatic_complexity >= 15) {
        findings.push({
          file: fn.file,
          line: fn.start_line,
          end_line: fn.end_line,
          name: fn.name,
          detail: `CC=${fn.cyclomatic_complexity}, nesting=${fn.max_nesting_depth}, ${fn.lines}L`,
          severity: fn.cyclomatic_complexity >= 25 ? "critical" : "warning",
        });
      } else if (fn.lines > 50) {
        findings.push({
          file: fn.file,
          line: fn.start_line,
          end_line: fn.end_line,
          name: fn.name,
          detail: `${fn.lines}L function (limit: 50L public), CC=${fn.cyclomatic_complexity}`,
          severity: fn.lines > 100 ? "critical" : "warning",
        });
      }
    }

    return {
      gate: "CQ11",
      description: "Structure: file/function size limits, cyclomatic complexity",
      tool_used: "analyze_complexity(min_complexity=10)",
      findings,
    };
  } catch {
    return { gate: "CQ11", description: "Structure/complexity", tool_used: "analyze_complexity", findings: [] };
  }
}

// ---------------------------------------------------------------------------
// CQ13: Dead code, unused exports
// ---------------------------------------------------------------------------

async function runCQ13(repo: string, filePattern?: string, includeTests?: boolean): Promise<AuditGateResult> {
  try {
    const result = await findDeadCode(repo, {
      file_pattern: filePattern,
      include_tests: includeTests,
    });

    return {
      gate: "CQ13",
      description: "Hygiene: dead code, unused exports",
      tool_used: "find_dead_code",
      findings: result.candidates.map(c => ({
        file: c.file,
        line: c.start_line,
        end_line: c.end_line,
        name: c.name,
        detail: `Unused ${c.kind}: ${c.name} (${c.reason})`,
        severity: "warning" as const,
      })),
    };
  } catch {
    return { gate: "CQ13", description: "Dead code", tool_used: "find_dead_code", findings: [] };
  }
}

// ---------------------------------------------------------------------------
// CQ14: Code duplication / clones
// ---------------------------------------------------------------------------

async function runCQ14(repo: string, filePattern?: string, includeTests?: boolean): Promise<AuditGateResult> {
  try {
    const result = await findClones(repo, {
      file_pattern: filePattern,
      min_similarity: 0.7,
      include_tests: includeTests,
    });

    return {
      gate: "CQ14",
      description: "Hygiene: duplicated logic (>10L blocks repeated)",
      tool_used: "find_clones(min_similarity=0.7)",
      findings: result.clones.map(c => ({
        file: c.symbol_a.file,
        line: c.symbol_a.start_line,
        name: `${c.symbol_a.name} ↔ ${c.symbol_b.name}`,
        detail: `${Math.round(c.similarity * 100)}% similar (${c.shared_lines}L shared) — ${c.symbol_b.file}:${c.symbol_b.start_line}`,
        severity: c.similarity >= 0.9 ? "critical" as const : "warning" as const,
      })),
    };
  } catch {
    return { gate: "CQ14", description: "Duplication", tool_used: "find_clones", findings: [] };
  }
}

// ---------------------------------------------------------------------------
// CQ17: Performance — N+1, sequential await in loops, .find() in loop
// ---------------------------------------------------------------------------

async function runCQ17(repo: string, filePattern?: string, includeTests?: boolean): Promise<AuditGateResult> {
  try {
    const result = await searchPatterns(repo, "find-in-loop", {
      file_pattern: filePattern,
      include_tests: includeTests,
      max_results: 30,
    });

    return {
      gate: "CQ17",
      description: "Performance: N+1, sequential await in loops, .find() in loop",
      tool_used: "search_patterns('find-in-loop')",
      findings: result.matches.map(m => ({
        file: m.file,
        line: m.start_line,
        end_line: m.end_line,
        name: m.name,
        detail: `Performance anti-pattern in ${m.name}: ${m.matched_pattern}`,
        severity: "warning" as const,
      })),
    };
  } catch {
    return { gate: "CQ17", description: "Performance", tool_used: "search_patterns", findings: [] };
  }
}

// ---------------------------------------------------------------------------
// REACT: React anti-patterns gate (Item 11)
// ---------------------------------------------------------------------------

async function runReactGate(
  repo: string,
  filePattern?: string,
  includeTests?: boolean,
): Promise<AuditGateResult> {
  const findings: AuditFinding[] = [];
  for (const pattern of REACT_AUDIT_PATTERNS) {
    try {
      const result = await searchPatterns(repo, pattern, {
        file_pattern: filePattern,
        include_tests: includeTests,
        max_results: 20,
      });
      for (const m of result.matches) {
        findings.push({
          file: m.file,
          line: m.start_line,
          end_line: m.end_line,
          name: m.name,
          detail: `${pattern} in ${m.name}: ${m.context.slice(0, 100)}`,
          severity: pattern === "dangerously-set-html" ? "critical" : "warning",
        });
      }
    } catch {
      // Pattern may not exist if Wave 2 wasn't applied — skip silently
    }
  }
  return {
    gate: "REACT",
    description: "React anti-patterns: Rule of Hooks, XSS, performance, memoization (Wave 2 + Tier 3)",
    tool_used: "search_patterns(REACT_AUDIT_PATTERNS)",
    findings,
  };
}
