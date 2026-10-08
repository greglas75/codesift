/** SQL schema linting capability. */

import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
import { fieldsByParent } from "./sql-shared-tools.js";

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
  // Kind-keyed reads for tables, fields and indexes instead of a materialised index.
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const findings: LintFinding[] = [];
  const warnings: string[] = [];

  // `source` is needed: the no-primary-key rule reads the table body.
  const tables = (
    await findRepoSymbols(repo, { kind: "table", withSource: true }, { skipFreshness: true })
  ).filter((s) => !filePattern || s.file.includes(filePattern));

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
  const fieldsByTable = await fieldsByParent(repo, false);
  for (const table of tables) {
    const fields = fieldsByTable.get(table.id) ?? [];
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
  const indexes = (
    await findRepoSymbols(repo, { kind: "index", withSource: false }, { skipFreshness: true })
  ).filter((s) => !filePattern || s.file.includes(filePattern));
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
