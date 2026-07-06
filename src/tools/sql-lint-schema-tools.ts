/** SQL schema linting capability. */

import { getCodeIndex } from "./index-tools.js";

export interface LintFinding {
  rule: string;
  severity: "warning" | "info";
  table: string;
  detail: string;
  file: string;
  line: number;
}

export interface LintSchemaResult {
  findings: LintFinding[];
  summary: {
    total: number;
    by_rule: Record<string, number>;
  };
  warnings: string[];
}

/**
 * Lint SQL schema for common anti-patterns.
 * Conservative ruleset with near-zero false positive rate:
 * - no-primary-key: table without PRIMARY KEY (serious design smell)
 * - wide-table: table with >20 columns (god table)
 * - duplicate-index-name: same index name defined multiple times
 */
export async function lintSchema(
  repo: string,
  options?: { file_pattern?: string },
): Promise<LintSchemaResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const findings: LintFinding[] = [];
  const warnings: string[] = [];

  const tables = index.symbols.filter((s) => {
    if (s.kind !== "table") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  if (tables.length === 0) {
    warnings.push("No SQL tables found in this repository.");
    return { findings, summary: { total: 0, by_rule: {} }, warnings };
  }

  // Rule 1: no-primary-key — table with no PK field
  for (const table of tables) {
    const source = table.source ?? "";
    const hasPK = /PRIMARY\s+KEY/i.test(source) || /\bSERIAL\b/i.test(source);
    if (!hasPK) {
      findings.push({
        rule: "no-primary-key",
        severity: "warning",
        table: table.name,
        detail: `Table "${table.name}" has no PRIMARY KEY or SERIAL column.`,
        file: table.file,
        line: table.start_line,
      });
    }
  }

  // Rule 2: wide-table — >20 columns
  for (const table of tables) {
    const fields = index.symbols.filter(
      (s) => s.kind === "field" && s.parent === table.id,
    );
    if (fields.length > 20) {
      findings.push({
        rule: "wide-table",
        severity: "warning",
        table: table.name,
        detail: `Table "${table.name}" has ${fields.length} columns (threshold: 20). Consider splitting.`,
        file: table.file,
        line: table.start_line,
      });
    }
  }

  // Rule 3: duplicate-index-name
  const indexNames = new Map<string, { file: string; line: number }>();
  const indexes = index.symbols.filter((s) => {
    if (s.kind !== "index") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });
  for (const idx of indexes) {
    const key = idx.name.toLowerCase();
    if (indexNames.has(key)) {
      const prev = indexNames.get(key)!;
      findings.push({
        rule: "duplicate-index-name",
        severity: "warning",
        table: idx.name,
        detail: `Index "${idx.name}" defined at ${idx.file}:${idx.start_line} duplicates index at ${prev.file}:${prev.line}.`,
        file: idx.file,
        line: idx.start_line,
      });
    } else {
      indexNames.set(key, { file: idx.file, line: idx.start_line });
    }
  }

  // Build summary
  const by_rule: Record<string, number> = {};
  for (const f of findings) {
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
  }

  return {
    findings,
    summary: { total: findings.length, by_rule },
    warnings,
  };
}

// ── diff_migrations ───────────────────────────────────────
