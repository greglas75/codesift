/** SQL schema drift detection capability. */

import type { CodeSymbol } from "../types.js";
import { getCodeIndex } from "./index-tools.js";
import { normalizeSqlType } from "./sql-shared-tools.js";

export type DriftKind = "extra_in_orm" | "extra_in_sql" | "type_mismatch";

export interface SchemaDrift {
  kind: DriftKind;
  table: string;
  column?: string;
  orm: "prisma" | "drizzle" | "typeorm";
  orm_file?: string;
  orm_line?: number;
  sql_file?: string;
  sql_line?: number;
  orm_type?: string;
  sql_type?: string;
  detail: string;
}

export interface DriftSummary {
  extra_in_orm: number;
  extra_in_sql: number;
  type_mismatches: number;
  total: number;
}

export interface SchemaDriftResult {
  drifts: SchemaDrift[];
  summary: DriftSummary;
  orms_detected: Array<"prisma" | "drizzle" | "typeorm">;
  warnings: string[];
}

export interface AnalyzeSchemaDriftOptions {
  file_pattern?: string;
}

/** Internal: field info parsed from a Prisma model source block */
interface PrismaField {
  name: string;       // Prisma field name (camelCase typically)
  db_name: string;    // If @map("db_col") → that; else snake_case of name
  type: string;       // "Int", "String", "Float", "DateTime", ...
  optional: boolean;
  is_id: boolean;
  is_relation: boolean;
}

interface PrismaModel {
  name: string;        // Prisma model name (PascalCase)
  table: string;       // @@map("...") value or snake_case(name)
  file: string;
  line: number;
  fields: PrismaField[];
}

/** Parse a Prisma model block source → fields + @@map table name */
function parsePrismaModel(sym: CodeSymbol): PrismaModel {
  const source = sym.source ?? "";
  const lines = source.split("\n");
  const fields: PrismaField[] = [];
  let tableName = camelToSnake(sym.name);

  // @@map("table_name")
  const mapMatch = /@@map\s*\(\s*"([^"]+)"\s*\)/.exec(source);
  if (mapMatch) tableName = mapMatch[1]!;

  // Field line pattern: `  fieldName Type? @attr @attr`
  const FIELD_RE = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/;
  const RELATION_RE = /@relation/;
  const MAP_ATTR_RE = /@map\s*\(\s*"([^"]+)"\s*\)/;
  // Prisma scalar types — anything else with an uppercase first letter is a model relation
  const SCALAR_TYPES = new Set([
    "Int", "BigInt", "Float", "Decimal", "String", "Boolean", "DateTime", "Json", "Bytes", "Unsupported",
  ]);

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip model header, closing brace, comments, attributes
    if (trimmed.startsWith("model ") || trimmed === "" || trimmed === "}") continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

    const m = FIELD_RE.exec(trimmed);
    if (!m) continue;

    const name = m[1]!;
    const type = m[2]!;
    const isList = m[3] === "[]";
    const optional = m[4] === "?";
    const attrs = m[5] ?? "";

    // Skip reserved keywords that aren't fields (e.g. "model", "enum")
    if (/^(model|enum|type|view)$/.test(name)) continue;

    const is_id = /@id\b/.test(attrs);
    // A field is a relation if:
    // 1. It has @relation attr, OR
    // 2. It's a list (Type[]) — always a relation side, OR
    // 3. Its type starts with uppercase AND isn't a built-in scalar (→ custom model)
    const is_relation =
      RELATION_RE.test(attrs) ||
      isList ||
      (/^[A-Z]/.test(type) && !SCALAR_TYPES.has(type));

    // Relations aren't real DB columns — skip for drift purposes
    if (is_relation) continue;

    // @map("db_col") overrides the db name
    const mapField = MAP_ATTR_RE.exec(attrs);
    const db_name = mapField ? mapField[1]! : camelToSnake(name);

    fields.push({ name, db_name, type, optional, is_id, is_relation });
  }

  return {
    name: sym.name,
    table: tableName,
    file: sym.file,
    line: sym.start_line,
    fields,
  };
}

function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z])/g, (_, c: string) => "_" + c.toLowerCase())
    .replace(/^_/, "");
}

/**
 * Normalize a type name for cross-layer comparison.
 * Prisma Int → int, SQL INTEGER → int, Float → float, etc.
 *
 * Handles signatures like "TEXT NOT NULL", "SERIAL PRIMARY KEY", "int(10) unsigned".
 * Extracts the base type word, then groups by semantic equivalence.
 */

export async function analyzeSchemaDrift(
  repo: string,
  options?: AnalyzeSchemaDriftOptions,
): Promise<SchemaDriftResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const filePattern = options?.file_pattern;
  const drifts: SchemaDrift[] = [];
  const warnings: string[] = [];
  const orms_detected: Array<"prisma" | "drizzle" | "typeorm"> = [];

  // Collect SQL tables and fields
  const sqlTables = new Map<string, {
    file: string;
    line: number;
    columns: Map<string, { type: string; file: string; line: number }>;
  }>();

  for (const sym of index.symbols) {
    if (sym.kind !== "table") continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;

    const columns = new Map<string, { type: string; file: string; line: number }>();
    const fields = index.symbols.filter(
      (f) => f.kind === "field" && f.parent === sym.id,
    );
    for (const f of fields) {
      columns.set(f.name.toLowerCase(), {
        type: f.signature ?? "unknown",
        file: f.file,
        line: f.start_line,
      });
    }
    sqlTables.set(sym.name.toLowerCase(), {
      file: sym.file,
      line: sym.start_line,
      columns,
    });
  }

  // Collect Prisma models (kind === "class" in prisma extractor)
  const prismaModels: PrismaModel[] = [];
  for (const sym of index.symbols) {
    if (sym.kind !== "class") continue;
    if (!sym.file.endsWith(".prisma")) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    prismaModels.push(parsePrismaModel(sym));
  }
  if (prismaModels.length > 0) orms_detected.push("prisma");

  // TODO: Drizzle and TypeORM collection (v1.2)

  if (orms_detected.length === 0) {
    warnings.push("No ORM models found in repository. analyze_schema_drift requires at least one ORM (Prisma/Drizzle/TypeORM).");
    return {
      drifts: [],
      summary: { extra_in_orm: 0, extra_in_sql: 0, type_mismatches: 0, total: 0 },
      orms_detected,
      warnings,
    };
  }

  // Cross-reference: Prisma models vs SQL tables
  const matchedSqlTables = new Set<string>();

  for (const model of prismaModels) {
    const sqlTable = sqlTables.get(model.table.toLowerCase());
    if (!sqlTable) {
      // Prisma model has no matching SQL table → extra_in_orm
      drifts.push({
        kind: "extra_in_orm",
        table: model.table,
        orm: "prisma",
        orm_file: model.file,
        orm_line: model.line,
        detail: `Prisma model "${model.name}" maps to table "${model.table}" which does not exist in SQL schema.`,
      });
      continue;
    }
    matchedSqlTables.add(model.table.toLowerCase());

    // Compare fields
    const sqlCols = sqlTable.columns;
    const matchedSqlCols = new Set<string>();

    for (const field of model.fields) {
      const sqlCol = sqlCols.get(field.db_name.toLowerCase());
      if (!sqlCol) {
        drifts.push({
          kind: "extra_in_orm",
          table: model.table,
          column: field.name,
          orm: "prisma",
          orm_file: model.file,
          orm_line: model.line,
          orm_type: field.type,
          detail: `Prisma field "${model.name}.${field.name}" (maps to "${field.db_name}") does not exist in SQL table "${model.table}".`,
        });
        continue;
      }
      matchedSqlCols.add(field.db_name.toLowerCase());

      // Type compatibility check
      const ormNorm = normalizeSqlType(field.type);
      const sqlNorm = normalizeSqlType(sqlCol.type);
      if (ormNorm !== sqlNorm && ormNorm !== "unknown" && sqlNorm !== "unknown") {
        drifts.push({
          kind: "type_mismatch",
          table: model.table,
          column: field.name,
          orm: "prisma",
          orm_file: model.file,
          orm_line: model.line,
          sql_file: sqlCol.file,
          sql_line: sqlCol.line,
          orm_type: field.type,
          sql_type: sqlCol.type,
          detail: `Type mismatch: Prisma "${model.name}.${field.name}" is "${field.type}" (${ormNorm}) but SQL "${model.table}.${field.db_name}" is "${sqlCol.type}" (${sqlNorm}).`,
        });
      }
    }

    // SQL columns not covered by any Prisma field → extra_in_sql (column-level)
    for (const [colName, sqlCol] of sqlCols) {
      if (matchedSqlCols.has(colName)) continue;
      // Don't flag common auto-columns that Prisma often omits
      if (/^(created_at|updated_at|deleted_at)$/i.test(colName)) continue;
      drifts.push({
        kind: "extra_in_sql",
        table: model.table,
        column: colName,
        orm: "prisma",
        sql_file: sqlCol.file,
        sql_line: sqlCol.line,
        sql_type: sqlCol.type,
        detail: `SQL column "${model.table}.${colName}" has no corresponding field in Prisma model "${model.name}".`,
      });
    }
  }

  // SQL tables with no Prisma model → extra_in_sql (table-level)
  for (const [tableName, sqlTable] of sqlTables) {
    if (matchedSqlTables.has(tableName)) continue;
    drifts.push({
      kind: "extra_in_sql",
      table: tableName,
      orm: "prisma",
      sql_file: sqlTable.file,
      sql_line: sqlTable.line,
      detail: `SQL table "${tableName}" has no corresponding Prisma model.`,
    });
  }

  const summary: DriftSummary = {
    extra_in_orm: drifts.filter((d) => d.kind === "extra_in_orm").length,
    extra_in_sql: drifts.filter((d) => d.kind === "extra_in_sql").length,
    type_mismatches: drifts.filter((d) => d.kind === "type_mismatch").length,
    total: drifts.length,
  };

  // Heuristic warning: if >50% of ORM tables have no SQL counterpart, this is
  // likely a Prisma-migrate style project where SQL files are incremental
  // migrations, not a full schema snapshot. In that case table-level drift
  // is noise — the real signal is field-level drift on matched tables.
  const totalOrmTables = prismaModels.length;
  const orphanOrmTables = drifts.filter(
    (d) => d.kind === "extra_in_orm" && !d.column,
  ).length;
  if (totalOrmTables > 0 && orphanOrmTables / totalOrmTables > 0.5) {
    warnings.push(
      `${orphanOrmTables}/${totalOrmTables} Prisma models have no SQL counterpart. ` +
      `This likely means the project uses Prisma Migrate (incremental migrations) ` +
      `rather than a full schema.sql snapshot. Field-level drifts on matched tables ` +
      `are still meaningful; ignore table-level extra_in_orm drifts in this mode.`,
    );
  }

  return { drifts, summary, orms_detected, warnings };
}

// ── sql_audit (composite) ─────────────────────────────────
