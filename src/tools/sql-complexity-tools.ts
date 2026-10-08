/** SQL schema complexity capability. */

import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
import { fieldsByParent } from "./sql-shared-tools.js";

export interface TableComplexity {
  name: string;
  file: string;
  line: number;
  column_count: number;
  fk_count: number;
  index_count: number;
  score: number;  // weighted composite
}

export interface SchemaComplexityResult {
  tables: TableComplexity[];
}

/**
 * Per-table complexity score: column count + FK count + index count.
 * Identifies "god tables" that need refactoring. Sorted by score desc.
 */
export async function analyzeSchemaComplexity(
  repo: string,
  options?: { file_pattern?: string; top_n?: number },
): Promise<SchemaComplexityResult> {
  // The summary only answers "is this repo indexed"; the symbols this tool reads — tables, indexes,
  // fields — are three kind-keyed reads instead of a materialised index.
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const topN = options?.top_n ?? 50;

  const tables = (
    await findRepoSymbols(repo, { kind: "table", withSource: false }, { skipFreshness: true })
  ).filter((s) => !filePattern || s.file.includes(filePattern));

  // Pre-compute: index count per table name
  const indexCounts = new Map<string, number>();
  const indexSymbols = await findRepoSymbols(
    repo,
    { kind: "index", withSource: true },
    { skipFreshness: true },
  );
  for (const sym of indexSymbols) {
    // Index source typically contains "ON table_name(...)"
    const onMatch = /\bON\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i.exec(sym.source ?? "");
    if (onMatch) {
      const tableName = (onMatch[1] ?? onMatch[2] ?? onMatch[3] ?? onMatch[4] ?? "").toLowerCase();
      indexCounts.set(tableName, (indexCounts.get(tableName) ?? 0) + 1);
    }
  }

  const results: TableComplexity[] = [];
  const fields = await fieldsByParent(repo, false);

  for (const table of tables) {
    const columns = fields.get(table.id) ?? [];
    const column_count = columns.length;

    // Count FK references in columns
    let fk_count = 0;
    for (const col of columns) {
      if (/REFERENCES/i.test(col.signature ?? "")) fk_count++;
    }

    const index_count = indexCounts.get(table.name.toLowerCase()) ?? 0;

    // Weighted score: columns dominate, FKs and indexes add coupling signal
    const score = column_count * 1.0 + fk_count * 3.0 + index_count * 1.5;

    results.push({
      name: table.name,
      file: table.file,
      line: table.start_line,
      column_count,
      fk_count,
      index_count,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return { tables: results.slice(0, topN) };
}

// ── scan_dml_safety ───────────────────────────────────────
