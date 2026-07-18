import type { MigrationTable, PgColumnMismatch } from "./pg-drift-types.js";

export function compareTableColumns(
  table: string,
  migrations: MigrationTable,
  live: Map<string, string>,
): PgColumnMismatch[] {
  const mismatches: PgColumnMismatch[] = [];
  for (const [column, migrationsType] of migrations.columns) {
    const liveType = live.get(column);
    if (liveType === undefined) {
      mismatches.push({ table, column, kind: "missing_live", migrations_type: migrationsType });
    } else if (normalizeSimpleType(liveType) !== normalizeSimpleType(migrationsType)) {
      mismatches.push({
        table, column, kind: "type_mismatch",
        live_type: liveType, migrations_type: migrationsType,
      });
    }
  }
  for (const [column, liveType] of live) {
    if (!migrations.columns.has(column)) {
      mismatches.push({ table, column, kind: "missing_migrations", live_type: liveType });
    }
  }
  return mismatches;
}

function normalizeSimpleType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*not\s+null/gi, "")
    .replace(/\s*default\s+\S+/gi, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
}
