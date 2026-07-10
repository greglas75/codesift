/**
 * Comprehensive Mobi2 audit using CodeSift tools.
 * Runs many tools in parallel and prints a structured English report.
 */
import { getCodeIndex } from "../src/tools/index-tools.js";
import {
  findPhpNPlusOne,
  findPhpGodModel,
  analyzeActiveRecord,
  phpSecurityScan,
  phpProjectAudit,
  findPhpViews,
  resolvePhpService,
} from "../src/tools/php-tools.js";
import { analyzeComplexity } from "../src/tools/complexity-tools.js";
import { findDeadCode } from "../src/tools/symbol-tools.js";
import { analyzeHotspots } from "../src/tools/hotspot-tools.js";
import { findClones } from "../src/tools/clone-tools.js";
import { scanSecrets } from "../src/tools/secret-tools.js";
import { searchPatterns } from "../src/tools/pattern-tools.js";
import { collectImportEdges } from "../src/utils/import-graph.js";

const REPO = "local/Mobi2";

function header(title: string) {
  console.log("\n" + "═".repeat(78));
  console.log(`  ${title}`);
  console.log("═".repeat(78));
}

function sub(title: string) {
  console.log("\n" + "─".repeat(78));
  console.log(`  ${title}`);
  console.log("─".repeat(78));
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; result: T | null; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { label, result, ms: Date.now() - t0 };
  } catch (err) {
    return { label, result: null, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  header("Mobi2 Comprehensive Audit (CodeSift)");

  // Load existing index (from prior validation run)
  console.log("\nLoading Mobi2 index...");
  const index = await getCodeIndex(REPO);
  if (!index) {
    console.error("No index. Run mobi2-php-gaps-validation.ts first.");
    process.exit(1);
  }
  console.log(`✓ ${index.file_count} files, ${index.symbol_count} symbols, root: ${index.root}`);

  // Run all tools in parallel
  console.log("\nRunning audits in parallel (may take 1-2 min)...");
  const t0 = Date.now();

  const results = await Promise.all([
    timed("php_project_audit", () => phpProjectAudit(REPO, { file_pattern: ".php" })),
    timed("analyze_activerecord", () => analyzeActiveRecord(REPO)),
    timed("find_php_n_plus_one", () => findPhpNPlusOne(REPO, { limit: 500 })),
    timed("find_php_god_model", () => findPhpGodModel(REPO)),
    timed("php_security_scan", () => phpSecurityScan(REPO, { file_pattern: ".php" })),
    timed("analyze_complexity", () => analyzeComplexity(REPO, { file_pattern: ".php", top_n: 20 })),
    timed("find_dead_code", () => findDeadCode(REPO, { file_pattern: ".php" })),
    timed("analyze_hotspots", () => analyzeHotspots(REPO, { since_days: 90, top_n: 20 })),
    timed("find_clones", () => findClones(REPO, { file_pattern: ".php", min_similarity: 0.85 })),
    timed("scan_secrets", () => scanSecrets(REPO, { file_pattern: ".php", min_confidence: "medium" })),
    timed("search_patterns(empty-catch)", () => searchPatterns(REPO, "empty-catch", { file_pattern: ".php" })),
    timed("search_patterns(console-log-prod)", () => searchPatterns(REPO, "var-dump-left", { file_pattern: ".php" })),
    timed("find_php_views", () => findPhpViews(REPO)),
    timed("resolve_php_service", () => resolvePhpService(REPO)),
    timed("collectImportEdges", () => collectImportEdges(index)),
  ]);

  console.log(`\n✓ All audits completed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Per-tool status
  sub("Tool execution summary");
  for (const r of results) {
    const status = r.error ? `✗ FAIL (${r.error.slice(0, 40)})` : "✓ OK";
    console.log(`  ${status.padEnd(45)} ${r.label.padEnd(30)} ${r.ms}ms`);
  }

  // Results by category
  const byLabel = new Map(results.map(r => [r.label, r] as const));
  const get = <T>(label: string): T | null => (byLabel.get(label)?.result as T) ?? null;

  // === 1. Project audit (compound) ===
  header("1. PHP Project Audit — 9-gate compound");
  const audit = get<any>("php_project_audit");
  if (audit) {
    console.log(`  Health score: ${audit.summary.health_score}/100`);
    console.log(`  Total findings: ${audit.summary.total_findings}`);
    console.log(`  Duration: ${(audit.duration_ms / 1000).toFixed(1)}s`);
    console.log("\n  Per-gate breakdown:");
    for (const g of audit.gates) {
      const status = g.status === "ok" ? "✓" : g.status === "timeout" ? "⏱ " : "✗";
      console.log(`    ${status} ${g.name.padEnd(15)} ${String(g.findings_count).padStart(5)} findings  (${g.duration_ms}ms)`);
    }
    if (audit.summary.top_risks?.length) {
      console.log("\n  Top risks:");
      for (const risk of audit.summary.top_risks) console.log(`    • ${risk}`);
    }
  }

  // === 2. ActiveRecord analysis ===
  header("2. ActiveRecord Models (Yii2)");
  const ar = get<any>("analyze_activerecord");
  if (ar) {
    console.log(`  Total models: ${ar.total}`);
    const withTable = ar.models.filter((m: any) => m.table_name).length;
    const withRelations = ar.models.filter((m: any) => m.relations.length > 0).length;
    const withRules = ar.models.filter((m: any) => m.rules.length > 0).length;
    const withBehaviors = ar.models.filter((m: any) => m.behaviors.length > 0).length;
    console.log(`    with tableName():     ${withTable}`);
    console.log(`    with relations:       ${withRelations}`);
    console.log(`    with rules():         ${withRules}`);
    console.log(`    with behaviors:       ${withBehaviors}`);
    console.log(`    MISSING rules():      ${ar.total - withRules}  (potential bug farm)`);
    const avgMethods = ar.models.reduce((s: number, m: any) => s + m.methods.length, 0) / ar.total;
    const avgRelations = ar.models.reduce((s: number, m: any) => s + m.relations.length, 0) / ar.total;
    console.log(`    avg methods/model:    ${avgMethods.toFixed(1)}`);
    console.log(`    avg relations/model:  ${avgRelations.toFixed(1)}`);
  }

  // === 3. God models ===
  header("3. God Models (Top 10 oversized)");
  const god = get<any>("find_php_god_model");
  if (god?.models) {
    console.log(`  Total flagged: ${god.total}\n`);
    for (const m of god.models.slice(0, 10)) {
      console.log(`  ${m.name}  (${m.file.slice(-50)})`);
      console.log(`    methods=${m.method_count}  relations=${m.relation_count}  lines=${m.line_count}`);
      console.log(`    reasons: ${m.reasons.join(" | ")}`);
    }
  }

  // === 4. N+1 queries ===
  header("4. N+1 Query Hotspots (Top 15)");
  const npl = get<any>("find_php_n_plus_one");
  if (npl?.findings) {
    console.log(`  Total findings: ${npl.total}\n`);
    // Group by file
    const byFile = new Map<string, any[]>();
    for (const f of npl.findings) {
      const arr = byFile.get(f.file) ?? [];
      arr.push(f);
      byFile.set(f.file, arr);
    }
    const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15);
    console.log("  Files with most N+1 hits:");
    for (const [file, hits] of sortedFiles) {
      console.log(`    ${String(hits.length).padStart(3)}  ${file.slice(-60)}`);
    }
    console.log("\n  First 10 individual findings:");
    for (const f of npl.findings.slice(0, 10)) {
      console.log(`    ${f.file.slice(-50)}:${f.line}  ${f.method}() → $item->${f.relation}`);
    }
  }

  // === 5. Security ===
  header("5. Security Scan (8 PHP patterns)");
  const sec = get<any>("php_security_scan");
  if (sec) {
    console.log(`  Total findings: ${sec.summary.total}`);
    console.log(`    critical: ${sec.summary.critical}`);
    console.log(`    high:     ${sec.summary.high}`);
    console.log(`    medium:   ${sec.summary.medium}`);
    console.log(`    low:      ${sec.summary.low}`);
    // Group by pattern
    const byPattern = new Map<string, number>();
    for (const f of sec.findings) {
      byPattern.set(f.pattern, (byPattern.get(f.pattern) ?? 0) + 1);
    }
    console.log("\n  Findings by pattern:");
    for (const [pat, count] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(4)}  ${pat}`);
    }
    console.log("\n  First 10 critical/high findings:");
    const criticalHigh = sec.findings.filter((f: any) => f.severity === "critical" || f.severity === "high").slice(0, 10);
    for (const f of criticalHigh) {
      console.log(`    [${f.severity}] ${f.pattern}`);
      console.log(`      ${f.file.slice(-50)}:${f.line}`);
      console.log(`      ${f.context.slice(0, 70)}`);
    }
  }

  // === 6. Secrets ===
  header("6. Secret Scan");
  const secrets = get<any>("scan_secrets");
  if (secrets) {
    const total = secrets.matches?.length ?? secrets.findings?.length ?? 0;
    console.log(`  Total potential secrets: ${total}`);
    const matches = secrets.matches ?? secrets.findings ?? [];
    for (const m of matches.slice(0, 10)) {
      console.log(`    [${m.confidence ?? "?"}] ${m.rule ?? m.type ?? "secret"}`);
      console.log(`      ${(m.file ?? m.path ?? "").slice(-50)}:${m.line ?? m.start_line ?? "?"}`);
    }
  }

  // === 7. Complexity ===
  header("7. Complexity Hotspots (Top 15)");
  const complex = get<any>("analyze_complexity");
  if (complex) {
    const funcs = complex.functions ?? complex.hotspots ?? complex.top ?? [];
    console.log(`  Above threshold: ${complex.summary?.above_threshold ?? funcs.length}\n`);
    for (const f of funcs.slice(0, 15)) {
      const name = f.name ?? f.symbol ?? "?";
      const file = (f.file ?? f.path ?? "").slice(-45);
      const cc = f.cyclomatic ?? f.complexity ?? f.score ?? "?";
      const lines = f.lines ?? f.loc ?? "?";
      console.log(`    cc=${String(cc).padStart(3)}  lines=${String(lines).padStart(4)}  ${name}`);
      console.log(`      ${file}`);
    }
  }

  // === 8. Dead code ===
  header("8. Dead Code");
  const dead = get<any>("find_dead_code");
  if (dead) {
    const candidates = dead.candidates ?? dead.findings ?? [];
    console.log(`  Candidates: ${candidates.length}\n`);
    const byKind = new Map<string, number>();
    for (const c of candidates) {
      const k = c.kind ?? "?";
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    console.log("  By kind:");
    for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
    console.log("\n  First 10 candidates:");
    for (const c of candidates.slice(0, 10)) {
      console.log(`    ${c.kind ?? "?"}  ${c.name ?? "?"}  (${(c.file ?? "").slice(-45)})`);
    }
  }

  // === 9. Git hotspots ===
  header("9. Git Churn Hotspots (Top 15, 90 days)");
  const hot = get<any>("analyze_hotspots");
  if (hot) {
    console.log(`  Total hotspot files: ${hot.total_files}`);
    console.log(`  Period: ${hot.period}\n`);
    for (const h of (hot.hotspots ?? []).slice(0, 15)) {
      console.log(`    score=${String(h.hotspot_score).padStart(8)}  commits=${String(h.commits).padStart(3)}  lines=${String(h.lines_changed).padStart(5)}  ${h.file.slice(-50)}`);
    }
  }

  // === 10. Clones ===
  header("10. Code Duplication");
  const clones = get<any>("find_clones");
  if (clones) {
    const arr = clones.clones ?? clones.pairs ?? [];
    console.log(`  Clone pairs (≥85% similarity): ${arr.length}\n`);
    for (const c of arr.slice(0, 10)) {
      const sim = c.similarity ?? c.score ?? "?";
      const a = c.symbol_a ?? c.a ?? {};
      const b = c.symbol_b ?? c.b ?? {};
      console.log(`    sim=${(typeof sim === "number" ? sim.toFixed(2) : sim).padStart(5)}`);
      console.log(`      A: ${a.name ?? "?"} in ${(a.file ?? "").slice(-45)}`);
      console.log(`      B: ${b.name ?? "?"} in ${(b.file ?? "").slice(-45)}`);
    }
  }

  // === 11. Anti-patterns ===
  header("11. Anti-patterns");
  const emptyCatch = get<any>("search_patterns(empty-catch)");
  const varDump = get<any>("search_patterns(console-log-prod)");
  if (emptyCatch) console.log(`  empty-catch:   ${emptyCatch.matches?.length ?? 0} occurrences`);
  if (varDump) console.log(`  var-dump-left: ${varDump.matches?.length ?? 0} occurrences`);

  // === 12. Views + services ===
  header("12. Views / Services");
  const views = get<any>("find_php_views");
  const services = get<any>("resolve_php_service");
  if (views) console.log(`  Controller→view mappings: ${views.total}`);
  if (services) console.log(`  DI/service locator entries: ${services.total}`);

  // === 13. Import graph ===
  header("13. Import Graph (PSR-4 edges)");
  const edges = get<any[]>("collectImportEdges");
  if (edges) {
    const phpEdges = edges.filter(e => e.from.endsWith(".php") && e.to.endsWith(".php"));
    console.log(`  Total edges: ${edges.length}`);
    console.log(`  PHP→PHP edges: ${phpEdges.length}`);
    // Find most-imported files (fan-in hotspots)
    const fanIn = new Map<string, number>();
    for (const e of phpEdges) fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
    const topFanIn = [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log("\n  Top 10 most-imported PHP files (fan-in):");
    for (const [f, n] of topFanIn) {
      console.log(`    ${String(n).padStart(4)}  ${f.slice(-60)}`);
    }
  }

  header("Audit complete");
  console.log(`Total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("AUDIT FAILED:", err);
  process.exit(1);
});
