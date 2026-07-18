/** Deterministic formatting of raw PostgreSQL catalog rows. */
import type { PgColumn, PgRelationship, PgTableInfo } from "./pg-introspection.js";
/** Map raw column/pk/index rows into {@link PgTableInfo}[], deterministically ordered. */
export function buildTables(
  columnRows: Record<string, unknown>[],
  pkRows: Record<string, unknown>[],
  indexRows: Record<string, unknown>[],
): PgTableInfo[] {
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    const t = requiredString(r, "table_name");
    const c = requiredString(r, "column_name");
    const list = pkByTable.get(t) ?? [];
    list.push(c);
    pkByTable.set(t, list);
  }

  const idxByTable = new Map<string, string[]>();
  for (const r of indexRows) {
    const t = requiredString(r, "table_name");
    const i = requiredString(r, "index_name");
    const list = idxByTable.get(t) ?? [];
    list.push(i);
    idxByTable.set(t, list);
  }

  const tableOrder: string[] = [];
  const colsByTable = new Map<string, PgColumn[]>();
  for (const r of columnRows) {
    const t = requiredString(r, "table_name");
    if (!colsByTable.has(t)) {
      colsByTable.set(t, []);
      tableOrder.push(t);
    }
    const columns = colsByTable.get(t);
    if (!columns) continue;
    columns.push({
      name: requiredString(r, "column_name"),
      type: requiredString(r, "data_type"),
      nullable: parseNullable(r),
    });
  }

  return tableOrder.map((name) => ({
    name,
    columns: colsByTable.get(name) ?? [],
    primary_key: pkByTable.get(name) ?? [],
    indexes: idxByTable.get(name) ?? [],
  }));
}

function parseNullable(row: Record<string, unknown>): boolean {
  const value = requiredString(row, "is_nullable").toUpperCase();
  if (value !== "YES" && value !== "NO") {
    throw new Error("Invalid PostgreSQL catalog row: is_nullable must be YES or NO");
  }
  return value === "YES";
}

/** Map raw FK rows into {@link PgRelationship}[]. */
export function buildRelationships(fkRows: Record<string, unknown>[]): PgRelationship[] {
  return fkRows.map((r) => ({
    from_table: requiredString(r, "from_table"),
    from_column: requiredString(r, "from_column"),
    to_table: requiredString(r, "to_table"),
    to_column: requiredString(r, "to_column"),
  }));
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Invalid PostgreSQL catalog row: ${field} must be a non-empty string`);
  }
  return value;
}
