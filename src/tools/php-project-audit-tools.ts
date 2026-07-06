/**
 * PHP/Yii2-specific code intelligence tools.
 *
 * Implementation module extracted from the legacy php-tools facade.
 */
import { searchPatterns } from "./pattern-tools.js";
import { analyzeActiveRecord, type ActiveRecordAnalysis } from "./php-active-record-tools.js";
import { findPhpGodModel } from "./php-god-model-tools.js";
import { findPhpNPlusOne } from "./php-nplus1-tools.js";
import { phpSecurityScan, type PhpSecurityFinding, type PhpSecurityScanResult } from "./php-security-tools.js";

// 7g. php_project_audit — Compound meta-tool
// ---------------------------------------------------------------------------

export interface AuditGate {
  name: string;
  status: "ok" | "error" | "timeout";
  findings_count: number;
  duration_ms: number;
  error?: string;
}

export interface PhpProjectAudit {
  repo: string;
  duration_ms: number;
  checks_run: string[];
  gates: AuditGate[];
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    health_score: number;
    top_risks: string[];
  };
  security: PhpSecurityScanResult;
  activerecord: ActiveRecordAnalysis;
}

const AUDIT_TIMEOUT = 8000;

export async function phpProjectAudit(
  repo: string,
  options?: { file_pattern?: string; checks?: string[] },
): Promise<PhpProjectAudit> {
  const startTime = Date.now();
  const gates: AuditGate[] = [];
  const allChecks = ["security", "activerecord", "complexity", "dead_code", "patterns", "clones", "hotspots", "n_plus_one", "god_model", "yii_performance"];
  const enabled = new Set(options?.checks ?? allChecks);
  const fp = options?.file_pattern ?? ".php";
  const secOpts: { file_pattern?: string } = {};
  if (options?.file_pattern) secOpts.file_pattern = options.file_pattern;

  type Task = { name: string; run: () => Promise<unknown> };
  const tasks: Task[] = [];

  if (enabled.has("security")) tasks.push({ name: "security", run: () => phpSecurityScan(repo, secOpts) });
  if (enabled.has("activerecord")) tasks.push({ name: "activerecord", run: () => analyzeActiveRecord(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined) });
  if (enabled.has("complexity")) tasks.push({ name: "complexity", run: async () => { const { analyzeComplexity } = await import("./complexity-tools.js"); return analyzeComplexity(repo, { file_pattern: fp, top_n: 10 }); } });
  if (enabled.has("dead_code")) tasks.push({ name: "dead_code", run: async () => { const { findDeadCode } = await import("./symbol-tools.js"); return findDeadCode(repo, { file_pattern: fp }); } });
  if (enabled.has("patterns")) tasks.push({ name: "patterns", run: () => searchPatterns(repo, "empty-catch", { file_pattern: fp }) });
  if (enabled.has("clones")) tasks.push({ name: "clones", run: async () => { const { findClones } = await import("./clone-tools.js"); return findClones(repo, { file_pattern: fp }); } });
  if (enabled.has("hotspots")) tasks.push({ name: "hotspots", run: async () => { const { analyzeHotspots } = await import("./hotspot-tools.js"); return analyzeHotspots(repo, {}); } });
  if (enabled.has("n_plus_one")) tasks.push({ name: "n_plus_one", run: () => findPhpNPlusOne(repo, options?.file_pattern ? { file_pattern: options.file_pattern } : undefined) });
  if (enabled.has("god_model")) tasks.push({ name: "god_model", run: () => findPhpGodModel(repo) });
  if (enabled.has("yii_performance")) {
    // Sprint 7: 5 perf patterns sourced from tgm-panel performance-audit
    // findings. Run them through the file-level scanner alongside
    // file-level security patterns so module-level matches (configs,
    // entry-points, view files) are picked up. Each pattern uses its own
    // severity tier consistent with the perf-audit recommendations.
    const PERF_PATTERNS = [
      { pattern: "yii-translate-in-loop", severity: "medium" as const },
      { pattern: "yii-dbtarget-info-level", severity: "medium" as const },
      { pattern: "yii-find-with-large-then-filter", severity: "high" as const },
      { pattern: "yii-cache-no-ttl", severity: "low" as const },
      { pattern: "yii-no-batch-on-large", severity: "high" as const },
    ];
    tasks.push({
      name: "yii_performance",
      run: async () => {
        // We reuse the security scan plumbing (parallel pattern runs +
        // file-level fallback) but with the perf catalog. The result shape
        // matches PhpSecurityScanResult — caller treats it as informational.
        const findings: PhpSecurityFinding[] = [];
        const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
        const symbolResults = await Promise.all(
          PERF_PATTERNS.map((check) =>
            searchPatterns(repo, check.pattern, {
              file_pattern: fp,
              include_tests: false,
            }).then((r) => ({ check, result: r })).catch(() => null),
          ),
        );
        for (const res of symbolResults) {
          if (!res) continue;
          for (const m of res.result.matches) {
            findings.push({
              severity: res.check.severity,
              pattern: res.check.pattern,
              file: m.file,
              line: m.start_line,
              context: m.context,
              description: "",
            });
            summary[res.check.severity]++;
            summary.total++;
          }
        }
        return {
          findings,
          summary,
          checks_run: PERF_PATTERNS.map((p) => p.pattern),
        } as PhpSecurityScanResult;
      },
    });
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const s = Date.now();
      const r = await Promise.race([t.run(), new Promise<"TIMEOUT">((ok) => setTimeout(() => ok("TIMEOUT"), AUDIT_TIMEOUT))]);
      return { name: t.name, result: r, ms: Date.now() - s };
    }),
  );

  let securityResult: PhpSecurityScanResult = { findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, checks_run: [] };
  let arResult: ActiveRecordAnalysis = { models: [], total: 0 };
  let totalFindings = 0;

  for (const s of settled) {
    if (s.status === "rejected") { gates.push({ name: "unknown", status: "error", findings_count: 0, duration_ms: 0, error: String(s.reason) }); continue; }
    const { name, result, ms } = s.value;
    if (result === "TIMEOUT") { gates.push({ name, status: "timeout", findings_count: 0, duration_ms: ms }); continue; }

    let count = 0;
    // activerecord is informational (model count), not a problem finding — excluded from totalFindings and health score
    if (name === "security") { securityResult = result as PhpSecurityScanResult; count = securityResult.summary.total; }
    else if (name === "activerecord") { arResult = result as ActiveRecordAnalysis; count = arResult.total; }
    else if (name === "complexity") count = (result as { summary?: { above_threshold?: number } })?.summary?.above_threshold ?? 0;
    else if (name === "dead_code") count = (result as { candidates?: unknown[] })?.candidates?.length ?? 0;
    else if (name === "patterns") count = (result as { matches?: unknown[] })?.matches?.length ?? 0;
    else if (name === "clones") count = (result as { clones?: unknown[] })?.clones?.length ?? 0;
    else if (name === "hotspots") count = (result as { hotspots?: unknown[] })?.hotspots?.length ?? 0;
    else if (name === "n_plus_one") count = (result as { findings?: unknown[] })?.findings?.length ?? 0;
    else if (name === "god_model") count = (result as { models?: unknown[] })?.models?.length ?? 0;
    else if (name === "yii_performance") count = (result as { findings?: unknown[] })?.findings?.length ?? 0;

    if (name !== "activerecord") totalFindings += count;
    gates.push({ name, status: "ok", findings_count: count, duration_ms: ms });
  }

  const sec = securityResult.summary;
  // Logarithmic penalties — a few critical findings are serious, but hundreds of
  // complexity warnings shouldn't tank the score to 0. Each gate uses log2 scaling
  // so 1 finding ≈ 0, 10 ≈ 17, 100 ≈ 33, 1000 ≈ 50 penalty points.
  const secPenalty = sec.total > 0 ? Math.round(Math.log2(sec.total + 1) * (sec.critical > 0 ? 8 : 4)) : 0;
  const qualityFindings = totalFindings - sec.total;
  const qualPenalty = qualityFindings > 0 ? Math.round(Math.log2(qualityFindings + 1) * 4) : 0;
  const healthScore = Math.max(0, Math.min(100, 100 - secPenalty - qualPenalty));
  const topRisks = gates.filter(g => g.findings_count > 0 && g.name !== "activerecord").sort((a, b) => b.findings_count - a.findings_count).slice(0, 3).map(g => `${g.name}: ${g.findings_count} findings`);

  return {
    repo, duration_ms: Date.now() - startTime,
    checks_run: gates.filter(g => g.status === "ok").map(g => g.name),
    gates,
    summary: { total_findings: totalFindings, critical: sec.critical, high: sec.high, medium: sec.medium, low: sec.low, health_score: healthScore, top_risks: topRisks },
    security: securityResult,
    activerecord: arResult,
  };
}

// ---------------------------------------------------------------------------
