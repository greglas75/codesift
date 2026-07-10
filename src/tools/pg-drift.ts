/** Pure live-schema versus migration-schema comparison. */
import type { PgIntrospectResult } from "./pg-introspection.js";
export interface PgColumnMismatch {
  table: string;
  column: string;
  kind: "missing_live" | "missing_migrations" | "type_mismatch";
  live_type?: string;
  migrations_type?: string;
}

/** Result of {@link pgDriftCheck}. */
export interface PgDriftResult {
  /** Tables present in the live DB but absent from any migration-derived symbol. */
  missing_tables_live_only: string[];
  /** Tables present in migrations but absent from the live DB. */
  missing_tables_migrations_only: string[];
  /** Column-level mismatches for tables that exist on both sides. */
  column_mismatches: PgColumnMismatch[];
  /** Human-readable note — set when no SQL symbols found in the index. */
  note?: string;
}

/**
 * A minimal view of the SQL symbol structure used by pgDriftCheck.
 * Matches the shape emitted by getCodeIndex for `kind === "table"` symbols
 * and their child `kind === "field"` symbols.
 */
export interface SqlSymbol {
  id: string;
  kind: string;
  name: string;
  parent?: string;
  signature?: string;
}

/**
 * Compare a live {@link PgIntrospectResult} against the migration-derived
 * schema stored in the code index for `repo`.
 *
 * Instead of calling `getCodeIndex` directly (which would import index-tools
 * and drag in the whole storage layer), callers inject the raw symbol array.
 * This keeps pgDriftCheck pure and easily testable.
 *
 * The SQL schema is reconstructed from `kind === "table"` symbols and their
 * `kind === "field"` children — the same shape that `analyzeSchemaDrift`
 * consumes internally. We do NOT call `analyzeSchemaDrift` (different concern:
 * that function compares ORM models vs SQL files, not live DB vs migrations).
 *
 * @param live   Result from {@link introspectPgSchema}.
 * @param symbols  `index.symbols` from `getCodeIndex(repo)`.
 * @returns {@link PgDriftResult} — never throws.
 */
export function pgDriftCheck(
  live: PgIntrospectResult,
  symbols: SqlSymbol[],
): PgDriftResult {
  // Build migration-schema view from SQL symbols ─────────────────────────────
  // Tables: kind === "table"; columns: kind === "field" with parent === table.id
  const migrationTables = new Map<
    string, // lowercase table name
    { id: string; columns: Map<string, string> } // lowercase col name → type
  >();

  for (const sym of symbols) {
    if (sym.kind !== "table") continue;
    migrationTables.set(sym.name.toLowerCase(), {
      id: sym.id,
      columns: new Map(),
    });
  }

  if (migrationTables.size === 0) {
    return {
      missing_tables_live_only: [],
      missing_tables_migrations_only: [],
      column_mismatches: [],
      note: "no migration-derived schema: no SQL table symbols found in index",
    };
  }

  for (const sym of symbols) {
    if (sym.kind !== "field" || !sym.parent) continue;
    // Find the parent table entry by matching the parent id against the id we stored
    for (const [, tbl] of migrationTables) {
      if (tbl.id === sym.parent) {
        tbl.columns.set(sym.name.toLowerCase(), sym.signature ?? "unknown");
        break;
      }
    }
  }

  // Build live-schema lookup ─────────────────────────────────────────────────
  const liveTables = new Map<string, Map<string, string>>();
  for (const tbl of live.tables) {
    const cols = new Map<string, string>();
    for (const col of tbl.columns) {
      cols.set(col.name.toLowerCase(), col.type);
    }
    liveTables.set(tbl.name.toLowerCase(), cols);
  }

  // Compare ──────────────────────────────────────────────────────────────────
  const missing_tables_live_only: string[] = [];
  const missing_tables_migrations_only: string[] = [];
  const column_mismatches: PgColumnMismatch[] = [];

  // Tables in live but not in migrations
  for (const [tableName] of liveTables) {
    if (!migrationTables.has(tableName)) {
      missing_tables_live_only.push(tableName);
    }
  }

  // Tables in migrations but not in live + column-level diff for shared tables
  for (const [tableName, migTbl] of migrationTables) {
    const liveCols = liveTables.get(tableName);
    if (!liveCols) {
      missing_tables_migrations_only.push(tableName);
      continue;
    }

    // Columns in migrations but missing in live
    for (const [colName, migType] of migTbl.columns) {
      if (!liveCols.has(colName)) {
        column_mismatches.push({
          table: tableName,
          column: colName,
          kind: "missing_live",
          migrations_type: migType,
        });
      } else {
        // Both sides have the column — check type compatibility
        const liveType = liveCols.get(colName)!;
        if (normalizeSimpleType(liveType) !== normalizeSimpleType(migType)) {
          column_mismatches.push({
            table: tableName,
            column: colName,
            kind: "type_mismatch",
            live_type: liveType,
            migrations_type: migType,
          });
        }
      }
    }

    // Columns in live but missing in migrations
    for (const [colName, liveType] of liveCols) {
      if (!migTbl.columns.has(colName)) {
        column_mismatches.push({
          table: tableName,
          column: colName,
          kind: "missing_migrations",
          live_type: liveType,
        });
      }
    }
  }

  return {
    missing_tables_live_only,
    missing_tables_migrations_only,
    column_mismatches,
  };
}

/**
 * Minimal type normalisation: strips modifiers like `NOT NULL`, `DEFAULT …`,
 * parenthesised sizes, and lowercases. Enough for gross-mismatch detection
 * (e.g. `integer` vs `text`) without false-positives from vendor decoration.
 */
function normalizeSimpleType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*not\s+null/gi, "")
    .replace(/\s*default\s+\S+/gi, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
}
