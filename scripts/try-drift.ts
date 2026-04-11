/**
 * Run analyzeSchemaDrift on a project with SQL + Prisma.
 */

import { indexFolder } from "../src/tools/index-tools.js";
import { analyzeSchemaDrift } from "../src/tools/sql-tools.js";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("usage: npx tsx scripts/try-drift.ts <project-root>");
  process.exit(1);
}

console.log(`Indexing ${ROOT}...`);
const t0 = Date.now();
const res = await indexFolder(ROOT, { watch: false });
console.log(`✓ Indexed in ${Date.now() - t0}ms — repo: ${res.repo}`);

const t1 = Date.now();
const drift = await analyzeSchemaDrift(res.repo);
console.log(`analyze_schema_drift: ${Date.now() - t1}ms`);
console.log("");
console.log(`ORMs detected: ${drift.orms_detected.join(", ") || "(none)"}`);
console.log(`Total drifts:  ${drift.summary.total}`);
console.log(`  extra_in_orm:     ${drift.summary.extra_in_orm}`);
console.log(`  extra_in_sql:     ${drift.summary.extra_in_sql}`);
console.log(`  type_mismatches:  ${drift.summary.type_mismatches}`);

if (drift.warnings.length > 0) {
  console.log("");
  for (const w of drift.warnings) console.log(`⚠ ${w}`);
}

if (drift.drifts.length > 0) {
  console.log("");
  console.log("Drifts (first 20):");
  for (const d of drift.drifts.slice(0, 20)) {
    console.log(`  [${d.kind.padEnd(14)}] ${d.table}${d.column ? "." + d.column : ""}`);
    console.log(`    ${d.detail}`);
  }
}

console.log("\n✅ Done");
