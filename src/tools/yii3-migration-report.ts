import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORIES, EFFORT_HOURS } from "./yii3-migration-categories.js";
import type { MigrationScanResult } from "./yii3-migration-scanner.js";
import type { CategoryFinding, Severity, Yii3MigrationAudit } from "./yii3-migration-types.js";

export async function buildYii3MigrationReport(
  repo: string,
  root: string,
  scan: MigrationScanResult,
): Promise<Yii3MigrationAudit> {
  const byCategory = rollupCategories(scan);
  const totals = summarize(byCategory);
  const blockers = buildBlockers(byCategory, scan);
  const composer = await readComposerMeta(root);
  return {
    repo,
    scanned_files: scan.scannedFiles,
    total_call_sites: totals.totalCalls,
    by_category: byCategory,
    by_severity: totals.bySeverity,
    blockers,
    effort_estimate: {
      hours_low: Math.round(totals.hoursLow),
      hours_high: Math.round(totals.hoursHigh),
      note: "Per-call estimates from CategoryDefinition.effort_per_call. Real migrations take 2-4× longer due to integration tests, edge cases, and team learning curve. Treat the high bound as a floor.",
    },
    decision_signal: chooseDecision(blockers.length, totals.totalCalls),
    yii_version_detected: composer.yiiVersion,
    php_version_required: composer.phpRequirement,
  };
}

function rollupCategories(scan: MigrationScanResult): CategoryFinding[] {
  const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return CATEGORIES.map((category) => {
    const bucket = scan.buckets.get(category.category)!;
    return {
      category: category.category,
      severity: category.severity,
      count: bucket.count,
      effort_per_call: category.effort_per_call,
      description: category.description,
      yii3_replacement: category.yii3_replacement,
      sample_files: bucket.samples,
    };
  }).filter(({ count }) => count > 0).sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity] || b.count - a.count,
  );
}

function summarize(findings: CategoryFinding[]) {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalCalls = 0;
  let hoursLow = 0;
  let hoursHigh = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += finding.count;
    totalCalls += finding.count;
    const [low, high] = EFFORT_HOURS[finding.effort_per_call];
    hoursLow += finding.count * low;
    hoursHigh += finding.count * high;
  }
  return { bySeverity, totalCalls, hoursLow, hoursHigh };
}

function buildBlockers(
  findings: CategoryFinding[],
  scan: MigrationScanResult,
): Yii3MigrationAudit["blockers"] {
  return findings.filter(({ severity, count }) => severity === "critical" && count >= 10)
    .map((finding) => {
      const relatedFiles = scan.buckets.get(finding.category)!.files.size;
      return {
        category: finding.category,
        reason: `${finding.count} call sites in ${relatedFiles} files — ${finding.description}`,
        related_files_count: relatedFiles,
      };
    });
}

function chooseDecision(
  blockerCount: number,
  totalCalls: number,
): Yii3MigrationAudit["decision_signal"] {
  if (blockerCount === 0 && totalCalls < 500) return "consider-yii3";
  if (blockerCount === 0 && totalCalls < 2000) return "consider-yii3";
  if (blockerCount <= 2 && totalCalls < 5000) return "high-effort-yii3";
  if (blockerCount >= 3 || totalCalls >= 5000) return "blocked";
  return "stay-on-yii2";
}

async function readComposerMeta(root: string) {
  try {
    const parsed = JSON.parse(await readFile(join(root, "composer.json"), "utf-8"));
    const requires = parsed.require ?? {};
    return { yiiVersion: requires["yiisoft/yii2"] ?? null, phpRequirement: requires.php ?? null };
  } catch {
    return { yiiVersion: null, phpRequirement: null };
  }
}
