/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getCodeIndex } from "./index-tools.js";
import { BUILTIN_PATTERNS, searchPatterns } from "./pattern-tools.js";

// 7f. php_security_scan — Compound security tool
// ---------------------------------------------------------------------------

export interface PhpSecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  pattern: string;
  file: string;
  line: number;
  context: string;
  description: string;
}

export interface PhpSecurityScanResult {
  findings: PhpSecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  checks_run: string[];
}

const PHP_SECURITY_CHECKS = [
  // Original 8 checks
  { pattern: "sql-injection-php", severity: "critical" as const },
  { pattern: "xss-php", severity: "critical" as const },
  { pattern: "eval-php", severity: "critical" as const },
  { pattern: "exec-php", severity: "critical" as const },
  { pattern: "unserialize-php", severity: "high" as const },
  { pattern: "file-include-var", severity: "high" as const },
  { pattern: "unescaped-yii-view", severity: "high" as const },
  { pattern: "raw-query-yii", severity: "high" as const },
  // Sprint 2 additions: Yii2- + PHP-specific patterns informed by tgm-panel
  // db-audit + perf-audit findings, plus the gap analysis section 4 catalog.
  { pattern: "yii-csrf-disabled", severity: "high" as const },
  { pattern: "yii-debug-mode-prod", severity: "critical" as const },
  { pattern: "yii-cookie-no-validation", severity: "high" as const },
  { pattern: "yii-mass-assignment-unsafe", severity: "medium" as const },
  { pattern: "yii-raw-sql-where", severity: "high" as const },
  { pattern: "php-md5-password", severity: "high" as const },
  { pattern: "php-rand-token", severity: "high" as const },
  { pattern: "php-loose-comparison-secret", severity: "medium" as const },
  { pattern: "yii-rbac-cached-permission", severity: "low" as const },
  { pattern: "yii-no-row-level-locking", severity: "high" as const },
  { pattern: "yii-config-hardcoded-secret", severity: "critical" as const },
  { pattern: "yii-unbounded-all", severity: "medium" as const },
];

/**
 * Patterns that hit code at module level (top-level `return [...]`,
 * top-level `define(...)` calls in entry-point files) and therefore are
 * NOT visible via `searchPatterns` — that helper iterates `index.symbols`,
 * so files without any class/function/method produce zero hits. We scan
 * these patterns by reading file content directly.
 */
const FILE_LEVEL_PATTERNS = new Set<string>([
  "yii-debug-mode-prod",
  "yii-cookie-no-validation",
  "yii-config-hardcoded-secret",
]);

export async function phpSecurityScan(
  repo: string,
  options?: { file_pattern?: string; checks?: string[] },
): Promise<PhpSecurityScanResult> {
  const selectedChecks = options?.checks
    ? PHP_SECURITY_CHECKS.filter((c) => options.checks!.includes(c.pattern))
    : PHP_SECURITY_CHECKS;

  const findings: PhpSecurityFinding[] = [];
  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };

  // Symbol-level scans run via the existing searchPatterns helper. Skip the
  // file-level patterns here — they're handled below by a direct file read.
  const symbolLevelChecks = selectedChecks.filter(
    (c) => !FILE_LEVEL_PATTERNS.has(c.pattern),
  );
  const fileLevelChecks = selectedChecks.filter((c) =>
    FILE_LEVEL_PATTERNS.has(c.pattern),
  );

  // Run pattern checks in parallel
  const results = await Promise.all(
    symbolLevelChecks.map((check) =>
      searchPatterns(repo, check.pattern, {
        file_pattern: options?.file_pattern ?? ".php",
        include_tests: false,
      }).then((r) => ({ check, result: r })).catch(() => null),
    ),
  );

  for (const res of results) {
    if (!res) continue;
    for (const m of res.result.matches) {
      findings.push({
        severity: res.check.severity,
        pattern: res.check.pattern,
        file: m.file,
        line: m.start_line,
        context: m.context,
        description: "", // description populated by searchPatterns but not in PatternMatch type
      });
      summary[res.check.severity]++;
      summary.total++;
    }
  }

  // File-level scan: read every PHP file once, run each file-level pattern
  // against it. This catches top-level `define('YII_DEBUG', true)` and
  // hardcoded literals in `return [...]` config arrays which never live
  // inside a class or function.
  if (fileLevelChecks.length > 0) {
    const fileFindings = await runFileLevelChecks(repo, fileLevelChecks, options?.file_pattern);
    for (const f of fileFindings) {
      findings.push(f);
      summary[f.severity]++;
      summary.total++;
    }
  }

  return {
    findings,
    summary,
    checks_run: selectedChecks.map((c) => c.pattern),
  };
}

async function runFileLevelChecks(
  repo: string,
  checks: typeof PHP_SECURITY_CHECKS,
  filePattern: string | undefined,
): Promise<PhpSecurityFinding[]> {
  const index = await getCodeIndex(repo);
  if (!index) return [];
  const out: PhpSecurityFinding[] = [];

  const phpFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".php")) return false;
    if (filePattern && !f.path.includes(filePattern)) return false;
    return true;
  });

  // Pull each pattern definition up-front. We want one regex object per
  // check, not per file, to avoid re-compilation churn.
  const compiled = checks
    .map((check) => {
      const def = BUILTIN_PATTERNS[check.pattern];
      if (!def) return null;
      // Re-create the regex with /g so we can iterate matches across the
      // whole file content. Built-in patterns are stored without /g because
      // searchPatterns calls .exec() once per symbol.
      const flags = (def.regex.flags.includes("g") ? "" : "g") + def.regex.flags;
      return {
        check,
        regex: new RegExp(def.regex.source, flags),
        fileIncludePattern: def.fileIncludePattern,
        fileExcludePattern: def.fileExcludePattern,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  await Promise.all(
    phpFiles.map(async (file) => {
      let content: string;
      try {
        content = await readFile(join(index.root, file.path), "utf-8");
      } catch {
        return;
      }
      for (const c of compiled) {
        if (c.fileIncludePattern && !c.fileIncludePattern.test(file.path)) continue;
        if (c.fileExcludePattern && c.fileExcludePattern.test(file.path)) continue;

        c.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = c.regex.exec(content)) !== null) {
          const line = countLines(content, m.index);
          out.push({
            severity: c.check.severity,
            pattern: c.check.pattern,
            file: file.path,
            line,
            context: extractLine(content, m.index),
            description: "",
          });
        }
      }
    }),
  );

  return out;
}

function countLines(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractLine(source: string, idx: number): string {
  const start = source.lastIndexOf("\n", idx) + 1;
  const end = source.indexOf("\n", idx);
  const out = source.slice(start, end === -1 ? source.length : end);
  return out.trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
