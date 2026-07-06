/** SQL orphan table detection capability. */

import type { TextMatch } from "../types.js";
import { getCodeIndex } from "./index-tools.js";
import { searchText } from "./search-tools.js";
import { escapeRegex } from "./sql-shared-tools.js";

export interface OrphanTable {
  name: string;
  file: string;
  line: number;
  column_count: number;
}

export interface FindOrphanTablesResult {
  orphans: OrphanTable[];
  total_tables: number;
  orphan_count: number;
}

/**
 * Find SQL tables with zero references outside their own CREATE TABLE definition.
 * Uses ripgrep-backed literal search per table for speed.
 */
export async function findOrphanTables(
  repo: string,
  options?: { file_pattern?: string },
): Promise<FindOrphanTablesResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;

  // Collect all SQL tables
  const tables = index.symbols.filter((s) => {
    if (s.kind !== "table") return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });

  const orphans: OrphanTable[] = [];

  for (const table of tables) {
    // Search for references to this table name via ripgrep
    let rgMatches: TextMatch[] = [];
    try {
      rgMatches = await searchText(repo, table.name, {
        regex: false,
        max_results: 20,
        context_lines: 0,
      });
    } catch {
      rgMatches = [];
    }

    // Boundary filter + exclude the definition line itself
    const IDENT_CHAR = "[a-zA-Z0-9_#$@]";
    const escaped = escapeRegex(table.name);
    const boundaryRegex = new RegExp(
      `(?<!${IDENT_CHAR})${escaped}(?!${IDENT_CHAR})`,
      "i",
    );

    const realRefs = rgMatches.filter((m) => {
      const text = m.content ?? "";
      if (!boundaryRegex.test(text)) return false;
      // Exclude the CREATE TABLE definition line
      if (m.file === table.file && m.line === table.start_line) return false;
      // Exclude lines within the CREATE TABLE body (column defs, constraints)
      if (m.file === table.file && m.line > table.start_line && m.line <= table.end_line) return false;
      return true;
    });

    if (realRefs.length === 0) {
      const columnCount = index.symbols.filter(
        (s) => s.kind === "field" && s.parent === table.id,
      ).length;

      orphans.push({
        name: table.name,
        file: table.file,
        line: table.start_line,
        column_count: columnCount,
      });
    }
  }

  return {
    orphans,
    total_tables: tables.length,
    orphan_count: orphans.length,
  };
}

// ── analyze_schema_drift ──────────────────────────────────
