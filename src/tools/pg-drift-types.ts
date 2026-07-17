export interface PgColumnMismatch {
  table: string;
  column: string;
  kind: "missing_live" | "missing_migrations" | "type_mismatch";
  live_type?: string;
  migrations_type?: string;
}

export interface PgDriftResult {
  missing_tables_live_only: string[];
  missing_tables_migrations_only: string[];
  column_mismatches: PgColumnMismatch[];
  note?: string;
}

export interface SqlSymbol {
  id: string;
  kind: string;
  name: string;
  parent?: string;
  signature?: string;
}

export interface MigrationTable {
  id: string;
  columns: Map<string, string>;
}
