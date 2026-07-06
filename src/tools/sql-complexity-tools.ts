/** SQL schema complexity capability. */

import { getCodeIndex } from "./index-tools.js";

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
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const topN = options?.top_n ?? 50;

  const tables = index.symbols.filter((s) => {
    if (s.kind !== "table") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  // Pre-compute: index count per table name
  const indexCounts = new Map<string, number>();
  for (const sym of index.symbols) {
    if (sym.kind !== "index") continue;
    // Index source typically contains "ON table_name(...)"
    const onMatch = /\bON\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/i.exec(sym.source ?? "");
    if (onMatch) {
      const tableName = (onMatch[1] ?? onMatch[2] ?? onMatch[3] ?? onMatch[4] ?? "").toLowerCase();
      indexCounts.set(tableName, (indexCounts.get(tableName) ?? 0) + 1);
    }
  }

  const results: TableComplexity[] = [];

  for (const table of tables) {
    const columns = index.symbols.filter(
      (s) => s.kind === "field" && s.parent === table.id,
    );
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
