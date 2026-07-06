/** Shared SQL tool helpers. */

export type SqlDialect = "mysql" | "postgres" | "sqlite" | "mssql" | "unknown";

export function detectSqlDialect(source: string): SqlDialect {
  if (!source) return "unknown";
  // MySQL signals are the most specific — score first.
  if (
    /\bENGINE\s*=\s*(?:InnoDB|MyISAM|MEMORY|Aria)\b/i.test(source) ||
    /\bAUTO_INCREMENT\b/i.test(source) ||
    /\butf8mb4\b/i.test(source)
  ) return "mysql";

  // Postgres: SERIAL / JSONB / RETURNING are unmistakable.
  if (
    /\b(?:BIG)?SERIAL\b/i.test(source) ||
    /\bJSONB\b/i.test(source) ||
    /\bCITEXT\b/i.test(source) ||
    /\bRETURNING\b/i.test(source)
  ) return "postgres";

  // SQLite: AUTOINCREMENT (no underscore) / WITHOUT ROWID.
  if (
    /\bAUTOINCREMENT\b/i.test(source) ||
    /\bWITHOUT\s+ROWID\b/i.test(source)
  ) return "sqlite";

  // MS SQL Server: NVARCHAR / IDENTITY(seed, step) / square-bracket idents.
  if (
    /\bNVARCHAR\b/i.test(source) ||
    /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i.test(source)
  ) return "mssql";

  return "unknown";
}

// REFERENCES clause — supports unquoted, "double-quoted" (Postgres),
// `backtick` (MySQL), and [bracket] (SQL Server) identifiers. Schema-qualified
// names ("schema.table") are accepted; we keep only the table portion.
// Capture layout:
//   1: schema "..", 2: schema `..`, 3: schema [..], 4: schema unquoted
//   5: table  "..", 6: table  `..`, 7: table  [..], 8: table  unquoted

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── search_columns ────────────────────────────────────────

export function normalizeSqlType(raw: string): string {
  // Take the first word only (strip modifiers, constraints, size).
  // "TEXT NOT NULL" → "text", "int(10) unsigned" → "int", "DECIMAL(10,2)" → "decimal"
  const firstWord = /[a-zA-Z]+/.exec(raw)?.[0]?.toLowerCase() ?? "";

  // Group equivalents
  if (/^(int|integer|smallint|bigint|serial|bigserial|smallserial|tinyint|mediumint)$/.test(firstWord)) return "int";
  if (/^(float|real|double|decimal|numeric|money)$/.test(firstWord)) return "float";
  if (/^(text|varchar|char|string|nvarchar|longtext|mediumtext|tinytext)$/.test(firstWord)) return "string";
  if (/^(bool|boolean|bit)$/.test(firstWord)) return "bool";
  if (/^(timestamp|timestamptz|datetime|date|time|timetz)$/.test(firstWord)) return "datetime";
  if (/^(json|jsonb)$/.test(firstWord)) return "json";
  if (/^(uuid)$/.test(firstWord)) return "uuid";
  if (/^(bytea|blob|binary|longblob|mediumblob|tinyblob)$/.test(firstWord)) return "bytes";
  return firstWord || "unknown";
}
