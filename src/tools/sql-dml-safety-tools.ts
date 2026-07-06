/** SQL DML safety scanning capability. */

import { getCodeIndex } from "./index-tools.js";
import { searchText } from "./search-tools.js";

export interface DmlFinding {
  rule: string;
  severity: "high" | "medium" | "info";
  file: string;
  line: number;
  context?: string;
  detail: string;
}

export interface ScanDmlSafetyResult {
  findings: DmlFinding[];
  summary: {
    total: number;
    by_rule: Record<string, number>;
    files_scanned: number;
  };
}

/**
 * Scan codebase for unsafe DML patterns in SQL strings.
 * Uses ripgrep to find DML statements, then classifies safety.
 */
export async function scanDmlSafety(
  repo: string,
  options?: { file_pattern?: string; max_results?: number },
): Promise<ScanDmlSafetyResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 200;
  const findings: DmlFinding[] = [];
  const filesScanned = new Set<string>();

  // Pattern 1: DELETE without WHERE
  const delMatches = await searchText(repo, "DELETE FROM", {
    regex: false,
    max_results: maxResults,
    file_pattern: filePattern,
    context_lines: 0,
  });

  for (const m of delMatches) {
    filesScanned.add(m.file);
    const text = m.content ?? "";
    // Check if WHERE exists after DELETE FROM on the same line or nearby
    if (!/\bWHERE\b/i.test(text)) {
      findings.push({
        rule: "delete-without-where",
        severity: "high",
        file: m.file,
        line: m.line,
        context: text.trim().slice(0, 120),
        detail: `DELETE FROM without WHERE clause — may delete all rows.`,
      });
    }
  }

  // Pattern 2: UPDATE without WHERE
  const updMatches = await searchText(repo, "UPDATE", {
    regex: false,
    max_results: maxResults,
    file_pattern: filePattern,
    context_lines: 0,
  });

  for (const m of updMatches) {
    filesScanned.add(m.file);
    const text = m.content ?? "";
    // Must contain SET (otherwise it's not a DML UPDATE)
    if (!/\bSET\b/i.test(text)) continue;
    if (!/\bWHERE\b/i.test(text)) {
      findings.push({
        rule: "update-without-where",
        severity: "high",
        file: m.file,
        line: m.line,
        context: text.trim().slice(0, 120),
        detail: `UPDATE...SET without WHERE clause — may update all rows.`,
      });
    }
  }

  // Pattern 3: SELECT * (unbounded read)
  const selMatches = await searchText(repo, "SELECT *", {
    regex: false,
    max_results: maxResults,
    file_pattern: filePattern,
    context_lines: 0,
  });

  for (const m of selMatches) {
    filesScanned.add(m.file);
    const text = m.content ?? "";
    // Only flag if FROM is present (actual query, not comment/string fragment)
    if (!/\bFROM\b/i.test(text)) continue;
    findings.push({
      rule: "select-star",
      severity: "info",
      file: m.file,
      line: m.line,
      context: text.trim().slice(0, 120),
      detail: `SELECT * — fetches all columns. Consider listing specific fields.`,
    });
  }

  // Deduplicate: same file:line + same rule
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const by_rule: Record<string, number> = {};
  for (const f of deduped) {
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
  }

  return {
    findings: deduped,
    summary: { total: deduped.length, by_rule, files_scanned: filesScanned.size },
  };
}

// ── lint_schema ───────────────────────────────────────────
