/**
 * Run analyze_schema and trace_query against a real project.
 * Usage: npx tsx scripts/try-sql-tools.ts <project-root>
 */

import { indexFolder } from "../src/tools/index-tools.js";
import { analyzeSchema, traceQuery } from "../src/tools/sql-tools.js";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("usage: npx tsx scripts/try-sql-tools.ts <project-root>");
  process.exit(1);
}

console.log(`Indexing ${ROOT}...`);
const t0 = Date.now();
const result = await indexFolder(ROOT, { watch: false });
const indexTime = Date.now() - t0;
console.log(`✓ Indexed in ${indexTime}ms — repo: ${result.repo}`);
console.log("");

// ── analyze_schema ────────────────────────────────────────
console.log("═══ analyze_schema ═══");
const t1 = Date.now();
const schema = await analyzeSchema(result.repo);
const schemaTime = Date.now() - t1;
console.log(`Tables: ${schema.tables.length}`);
console.log(`Views:  ${schema.views.length}`);
console.log(`Relationships: ${schema.relationships.length}`);
console.log(`Warnings: ${schema.warnings.length}`);
console.log(`Time: ${schemaTime}ms`);
console.log("");

// Sample 5 tables with their columns
console.log("Top 5 tables (with column counts):");
const top5 = [...schema.tables].sort((a, b) => b.columns.length - a.columns.length).slice(0, 5);
for (const t of top5) {
  console.log(`  ${t.name.padEnd(35)} ${t.columns.length} cols  (${t.file}:${t.line})`);
}
console.log("");

// FK relationships sample
if (schema.relationships.length > 0) {
  console.log(`Top 10 FK relationships:`);
  for (const r of schema.relationships.slice(0, 10)) {
    console.log(`  ${r.from_table}.${r.from_column} → ${r.to_table}.${r.to_column} [${r.type}]`);
  }
  console.log("");
}

// Warnings (duplicate names, circular FKs, etc.)
if (schema.warnings.length > 0) {
  console.log(`Warnings (first 5):`);
  for (const w of schema.warnings.slice(0, 5)) console.log(`  ⚠ ${w}`);
  console.log("");
}

// Mermaid sample
const mermaid = await analyzeSchema(result.repo, { output_format: "mermaid" });
const mermaidLines = (mermaid.mermaid ?? "").split("\n").length;
console.log(`Mermaid ERD generated: ${mermaidLines} lines`);
console.log(`Sample:\n${(mermaid.mermaid ?? "").split("\n").slice(0, 8).join("\n")}`);
console.log("");

// ── trace_query ───────────────────────────────────────────
console.log("═══ trace_query ═══");

// Pick the first table we can find with refs
const probeTables = top5.slice(0, 3).map(t => t.name);
for (const tableName of probeTables) {
  const t2 = Date.now();
  const trace = await traceQuery(result.repo, { table: tableName, max_references: 50 });
  const traceTime = Date.now() - t2;
  console.log(`\nTable: ${tableName}  (${traceTime}ms)`);
  console.log(`  Definition:    ${trace.table_definition?.file ?? "not found"}`);
  console.log(`  SQL refs:      ${trace.sql_references.length}${trace.truncated ? " (truncated)" : ""}`);
  console.log(`  ORM refs:      ${trace.orm_references.length}`);
  console.log(`  Warnings:      ${trace.warnings.length}`);

  // Sample refs
  if (trace.sql_references.length > 0) {
    console.log(`  Sample SQL refs:`);
    for (const r of trace.sql_references.slice(0, 3)) {
      console.log(`    ${r.type.padEnd(4)} ${r.file}:${r.line}  ${r.context.slice(0, 60)}`);
    }
  }
  if (trace.warnings.length > 0) {
    for (const w of trace.warnings.slice(0, 2)) console.log(`  ⚠ ${w}`);
  }
}

console.log("\n✅ Done");
