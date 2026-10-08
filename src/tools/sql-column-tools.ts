/** SQL column search capability. */

import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
import { normalizeSqlType } from "./sql-shared-tools.js";

export interface SearchColumnsOptions {
  /** Substring to match against column name (case-insensitive). Empty string = no name filter. */
  query: string;
  /** Optional: filter by normalized column type (int, string, float, bool, datetime, json, uuid, bytes) */
  type?: string;
  /** Optional: substring to match against table name */
  table?: string;
  /** Optional: file_pattern to scope */
  file_pattern?: string;
  /** Maximum columns to return (default: 100) */
  max_results?: number;
}

export interface ColumnSearchHit {
  name: string;
  type: string;              // Raw SQL type signature
  normalized_type: string;   // Normalized (int, string, etc.)
  table: string;
  file: string;
  line: number;
}

export interface SearchColumnsResult {
  columns: ColumnSearchHit[];
  total: number;
  truncated: boolean;
}

export async function searchColumns(
  repo: string,
  options: SearchColumnsOptions,
): Promise<SearchColumnsResult> {
  // Two kind-keyed reads (tables, then fields) instead of a materialised index; neither needs
  // `source`, and the field read keeps the index's row order, which is the hit order.
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const queryLower = (options.query ?? "").toLowerCase();
  const typeFilter = options.type?.toLowerCase();
  const tableFilter = options.table?.toLowerCase();
  const filePattern = options.file_pattern;
  const maxResults = options.max_results ?? 100;

  // Build table-id → table-name lookup (only SQL tables, not Prisma models)
  const tableIdToName = new Map<string, { name: string; file: string }>();
  for (const sym of await findRepoSymbols(repo, { kind: "table", withSource: false }, { skipFreshness: true })) {
    if (filePattern && !sym.file.includes(filePattern)) continue;
    tableIdToName.set(sym.id, { name: sym.name, file: sym.file });
  }

  // Collect field symbols whose parent is a SQL table
  const allHits: ColumnSearchHit[] = [];
  // Skipped outright when no table matched: no field can have a parent in an empty map.
  const fields = tableIdToName.size === 0
    ? []
    : await findRepoSymbols(repo, { kind: "field", withSource: false }, { skipFreshness: true });
  for (const sym of fields) {
    if (!sym.parent) continue;
    const parent = tableIdToName.get(sym.parent);
    if (!parent) continue;

    const name = sym.name;
    const type = sym.signature ?? "unknown";
    const normalized = normalizeSqlType(type);

    // Apply filters
    if (queryLower && !name.toLowerCase().includes(queryLower)) continue;
    if (typeFilter && normalized !== typeFilter) continue;
    if (tableFilter && !parent.name.toLowerCase().includes(tableFilter)) continue;

    allHits.push({
      name,
      type,
      normalized_type: normalized,
      table: parent.name,
      file: parent.file,
      line: sym.start_line,
    });
  }

  const total = allHits.length;
  const truncated = total > maxResults;
  const columns = truncated ? allHits.slice(0, maxResults) : allHits;

  return { columns, total, truncated };
}

// ── analyze_schema_complexity ──────────────────────────────
