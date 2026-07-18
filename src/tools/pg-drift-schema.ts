import type { PgIntrospectResult } from "./pg-introspection.js";
import type { MigrationTable, SqlSymbol } from "./pg-drift-types.js";

export function buildMigrationTables(symbols: SqlSymbol[]): Map<string, MigrationTable> {
  const tables = new Map<string, MigrationTable>();
  const tableById = new Map<string, MigrationTable>();
  for (const symbol of symbols) {
    if (symbol.kind !== "table") continue;
    const table = { id: symbol.id, columns: new Map<string, string>() };
    tables.set(symbol.name.toLowerCase(), table);
    tableById.set(symbol.id, table);
  }
  for (const symbol of symbols) {
    if (symbol.kind !== "field" || !symbol.parent) continue;
    tableById.get(symbol.parent)?.columns.set(
      symbol.name.toLowerCase(),
      symbol.signature ?? "unknown",
    );
  }
  return tables;
}

export function buildLiveTables(live: PgIntrospectResult): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  for (const table of live.tables) {
    const columns = new Map<string, string>();
    for (const column of table.columns) columns.set(column.name.toLowerCase(), column.type);
    tables.set(table.name.toLowerCase(), columns);
  }
  return tables;
}
