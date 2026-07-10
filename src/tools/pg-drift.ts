/** Pure live-schema versus migration-schema comparison. */
import type { PgIntrospectResult } from "./pg-introspection.js";
import { compareTableColumns } from "./pg-drift-compare.js";
import { buildLiveTables, buildMigrationTables } from "./pg-drift-schema.js";
import type { PgColumnMismatch, PgDriftResult, SqlSymbol } from "./pg-drift-types.js";

export function pgDriftCheck(
  live: PgIntrospectResult,
  symbols: SqlSymbol[],
): PgDriftResult {
  const migrationTables = buildMigrationTables(symbols);
  if (migrationTables.size === 0) {
    return {
      missing_tables_live_only: [],
      missing_tables_migrations_only: [],
      column_mismatches: [],
      note: "no migration-derived schema: no SQL table symbols found in index",
    };
  }
  const liveTables = buildLiveTables(live);
  const missingLiveOnly = [...liveTables.keys()].filter((name) => !migrationTables.has(name));
  const missingMigrationsOnly: string[] = [];
  const mismatches: PgColumnMismatch[] = [];
  for (const [name, migrationTable] of migrationTables) {
    const liveColumns = liveTables.get(name);
    if (!liveColumns) missingMigrationsOnly.push(name);
    else mismatches.push(...compareTableColumns(name, migrationTable, liveColumns));
  }
  return {
    missing_tables_live_only: missingLiveOnly,
    missing_tables_migrations_only: missingMigrationsOnly,
    column_mismatches: mismatches,
  };
}
