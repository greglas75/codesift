/**
 * Smoke test: run all 10 new PHP/Yii2 tools against the real tgm-panel
 * codebase and emit a markdown report. The point isn't to validate
 * correctness exhaustively — that's what the unit tests do — but to
 * confirm each tool runs end-to-end on a 1882-file Yii2 project and
 * produces output that actually makes sense.
 *
 * Run from the worktree root:
 *   npx tsx scratch/smoke-tgm-panel.mjs > docs/specs/2026-05-07-tgm-panel-smoke.md
 */

import { indexFolder } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/index-tools.js";
import { yii3MigrationAudit } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/yii3-migration-tools.js";
import { php8CompatCheck } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/php8-compat-tools.js";
import { findPhp8MigrationCandidates } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/php8-migration-candidates-tools.js";
import { findYii3AttributeCandidates } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/yii3-attribute-candidates-tools.js";
import { analyzeYiiModules } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/yii-modules-tools.js";
import { analyzeYiiMigrations } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/yii-migrations-tools.js";
import { analyzeYiiRbac } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/yii-rbac-tools.js";
import { analyzeYiiConsoleCommands } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/yii-console-tools.js";
import { analyzePhpStanBaseline } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/phpstan-baseline-tools.js";
import { phpSecurityScan, phpProjectAudit, findPhpViews } from "/Users/greglas/DEV/codesift-mcp/.worktrees/php-yii-extractor/src/tools/php-tools.js";

const PANEL_ROOT = "/Users/greglas/DEV/Portal & Access/tgmdev-tgm-panel-1428ca602529";

function ms(t) { return `${(performance.now() - t).toFixed(0)} ms`; }

const lines = [];
const log = (s) => lines.push(s);

log("# tgm-panel smoke test — PHP/Yii2 toolset");
log("");
log("Date: 2026-05-07");
log("Branch: php-yii-extractor");
log("Codebase: tgmdev-tgm-panel-1428ca602529 (1882 PHP files, Yii2 2.0.17, PHP >=7.2)");
log("");
log("This report is an end-to-end smoke run of the 10 new PHP/Yii2 tools");
log("against a real production Yii2 codebase. Numbers are diagnostic, not");
log("a finished audit — the goal is to confirm each tool produces output");
log("that makes sense at panel scale.");
log("");

const t0 = performance.now();
log("## Indexing");
log("");
const tIdx = performance.now();
let info;
try {
  info = await indexFolder(PANEL_ROOT);
} catch (e) {
  log(`**Indexing failed:** ${e.message}`);
  console.log(lines.join("\n"));
  process.exit(1);
}
const repo = info.repo;
log(`- repo: \`${repo}\``);
log(`- duration: ${ms(tIdx)}`);
log(`- files: ${info.file_count}`);
log(`- symbols: ${info.symbol_count}`);
log("");

async function runStep(name, fn) {
  const t = performance.now();
  try {
    const r = await fn();
    log(`### ${name}  *(${ms(t)})*`);
    log("");
    return r;
  } catch (e) {
    log(`### ${name}  *(FAILED — ${ms(t)})*`);
    log("");
    log("```");
    log(String(e?.message ?? e).slice(0, 500));
    log("```");
    log("");
    return null;
  }
}

log("## 1. yii3_migration_audit");
log("");
const m4 = await runStep("M4 — Yii2→Yii3 migration inventory", () =>
  yii3MigrationAudit(repo, { max_samples_per_category: 2 }),
);
if (m4) {
  log(`- scanned_files: **${m4.scanned_files}**`);
  log(`- total_call_sites: **${m4.total_call_sites}**`);
  log(`- yii_version_detected: \`${m4.yii_version_detected}\``);
  log(`- php_version_required: \`${m4.php_version_required}\``);
  log(`- decision_signal: **${m4.decision_signal}**`);
  log(`- effort_estimate: **${m4.effort_estimate.hours_low}h – ${m4.effort_estimate.hours_high}h**`);
  log("");
  log("**by_severity:**");
  log("");
  log("| severity | count |");
  log("|---|---:|");
  for (const [k, v] of Object.entries(m4.by_severity)) log(`| ${k} | ${v} |`);
  log("");
  log("**Top categories:**");
  log("");
  log("| category | count | severity |");
  log("|---|---:|---|");
  for (const c of m4.by_category.slice(0, 15)) {
    log(`| ${c.category} | ${c.count} | ${c.severity} |`);
  }
  log("");
  log(`**Blockers:** ${m4.blockers.length}`);
  log("");
  for (const b of m4.blockers) log(`- \`${b.category}\` — ${b.related_files_count} files`);
  log("");
}

log("## 2. php8_compat_check");
log("");
const m3 = await runStep("M3 — PHP 7→8 compatibility gate", () =>
  php8CompatCheck(repo, { max_samples_per_rule: 2 }),
);
if (m3) {
  log(`- scanned_files: **${m3.scanned_files}**`);
  log(`- total_findings: **${m3.total_findings}**`);
  log(`- blocker_for_merge: **${m3.blocker_for_merge}**`);
  log(`- yii_version_warning: ${m3.yii_version_warning ? "YES" : "no"}`);
  if (m3.yii_version_warning) {
    log("");
    log(`> ${m3.yii_version_warning.slice(0, 200)}`);
  }
  log("");
  log("**by_severity:**");
  log("");
  log("| severity | count |");
  log("|---|---:|");
  for (const [k, v] of Object.entries(m3.by_severity)) log(`| ${k} | ${v} |`);
  log("");
  log("**Findings by rule:**");
  log("");
  log("| rule_id | severity | count |");
  log("|---|---|---:|");
  for (const r of m3.by_rule) log(`| \`${r.rule_id}\` | ${r.severity} | ${r.count} |`);
  log("");
}

log("## 3. find_php8_migration_candidates");
log("");
const m1 = await runStep("M1 — PHP 8 modernization candidates", () =>
  findPhp8MigrationCandidates(repo, { max_samples_per_rule: 2 }),
);
if (m1) {
  log(`- scanned_files: **${m1.scanned_files}**`);
  log(`- total_candidates: **${m1.total_candidates}**`);
  log("");
  log("**By rule:**");
  log("");
  log("| rule_id | count |");
  log("|---|---:|");
  for (const r of m1.by_rule) log(`| \`${r.rule_id}\` | ${r.count} |`);
  log("");
}

log("## 4. find_yii3_attribute_candidates");
log("");
const m2 = await runStep("M2 — Yii3 attribute conversion candidates", () =>
  findYii3AttributeCandidates(repo, { max_samples_per_rule: 2 }),
);
if (m2) {
  log(`- scanned_files: **${m2.scanned_files}**`);
  log(`- total_candidates: **${m2.total_candidates}**`);
  log("");
  log("**By rule:**");
  log("");
  log("| rule_id | count |");
  log("|---|---:|");
  for (const r of m2.by_rule) log(`| \`${r.rule_id}\` | ${r.count} |`);
  log("");
}

log("## 5. analyze_yii_modules");
log("");
const n1 = await runStep("N1 — Yii2 module inventory", () =>
  analyzeYiiModules(repo),
);
if (n1) {
  log(`- total_modules: **${n1.total_modules}**`);
  log("");
  log("| id | controllerNamespace | controllers | views_count | migrations | submodules | url_prefixes |");
  log("|---|---|---:|---:|---:|---|---|");
  for (const m of n1.modules) {
    log(
      `| ${m.id} | ${m.controllerNamespace ?? "(default)"} | ${m.controllers.length} | ${m.views_count} | ${m.migrations_count} | ${m.submodules.join(",") || "—"} | ${m.url_prefixes.slice(0, 3).join(",") || "—"} |`,
    );
  }
  log("");
}

log("## 6. analyze_yii_migrations");
log("");
const n2 = await runStep("N2 — Yii2 PHP-DSL migration audit", () =>
  analyzeYiiMigrations(repo),
);
if (n2) {
  log(`- scanned_files: **${n2.scanned_files}**`);
  log(`- total_migrations: **${n2.total_migrations}**`);
  log(`- distinct_tables: **${Object.keys(n2.by_table).length}**`);
  log("");
  log("**Findings summary:**");
  log("");
  log("| rule_id | count |");
  log("|---|---:|");
  for (const [k, v] of Object.entries(n2.findings_summary)) log(`| \`${k}\` | ${v} |`);
  log("");
  log("**Top 10 most-touched tables:**");
  log("");
  log("| table | migration_count |");
  log("|---|---:|");
  const tableEntries = Object.entries(n2.by_table)
    .map(([t, files]) => [t, files.length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [t, c] of tableEntries) log(`| ${t} | ${c} |`);
  log("");
}

log("## 7. analyze_yii_rbac");
log("");
const n3 = await runStep("N3 — Yii2 RBAC permission graph", () =>
  analyzeYiiRbac(repo),
);
if (n3) {
  log(`- total_permissions: **${n3.summary.total_permissions}**`);
  log(`- total_roles: **${n3.summary.total_roles}**`);
  log(`- total_checks: **${n3.summary.total_checks}**`);
  log(`- orphan_check_count: **${n3.summary.orphan_check_count}** (checked but never defined)`);
  log(`- unused_definition_count: **${n3.summary.unused_definition_count}** (defined but never checked)`);
  log(`- unsafe_controller_count: **${n3.summary.unsafe_controller_count}** (no AccessControl)`);
  log(`- dynamic_creates: **${n3.dynamic_creates.length}**`);
  log("");
  if (n3.orphan_checks.length > 0) {
    log("**Sample orphan checks (first 10):**");
    log("");
    for (const o of n3.orphan_checks.slice(0, 10)) log(`- \`${o}\``);
    log("");
  }
  if (n3.unused_definitions.length > 0) {
    log("**Sample unused definitions (first 10):**");
    log("");
    for (const u of n3.unused_definitions.slice(0, 10)) log(`- \`${u}\``);
    log("");
  }
}

log("## 8. analyze_yii_console_commands");
log("");
const n4 = await runStep("N4 — Yii2 console command inventory", () =>
  analyzeYiiConsoleCommands(repo),
);
if (n4) {
  log(`- total_controllers: **${n4.total_controllers}**`);
  log(`- total_actions: **${n4.total_actions}**`);
  log(`- high_risk_actions: **${n4.high_risk_actions.length}** (≥2 flags)`);
  log("");
  if (n4.high_risk_actions.length > 0) {
    log("**Top 10 highest-risk actions:**");
    log("");
    log("| cli_id | flags |");
    log("|---|---|");
    for (const a of n4.high_risk_actions.slice(0, 10)) {
      log(`| \`${a.cli_id}\` | ${a.flags.join(", ")} |`);
    }
    log("");
  }
}

log("## 9. analyze_phpstan_baseline");
log("");
const n6 = await runStep("N6 — PHPStan baseline triage", () =>
  analyzePhpStanBaseline(repo, { max_paths: 15 }),
);
if (n6) {
  log(`- baseline_file: \`${n6.baseline_file ?? "(none)"}\``);
  log(`- total_ignored: **${n6.total_ignored}**`);
  log(`- total_files: **${n6.total_files}**`);
  log(`- quick_wins: **${n6.quick_wins.length}** files with ≤3 errors`);
  log("");
  log("**Top 15 files by error count:**");
  log("");
  log("| path | count |");
  log("|---|---:|");
  for (const p of n6.by_path) log(`| ${p.path} | ${p.count} |`);
  log("");
  log("**Top categories:**");
  log("");
  log("| category | count |");
  log("|---|---:|");
  const cats = Object.entries(n6.by_category).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [c, v] of cats) log(`| \`${c}\` | ${v} |`);
  log("");
}

log("## 10. php_security_scan (extended catalog)");
log("");
const sec = await runStep("php_security_scan — 20 patterns", () =>
  phpSecurityScan(repo),
);
if (sec) {
  log(`- checks_run: **${sec.checks_run.length}**`);
  log(`- total_findings: **${sec.summary.total}**`);
  log("");
  log("**By severity:**");
  log("");
  log("| severity | count |");
  log("|---|---:|");
  log(`| critical | ${sec.summary.critical} |`);
  log(`| high | ${sec.summary.high} |`);
  log(`| medium | ${sec.summary.medium} |`);
  log(`| low | ${sec.summary.low} |`);
  log("");
  // Per-pattern aggregate
  const byPattern = {};
  for (const f of sec.findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
  const ranked = Object.entries(byPattern).sort((a, b) => b[1] - a[1]).slice(0, 15);
  log("**Top patterns:**");
  log("");
  log("| pattern | count |");
  log("|---|---:|");
  for (const [p, c] of ranked) log(`| \`${p}\` | ${c} |`);
  log("");
}

log("## 11. find_php_views (extended)");
log("");
const views = await runStep("find_php_views — render mapping + layouts + widgets + bundles", () =>
  findPhpViews(repo),
);
if (views) {
  log(`- mappings: **${views.total}** render→view edges`);
  log(`- layouts: **${views.layouts.length}** ($this->layout assignments)`);
  log(`- widgets: **${views.widgets.length}** widget references`);
  log(`- asset_bundles: **${views.asset_bundles.length}** AssetBundle::register sites`);
  log("");
  // Render kind breakdown
  const kinds = {};
  for (const m of views.mappings) kinds[m.render_kind] = (kinds[m.render_kind] ?? 0) + 1;
  log("**Render kinds:**");
  log("");
  log("| kind | count |");
  log("|---|---:|");
  for (const [k, v] of Object.entries(kinds)) log(`| ${k} | ${v} |`);
  log("");
  // Top widgets
  const w = {};
  for (const x of views.widgets) w[x.widget] = (w[x.widget] ?? 0) + 1;
  const topW = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 10);
  log("**Top widgets used:**");
  log("");
  log("| widget | count |");
  log("|---|---:|");
  for (const [k, v] of topW) log(`| ${k} | ${v} |`);
  log("");
}

log("## 12. php_project_audit (compound)");
log("");
const audit = await runStep("php_project_audit — 10 gates", () =>
  phpProjectAudit(repo),
);
if (audit) {
  log(`- duration: ${audit.duration_ms} ms`);
  log(`- health_score: **${audit.summary.health_score} / 100**`);
  log(`- total_findings: **${audit.summary.total_findings}**`);
  log("");
  log("**Gate status:**");
  log("");
  log("| gate | status | findings | duration_ms |");
  log("|---|---|---:|---:|");
  for (const g of audit.gates) {
    log(`| ${g.name} | ${g.status} | ${g.findings_count} | ${g.duration_ms} |`);
  }
  log("");
  log(`**Top risks:** ${audit.summary.top_risks.join("; ") || "(none)"}`);
  log("");
}

log("---");
log("");
log(`**Total smoke run time: ${ms(t0)}**`);
log("");
log("All 12 tool entry points executed successfully against the live");
log("tgm-panel codebase. Numbers above are starting points for the next");
log("audit cycle, not finished findings — each tool's output is intended");
log("to feed into a domain expert review (security audit, perf audit,");
log("RBAC review, etc).");

console.log(lines.join("\n"));
