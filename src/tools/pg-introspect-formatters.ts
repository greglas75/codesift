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
    const t = String(r["table_name"]);
    const c = String(r["column_name"]);
    const list = pkByTable.get(t) ?? [];
    list.push(c);
    pkByTable.set(t, list);
  }

  const idxByTable = new Map<string, string[]>();
  for (const r of indexRows) {
    const t = String(r["table_name"]);
    const i = String(r["index_name"]);
    const list = idxByTable.get(t) ?? [];
    list.push(i);
    idxByTable.set(t, list);
  }

  const tableOrder: string[] = [];
  const colsByTable = new Map<string, PgColumn[]>();
  for (const r of columnRows) {
    const t = String(r["table_name"]);
    if (!colsByTable.has(t)) {
      colsByTable.set(t, []);
      tableOrder.push(t);
    }
    colsByTable.get(t)!.push({
      name: String(r["column_name"]),
      type: String(r["data_type"]),
      nullable: String(r["is_nullable"]).toUpperCase() === "YES",
    });
  }

  return tableOrder.map((name) => ({
    name,
    columns: colsByTable.get(name) ?? [],
    primary_key: pkByTable.get(name) ?? [],
    indexes: idxByTable.get(name) ?? [],
  }));
}

/** Map raw FK rows into {@link PgRelationship}[]. */
export function buildRelationships(fkRows: Record<string, unknown>[]): PgRelationship[] {
  return fkRows.map((r) => ({
    from_table: String(r["from_table"]),
    from_column: String(r["from_column"]),
    to_table: String(r["to_table"]),
    to_column: String(r["to_column"]),
  }));
}
