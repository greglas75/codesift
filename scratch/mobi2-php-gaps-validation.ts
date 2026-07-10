/**
 * End-to-end validation of PHP gap fixes on Mobi2.
 *
 * Runs:
 *   1. Re-index Mobi2 (expect file count to drop after backup exclusion)
 *   2. Count synthetic @property/@method symbols (PHPDoc synthesis)
 *   3. Run find_php_n_plus_one
 *   4. Run find_php_god_model
 *   5. Count PHP import edges (PSR-4 cross-file resolution)
 */
import { indexFolder, getCodeIndex, invalidateCache } from "../src/tools/index-tools.js";
import { findPhpNPlusOne, findPhpGodModel } from "../src/tools/php-tools.js";
import { collectImportEdges } from "../src/utils/import-graph.js";

const MOBI2_ROOT = "/Users/greglas/DEV/Mobi2";
const REPO = "local/Mobi2";

function line(ch = "─") { console.log(ch.repeat(78)); }
function header(title: string) { line("═"); console.log(`  ${title}`); line("═"); }

async function main() {
  header("Mobi2 PHP Gap Validation");

  // 1. Invalidate + reindex
  console.log("\n▸ Invalidating cache + re-indexing Mobi2...");
  try { await invalidateCache(REPO); } catch { /* first run */ }

  const t0 = Date.now();
  const result = await indexFolder(MOBI2_ROOT, { watch: false });
  const indexMs = Date.now() - t0;
  console.log(`✓ Indexed in ${(indexMs / 1000).toFixed(1)}s`);
  console.log(`  files: ${result.file_count}`);
  console.log(`  symbols: ${result.symbol_count}`);

  const index = await getCodeIndex(REPO);
  if (!index) { console.error("Failed to load index"); process.exit(1); }

  // 2. Synthetic symbols from PHPDoc @property/@method
  header("Gap 4 — PHPDoc @property/@method synthesis");
  const synthetic = index.symbols.filter(s => s.meta?.synthetic);
  const synProperties = synthetic.filter(s => s.kind === "field");
  const synMethods = synthetic.filter(s => s.kind === "method");
  console.log(`  synthetic symbols: ${synthetic.length}`);
  console.log(`    @property → field: ${synProperties.length}`);
  console.log(`    @method → method: ${synMethods.length}`);
  console.log("\n  First 5 synthetic properties:");
  for (const s of synProperties.slice(0, 5)) {
    console.log(`    ${s.name} (${s.signature ?? "no type"}) in ${s.file.slice(0, 80)}`);
  }

  // 3. Backup file exclusion — look for any *copy.php files that slipped through
  header("Gap 2 — Backup file exclusion");
  const copyFiles = index.files.filter(f => /copy\.php$/i.test(f.path));
  const bakFiles = index.files.filter(f => /\.bak$|\.orig$|~$|\.swp$|\.swo$|\.DS_Store$/i.test(f.path));
  console.log(`  *copy.php files in index: ${copyFiles.length}  (should be 0)`);
  console.log(`  other backup files in index: ${bakFiles.length}  (should be 0)`);

  // 4. PSR-4 import edges
  header("Gap 3 — PSR-4 cross-file edges");
  const edgesT0 = Date.now();
  const edges = await collectImportEdges(index);
  const edgesMs = Date.now() - edgesT0;
  const phpEdges = edges.filter(e => e.from.endsWith(".php") && e.to.endsWith(".php"));
  console.log(`  collectImportEdges: ${edges.length} total edges in ${(edgesMs / 1000).toFixed(1)}s`);
  console.log(`  PHP → PHP edges: ${phpEdges.length}`);
  console.log("\n  First 5 PHP edges:");
  for (const e of phpEdges.slice(0, 5)) {
    console.log(`    ${e.from.slice(-60)}`);
    console.log(`      → ${e.to.slice(-60)}`);
  }

  // 5. find_php_n_plus_one
  header("Gap 5a — find_php_n_plus_one");
  const nplT0 = Date.now();
  const npl = await findPhpNPlusOne(REPO, { limit: 200 });
  const nplMs = Date.now() - nplT0;
  console.log(`  ${npl.total} findings in ${nplMs}ms`);
  console.log("\n  Top 10 N+1 hotspots:");
  for (const f of npl.findings.slice(0, 10)) {
    console.log(`    ${f.file.slice(-50)}:${f.line} ${f.method}() → $item->${f.relation}`);
  }

  // 6. find_php_god_model
  header("Gap 5b — find_php_god_model");
  const gmT0 = Date.now();
  const gm = await findPhpGodModel(REPO);
  const gmMs = Date.now() - gmT0;
  console.log(`  ${gm.total} god models found in ${gmMs}ms`);
  console.log("\n  Top 10 god models:");
  for (const m of gm.models.slice(0, 10)) {
    console.log(`    ${m.name} (${m.file.slice(-40)})`);
    console.log(`      methods=${m.method_count} relations=${m.relation_count} lines=${m.line_count}`);
    console.log(`      reasons: ${m.reasons.join(" | ")}`);
  }

  header("Summary");
  console.log(`  ✓ Gap 1 (parser error recovery): indexed without crashes`);
  console.log(`  ✓ Gap 2 (backup exclusion): ${copyFiles.length + bakFiles.length === 0 ? "clean" : "LEAKED " + (copyFiles.length + bakFiles.length)}`);
  console.log(`  ✓ Gap 3 (PSR-4 edges): ${phpEdges.length} PHP cross-file edges`);
  console.log(`  ✓ Gap 4 (PHPDoc synthesis): ${synthetic.length} synthetic symbols`);
  console.log(`  ✓ Gap 5a (N+1): ${npl.total} findings`);
  console.log(`  ✓ Gap 5b (god model): ${gm.total} findings`);
  line("═");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
