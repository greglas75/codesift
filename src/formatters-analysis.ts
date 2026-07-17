/** Review, performance, coupling, and architecture text formatters. */
import type { ReviewDiffResult, ReviewFinding } from "./tools/review-diff-tools.js";
import type { PerfHotspotsResult, PerfFinding } from "./tools/perf-tools.js";
import type { FanInFanOutResult, CoChangeResult } from "./tools/coupling-tools.js";
import type { ArchitectureSummaryResult } from "./tools/architecture-tools.js";

// ── Review diff ───────────────────────────────────

const MAX_T3_FINDINGS = 10;
const STATUS_ICON: Record<string, string> = { pass: "✓", fail: "✗", warn: "~", error: "!", timeout: "?" };

export function formatReviewDiff(data: unknown): string {
  const r = data as ReviewDiffResult;
  const parts: string[] = [];
  parts.push(`review_diff: ${r.verdict} (score=${r.score}) | ${r.diff_stats?.files_reviewed ?? 0} files | ${r.duration_ms}ms`);

  if (r.checks && r.checks.length > 0) {
    parts.push("─── checks ───");
    for (const c of r.checks) {
      const icon = STATUS_ICON[c.status] ?? "?";
      const summary = c.summary ? ` (${c.summary})` : "";
      parts.push(`  ${icon} ${c.check}: ${c.status}${summary}`);
    }
  }

  if (r.error) {
    parts.push(`error: ${r.error}`);
    return parts.join("\n");
  }

  const t1 = (r.findings ?? []).filter((f: ReviewFinding) => f.check === "secrets" || f.check === "breaking");
  const t2 = (r.findings ?? []).filter((f: ReviewFinding) => ["coupling", "complexity", "dead-code", "blast-radius", "bug-patterns"].includes(f.check));
  const t3 = (r.findings ?? []).filter((f: ReviewFinding) => !t1.includes(f) && !t2.includes(f));

  if (t1.length > 0) {
    parts.push("─── T1 findings (blocking) ───");
    for (const f of t1) {
      const loc = f.file ? `[${f.file}${f.line ? `:${f.line}` : ""}]` : "";
      parts.push(`  ${loc} ${f.message}`);
    }
  }
  if (t2.length > 0) {
    parts.push("─── T2 findings (important) ───");
    for (const f of t2) {
      const loc = f.file ? `[${f.file}${f.line ? `:${f.line}` : ""}]` : "";
      parts.push(`  ${loc} ${f.message}`);
    }
  }
  if (t3.length > 0) {
    parts.push("─── T3 findings (info) ───");
    const shown = t3.slice(0, MAX_T3_FINDINGS);
    for (const f of shown) {
      const loc = f.file ? `[${f.file}${f.line ? `:${f.line}` : ""}]` : "";
      parts.push(`  ${loc} ${f.message}`);
    }
    if (t3.length > MAX_T3_FINDINGS) parts.push(`  (showing ${MAX_T3_FINDINGS} of ${t3.length})`);
  }

  return parts.join("\n");
}
// ── Perf hotspots ──────────────────────────────

export function formatPerfHotspots(data: PerfHotspotsResult): string {
  const parts: string[] = [];
  const { findings, patterns_checked, symbols_scanned, summary } = data;
  parts.push(`perf_hotspots: ${findings.length} findings (${summary.high} high, ${summary.medium} medium, ${summary.low} low) | ${symbols_scanned} symbols scanned | ${patterns_checked} patterns`);

  if (findings.length === 0) return parts.join("\n");

  const grouped: Record<string, PerfFinding[]> = {};
  for (const f of findings) {
    const sev = f.severity.toUpperCase();
    if (!grouped[sev]) grouped[sev] = [];
    grouped[sev]!.push(f);
  }

  for (const sev of ["HIGH", "MEDIUM", "LOW"]) {
    const items = grouped[sev];
    if (!items || items.length === 0) continue;
    parts.push(`─── ${sev} ───`);
    for (const f of items) {
      parts.push(`  ${f.file}:${f.line} ${f.name} — ${f.pattern}`);
      parts.push(`    ${f.context}`);
      parts.push(`    → ${f.fix_hint}`);
    }
  }

  return parts.join("\n");
}

// ── Fan-in / Fan-out ──────────────────────────────

export function formatFanInFanOut(data: FanInFanOutResult): string {
  const parts: string[] = [];
  parts.push(`fan_in_fan_out: ${data.total_files} files, ${data.total_edges} edges, coupling_score=${data.coupling_score}`);

  if (data.fan_in_top.length > 0) {
    parts.push("─── TOP FAN-IN (most imported) ───");
    for (const m of data.fan_in_top.slice(0, 15)) {
      parts.push(`  ${m.file}  in=${m.count}`);
    }
  }

  if (data.fan_out_top.length > 0) {
    parts.push("─── TOP FAN-OUT (most dependencies) ───");
    for (const m of data.fan_out_top.slice(0, 15)) {
      parts.push(`  ${m.file}  out=${m.count}`);
    }
  }

  if (data.hub_files.length > 0) {
    parts.push("─── HUB FILES (high both — instability risk) ───");
    for (const m of data.hub_files.slice(0, 10)) {
      parts.push(`  ${m.file}  ${m.connections.join(", ")}`);
    }
  }

  return parts.join("\n");
}

// ── Co-change analysis ──────────────────────────────

export function formatCoChange(data: CoChangeResult): string {
  const parts: string[] = [];
  parts.push(`co_change: ${data.pairs.length} coupled pairs | ${data.total_commits_analyzed} commits | ${data.period}`);

  if (data.pairs.length > 0) {
    parts.push("─── TOP COUPLED PAIRS ───");
    for (const p of data.pairs.slice(0, 20)) {
      parts.push(`  ${p.file_a} ↔ ${p.file_b}  jaccard=${p.jaccard.toFixed(2)} co=${p.co_commits}`);
    }
  }

  if (data.clusters.length > 0) {
    parts.push(`─── CLUSTERS (${data.clusters.length}) ───`);
    for (const cluster of data.clusters.slice(0, 10)) {
      parts.push(`  [${cluster.length} files] ${cluster.slice(0, 5).join(", ")}${cluster.length > 5 ? ` +${cluster.length - 5} more` : ""}`);
    }
  }

  return parts.join("\n");
}

// ── Architecture summary ──────────────────────────────

export function formatArchitectureSummary(data: ArchitectureSummaryResult): string {
  if (data.mermaid) return data.mermaid;

  const parts: string[] = [];
  parts.push(`architecture_summary (${data.duration_ms}ms)`);

  if (data.stack) {
    parts.push("─── Stack ───");
    const s = data.stack as Record<string, unknown>;
    if (s.summary && typeof s.summary === "string") {
      parts.push(`  ${s.summary}`);
    } else {
      parts.push(`  ${JSON.stringify(s).slice(0, 200)}`);
    }
  }

  if (data.communities.length > 0) {
    parts.push(`─── Communities (${data.communities.length}) ───`);
    for (const c of data.communities.slice(0, 10)) {
      parts.push(`  ${c.name} (${c.files.length} files, ${c.symbol_count} symbols, cohesion=${c.cohesion.toFixed(2)})`);
    }
  }

  if (data.coupling_hotspots.length > 0) {
    parts.push(`─── Coupling Hotspots (${data.coupling_hotspots.length}) ───`);
    for (const h of data.coupling_hotspots.slice(0, 10)) {
      parts.push(`  ${h.file}  ${h.connections.join(", ")}`);
    }
  }

  if (data.circular_deps.length > 0) {
    parts.push(`─── Circular Dependencies (${data.circular_deps.length}) ───`);
    for (const cycle of data.circular_deps.slice(0, 5)) {
      parts.push(`  ${cycle.join(" → ")} → ${cycle[0]}`);
    }
  }

  if (data.loc_distribution.length > 0) {
    parts.push("─── LOC Distribution ───");
    for (const d of data.loc_distribution.slice(0, 15)) {
      parts.push(`  ${d.dir}  ${d.file_count} files, ${d.symbol_count} symbols`);
    }
  }

  if (data.entry_points.length > 0) {
    parts.push(`─── Entry Points (${data.entry_points.length}) ───`);
    for (const ep of data.entry_points.slice(0, 10)) {
      parts.push(`  ${ep}`);
    }
  }

  return parts.join("\n");
}
