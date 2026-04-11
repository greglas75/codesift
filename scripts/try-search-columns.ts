import { indexFolder } from "../src/tools/index-tools.js";
import { searchColumns } from "../src/tools/sql-tools.js";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("usage: npx tsx scripts/try-search-columns.ts <project-root>");
  process.exit(1);
}

console.log(`Indexing ${ROOT}...`);
const t0 = Date.now();
const res = await indexFolder(ROOT, { watch: false });
console.log(`✓ Indexed in ${Date.now() - t0}ms — repo: ${res.repo}`);
console.log("");

// Interesting queries
const queries: Array<{ label: string; opts: Parameters<typeof searchColumns>[1] }> = [
  { label: "all 'id' columns", opts: { query: "id" } },
  { label: "all 'email' columns", opts: { query: "email" } },
  { label: "all 'created_at' columns", opts: { query: "created_at" } },
  { label: "all int columns in 'orders'", opts: { query: "", type: "int", table: "orders" } },
  { label: "all columns with 'user' in name", opts: { query: "user" } },
  { label: "all timestamp columns", opts: { query: "", type: "datetime", max_results: 10 } },
];

for (const q of queries) {
  const t = Date.now();
  const result = await searchColumns(res.repo, q.opts);
  const ms = Date.now() - t;
  console.log(`${q.label}: ${result.columns.length}${result.truncated ? `/${result.total}` : ""} columns (${ms}ms)`);
  for (const c of result.columns.slice(0, 5)) {
    console.log(`  ${c.table}.${c.name.padEnd(24)} ${c.normalized_type.padEnd(10)} ${c.file}:${c.line}`);
  }
  if (result.columns.length > 5) console.log(`  ... and ${result.columns.length - 5} more`);
  console.log("");
}

console.log("✅ Done");
