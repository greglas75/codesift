import { z, zBool, zNum, lazySchema, type ToolDefinitionEntry, type ToolCategory } from "./shared.js";

export const SQL_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  // ── SQL analysis tools (hidden/discoverable) ─────────────
  { order: 4622, definition: {
    name: "analyze_schema",
    category: "analysis" as ToolCategory,
    searchHint: "SQL schema ERD entity relationship tables views columns foreign key database migration MySQL Postgres SQLite dialect",
    description: "Analyze SQL schema: tables, views, columns, foreign keys, relationships. Auto-detects dialect (mysql/postgres/sqlite/mssql) from schema fingerprints. Output as JSON or Mermaid ERD.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Filter SQL files by pattern (e.g. 'migrations/')"),
      output_format: z.enum(["json", "mermaid"]).optional().describe("Output format (default: json)"),
      include_columns: zBool().describe("Include column details in output (default: true)"),
      dialect: z.enum(["auto", "mysql", "postgres", "sqlite", "mssql", "unknown"]).optional().describe("Force dialect, or 'auto' to detect from ENGINE=InnoDB / SERIAL / AUTOINCREMENT etc. (default: auto)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { analyzeSchema } = await import("../tools/sql-tools.js");
      const opts: Parameters<typeof analyzeSchema>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.output_format != null) opts!.output_format = args.output_format as "json" | "mermaid";
      if (args.include_columns != null) opts!.include_columns = args.include_columns as boolean;
      if (args.dialect != null) opts!.dialect = args.dialect as Parameters<typeof analyzeSchema>[1] extends infer T ? T extends { dialect?: infer D } ? D : never : never;
      const result = await analyzeSchema(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`Tables: ${result.tables.length} | Views: ${result.views.length} | Relationships: ${result.relationships.length} | Dialect: ${result.detected_dialect}`);
      if (result.warnings.length > 0) parts.push(`Warnings: ${result.warnings.join("; ")}`);
      if (result.mermaid) {
        parts.push("");
        parts.push(result.mermaid);
      } else {
        for (const t of result.tables) {
          const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(", ");
          parts.push(`  ${t.name} (${t.file}:${t.line}) — ${cols || "(no columns)"}`);
        }
        for (const v of result.views) {
          parts.push(`  VIEW ${v.name} (${v.file}:${v.line})`);
        }
        if (result.relationships.length > 0) {
          parts.push("Relationships:");
          for (const r of result.relationships) {
            parts.push(`  ${r.from_table}.${r.from_column} → ${r.to_table}.${r.to_column} [${r.type}]`);
          }
        }
      }
      return parts.join("\n");
    },
  } },
  { order: 4666, definition: {
    name: "trace_query",
    category: "analysis" as ToolCategory,
    searchHint: "SQL table query trace references cross-language ORM Prisma Drizzle migration",
    description: "Trace SQL table references across the codebase: DDL, DML, FK, and ORM models (Prisma, Drizzle).",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      table: z.string().describe("Table name to trace (required)"),
      include_orm: zBool().describe("Check Prisma/Drizzle ORM models (default: true)"),
      file_pattern: z.string().optional().describe("Scope search to files matching pattern"),
      max_references: zNum().describe("Maximum references to return (default: 500)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { traceQuery } = await import("../tools/sql-tools.js");
      const opts: Parameters<typeof traceQuery>[1] = {
        table: args.table as string,
      };
      if (args.include_orm != null) opts!.include_orm = args.include_orm as boolean;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_references != null) opts!.max_references = args.max_references as number;
      const result = await traceQuery(args.repo as string, opts);
      const parts: string[] = [];
      if (result.table_definition) {
        parts.push(`Definition: ${result.table_definition.file}:${result.table_definition.line} [${result.table_definition.kind}]`);
      } else {
        parts.push(`Definition: not found in index`);
      }
      parts.push(`SQL references: ${result.sql_references.length}${result.truncated ? " (truncated)" : ""}`);
      for (const ref of result.sql_references.slice(0, 50)) {
        parts.push(`  ${ref.file}:${ref.line} [${ref.type}] ${ref.context}`);
      }
      if (result.orm_references.length > 0) {
        parts.push(`ORM references: ${result.orm_references.length}`);
        for (const ref of result.orm_references) {
          parts.push(`  ${ref.file}:${ref.line} [${ref.orm}] model ${ref.model_name}`);
        }
      }
      if (result.warnings.length > 0) {
        parts.push(`Warnings: ${result.warnings.join("; ")}`);
      }
      return parts.join("\n");
    },
  } },
  { order: 4709, definition: {
    name: "sql_audit",
    category: "analysis" as ToolCategory,
    searchHint: "SQL audit composite drift orphan lint DML safety complexity god table schema diagnostic",
    description: "Composite SQL audit — runs 5 diagnostic gates (drift, orphan, lint, dml, complexity) in one call. Use this instead of calling the individual gate functions separately.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      checks: z.array(z.enum(["drift", "orphan", "lint", "dml", "complexity"])).optional().describe("Subset of gates to run (default: all 5)"),
      file_pattern: z.string().optional().describe("Scope to files matching pattern"),
      max_results: zNum().describe("Max DML findings per pattern (default: 200)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { sqlAudit } = await import("../tools/sql-tools.js");
      const opts: Parameters<typeof sqlAudit>[1] = {};
      if (args.checks != null) opts.checks = args.checks as ("drift" | "orphan" | "lint" | "dml" | "complexity")[];
      if (args.file_pattern != null) opts.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts.max_results = args.max_results as number;
      const result = await sqlAudit(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`SQL audit: ${result.summary.gates_run} gates run, ${result.summary.gates_passed} passed, ${result.summary.gates_failed} failed`);
      parts.push(`  Total findings:    ${result.summary.total_findings}`);
      parts.push(`  Critical findings: ${result.summary.critical_findings}`);
      parts.push("");
      for (const g of result.gates) {
        const icon = g.pass ? "✓" : (g.critical ? "✗ CRITICAL" : "⚠");
        parts.push(`${icon} ${g.check}: ${g.summary}`);
      }
      if (result.warnings.length > 0) {
        parts.push("");
        parts.push("─── Warnings ───");
        for (const w of result.warnings) parts.push(`  ⚠ ${w}`);
      }
      return parts.join("\n");
    },
  } },
  { order: 4744, definition: {
    name: "diff_migrations",
    category: "analysis" as ToolCategory,
    searchHint: "migration diff SQL destructive DROP ALTER ADD schema change deploy risk",
    description: "Scan SQL migration files and classify operations as additive (CREATE TABLE), modifying (ALTER ADD), or destructive (DROP TABLE, DROP COLUMN, TRUNCATE). Flags deploy risks.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      file_pattern: z.string().optional().describe("Scope to migration files matching pattern"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { diffMigrations } = await import("../tools/sql-tools.js");
      const opts: Parameters<typeof diffMigrations>[1] = {};
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      const result = await diffMigrations(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`Migration ops: ${result.summary.additive + result.summary.modifying + result.summary.destructive} across ${result.summary.total_files} files`);
      parts.push(`  additive:    ${result.summary.additive}`);
      parts.push(`  modifying:   ${result.summary.modifying}`);
      parts.push(`  destructive: ${result.summary.destructive}`);
      if (result.destructive.length > 0) {
        parts.push("\n⚠ DESTRUCTIVE:");
        for (const d of result.destructive) {
          parts.push(`  [${d.severity.toUpperCase()}] ${d.operation} ${d.target}  (${d.file}:${d.line})`);
        }
      }
      if (result.modifying.length > 0) {
        parts.push("\nModifying:");
        for (const m of result.modifying.slice(0, 20)) {
          parts.push(`  ${m.operation} ${m.target}  (${m.file}:${m.line})`);
        }
      }
      return parts.join("\n");
    },
  } },
  { order: 4778, definition: {
    name: "search_columns",
    category: "search" as ToolCategory,
    searchHint: "search column SQL table field name type database schema find",
    description: "Search SQL columns across all tables by name (substring), type (int/string/float/...), or parent table. Returns column name, type, table, file, and line. Like search_symbols but scoped to SQL fields.",
    schema: lazySchema(() => ({
      repo: z.string().optional().describe("Repository identifier (default: auto-detected from CWD)"),
      query: z.string().describe("Column name substring to match (case-insensitive). Empty = no name filter."),
      type: z.string().optional().describe("Filter by normalized type: int, string, float, bool, datetime, json, uuid, bytes"),
      table: z.string().optional().describe("Filter by table name substring"),
      file_pattern: z.string().optional().describe("Scope to files matching pattern"),
      max_results: zNum().describe("Max columns to return (default: 100)"),
    })),
    handler: async (args: Record<string, unknown>) => {
      const { searchColumns } = await import("../tools/sql-tools.js");
      const opts: Parameters<typeof searchColumns>[1] = {
        query: (args.query as string) ?? "",
      };
      if (args.type != null) opts!.type = args.type as string;
      if (args.table != null) opts!.table = args.table as string;
      if (args.file_pattern != null) opts!.file_pattern = args.file_pattern as string;
      if (args.max_results != null) opts!.max_results = args.max_results as number;
      const result = await searchColumns(args.repo as string, opts);
      const parts: string[] = [];
      parts.push(`Columns: ${result.columns.length}${result.truncated ? `/${result.total} (truncated)` : ""}`);
      for (const c of result.columns) {
        parts.push(`  ${c.table}.${c.name.padEnd(24)} ${c.normalized_type.padEnd(10)} ${c.file}:${c.line}`);
      }
      return parts.join("\n");
    },
  } },
  // --- PostgreSQL live introspection (hidden/discoverable) ---
  { order: 4810, definition: {
    name: "introspect_pg",
    category: "analysis" as ToolCategory,
    searchHint: "postgres postgresql live schema introspect information_schema tables columns drift live database",
    description: "Introspect a live PostgreSQL database schema via information_schema. Reads table/column structure from a running PG instance. Connection string is read from the CODESIFT_PG_CONN_STR environment variable (never passed as an argument — SSRF/CQ5 safety). Optionally runs pgDriftCheck to compare the live schema against migration-derived SQL symbols in the index.",
    schema: lazySchema(() => ({
      schema: z.string().optional().describe("PostgreSQL schema name (default: 'public')"),
      drift_check: z.boolean().optional().describe("When true, compare live schema against migration-derived SQL symbols in the index and return drift report"),
      repo: z.string().optional().describe("Repository identifier for drift_check (default: auto-detected from CWD). Only used when drift_check=true."),
    })),
    handler: async (args) => {
      const { loadConfig } = await import("../config.js");
      const connStr = loadConfig().pgConnStr;
      if (!connStr) {
        return { error: "CODESIFT_PG_CONN_STR not set — export a read-only connection string to enable live introspection" };
      }
      const { introspectPgSchema, pgDriftCheck } = await import("../tools/pg-introspect-tools.js");
      const introspectOpts: import("../tools/pg-introspect-tools.js").IntrospectPgOptions = {};
      if (args.schema != null) introspectOpts.schema = args.schema as string;
      const result = await introspectPgSchema(connStr, introspectOpts);
      if ("error" in result) return result;
      if (args.drift_check === true) {
        // Fail loud at the TOP level (not buried under `drift`) so pipelines
        // gating on `"error" in result` don't silently skip drift validation.
        // Without resolved migration-schema symbols, pgDriftCheck would report
        // a vacuous "no drift" — the exact false-negative we're guarding.
        const repo = typeof args.repo === "string" ? args.repo.trim() : "";
        if (!repo) {
          return {
            error:
              "drift_check requires an explicit `repo` to load migration-derived schema symbols",
          };
        }
        const { getCodeIndex } = await import("../tools/index-tools.js");
        const index = await getCodeIndex(repo);
        if (!index) {
          return {
            error: `drift_check: repo '${repo}' is not indexed — cannot load migration-derived schema symbols`,
          };
        }
        const symbols = index.symbols ?? [];
        const drift = pgDriftCheck(result, symbols);
        return { ...result, drift };
      }
      return result;
    },
  } },
];
