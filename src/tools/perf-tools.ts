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
  "n-plus-one": {
    regex: /for\s*\([\s\S]*?\)\s*\{[\s\S]*?\b(findMany|findFirst|findUnique|find|findOne|findById|query|fetch|get)\s*\(/,
    description: "DB/fetch call inside loop — N+1 query pattern",
    severity: "high",
    fix_hint: "Batch queries outside the loop using IN clause or Promise.all with pre-fetched IDs",
  },
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
  "expensive-recompute": {
    regex: /(?:for|while)\s*\([\s\S]*?\)\s*\{[\s\S]*?(\w+)\s*\([\s\S]*?\)[\s\S]*?\1\s*\(/,
    description: "Same function called multiple times inside loop body",
    severity: "low",
    fix_hint: "Hoist the call before the loop or memoize the result",
  },
};

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export function listPerfPatterns(): Record<string, { description: string; severity: string }> {
  const out: Record<string, { description: string; severity: string }> = {};
  for (const [name, p] of Object.entries(PERF_PATTERNS)) {
    out[name] = { description: p.description, severity: p.severity };
  }
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
  const enabledPatterns = options?.patterns
    ? Object.entries(PERF_PATTERNS).filter(([name]) => options.patterns!.includes(name))
    : Object.entries(PERF_PATTERNS);

  const findings: PerfFinding[] = [];
  let scanned = 0;

  for (const sym of index.symbols) {
    if (findings.length >= maxResults) break;
    if (!sym.source) continue;
    if (!includeTests && isTestFile(sym.file)) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    scanned++;

    for (const [patternName, pattern] of enabledPatterns) {
      if (findings.length >= maxResults) break;

      // Apply file_scope filter
      if (pattern.file_scope && !pattern.file_scope.test(sym.file)) continue;

      const match = pattern.regex.exec(sym.source);
      if (match) {
        const matchStart = match.index;
        const linesBefore = sym.source.slice(0, matchStart).split("\n").length;
        const matchedLine = match[0].split("\n")[0]!.trim();

        findings.push({
          pattern: patternName,
          severity: pattern.severity,
          file: sym.file,
          line: sym.start_line + linesBefore - 1,
          name: sym.name,
          kind: sym.kind,
          context: matchedLine.length > 120 ? matchedLine.slice(0, 117) + "..." : matchedLine,
          fix_hint: pattern.fix_hint,
        });
      }
    }
  }

  // Sort: high first, then medium, then low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    findings,
    patterns_checked: enabledPatterns.length,
    symbols_scanned: scanned,
    summary: {
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    },
  };
}
