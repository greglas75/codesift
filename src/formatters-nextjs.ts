/** Next.js-specific report formatters. */
import type { NextjsComponentsResult } from "./tools/nextjs-component-tools.js";
import type { NextjsRouteMapResult } from "./tools/nextjs-route-tools.js";
import type { NextjsMetadataAuditResult } from "./tools/nextjs-metadata-tools.js";
import type { ServerActionsAuditResult } from "./tools/nextjs-security-tools.js";
import type { ApiContractResult } from "./tools/nextjs-api-contract-tools.js";
import type { NextjsBoundaryResult } from "./tools/nextjs-boundary-tools.js";
import type { LinkIntegrityResult } from "./tools/nextjs-link-tools.js";
import type { NextjsDataFlowResult } from "./tools/nextjs-data-flow-tools.js";
import type { NextjsMiddlewareCoverageResult } from "./tools/nextjs-middleware-coverage-tools.js";
import type { FrameworkAuditResult, PrioritizedAudit } from "./tools/nextjs-framework-audit-tools.js";

// ---------------------------------------------------------------------------
// Next.js component classifier formatter
// ---------------------------------------------------------------------------


export function formatNextjsComponents(result: NextjsComponentsResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS COMPONENT ANALYSIS");
  lines.push("");
  lines.push(`Total: ${result.counts.total} components`);
  lines.push(`  Server: ${result.counts.server}`);
  lines.push(`  Client (explicit): ${result.counts.client_explicit}`);
  lines.push(`  Client (inferred): ${result.counts.client_inferred}`);
  lines.push(`  Ambiguous: ${result.counts.ambiguous}`);
  lines.push(`  Unnecessary "use client": ${result.counts.unnecessary_use_client}`);

  if (result.truncated) {
    const at = result.truncated_at != null ? ` (at ${result.truncated_at})` : "";
    lines.push(`  [truncated${at}]`);
  }
  lines.push("");

  // Top violations (cap at 15 for compactness)
  const withViolations = result.files.filter((f) => f.violations.length > 0);
  if (withViolations.length > 0) {
    lines.push(`─── Violations (${withViolations.length}) ───`);
    for (const f of withViolations.slice(0, 15)) {
      lines.push(`  ${f.path} — ${f.violations.join(", ")}`);
    }
    if (withViolations.length > 15) {
      lines.push(`  ... +${withViolations.length - 15} more`);
    }
    lines.push("");
  }

  if (result.parse_failures.length > 0) {
    lines.push(`─── Parse Failures (${result.parse_failures.length}) ───`);
    for (const pf of result.parse_failures.slice(0, 5)) {
      lines.push(`  ${pf}`);
    }
    if (result.parse_failures.length > 5) {
      lines.push(`  ... +${result.parse_failures.length - 5} more`);
    }
    lines.push("");
  }

  if (result.scan_errors.length > 0) {
    lines.push(`─── Scan Errors (${result.scan_errors.length}) ───`);
    for (const err of result.scan_errors.slice(0, 5)) {
      lines.push(`  ${err}`);
    }
    lines.push("");
  }

  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }

  return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Next.js route map formatter
// ---------------------------------------------------------------------------


export function formatNextjsRouteMap(result: NextjsRouteMapResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS ROUTE MAP");
  lines.push("");
  lines.push(`Routes: ${result.routes.length} | Conflicts: ${result.conflicts.length}`);
  if (result.middleware) {
    const matchers = result.middleware.matchers.length > 0
      ? result.middleware.matchers.join(", ")
      : "(all routes)";
    lines.push(`Middleware: ${result.middleware.file} — ${matchers}`);
  }
  if (result.truncated) {
    const at = result.truncated_at != null ? ` (at ${result.truncated_at})` : "";
    lines.push(`[truncated${at}]`);
  }
  lines.push("");

  // Header row
  lines.push("URL                              Type      Rendering  Router  Metadata");
  lines.push("──────────────────────────────── ───────── ────────── ─────── ────────");
  for (const r of result.routes.slice(0, 100)) {
    const url = r.url_path.padEnd(32).slice(0, 32);
    const type = r.type.padEnd(9).slice(0, 9);
    const rendering = r.rendering.padEnd(10).slice(0, 10);
    const router = r.router.padEnd(7).slice(0, 7);
    const metadata = r.has_metadata ? "yes" : "no";
    lines.push(`${url} ${type} ${rendering} ${router} ${metadata}`);
  }
  if (result.routes.length > 100) {
    lines.push(`... +${result.routes.length - 100} more`);
  }
  lines.push("");

  if (result.conflicts.length > 0) {
    lines.push(`─── Hybrid Conflicts (${result.conflicts.length}) ───`);
    for (const c of result.conflicts.slice(0, 20)) {
      lines.push(`  ${c.url_path}`);
      lines.push(`    app:   ${c.app}`);
      lines.push(`    pages: ${c.pages}`);
    }
    lines.push("");
  }

  if (result.scan_errors.length > 0) {
    lines.push(`─── Scan Errors (${result.scan_errors.length}) ───`);
    for (const err of result.scan_errors.slice(0, 5)) {
      lines.push(`  ${err}`);
    }
    lines.push("");
  }

  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }

  return lines.join("\n");
}

export function formatNextjsMetadataAudit(result: NextjsMetadataAuditResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS METADATA AUDIT");
  lines.push("");
  lines.push(
    `Pages: ${result.total_pages} | excellent=${result.counts.excellent} good=${result.counts.good} needs_work=${result.counts.needs_work} poor=${result.counts.poor}`,
  );
  lines.push("");

  // Header
  lines.push("URL                              Score Grade        Missing Fields");
  lines.push("──────────────────────────────── ───── ──────────── ────────────────");
  for (const s of result.scores.slice(0, 100)) {
    const url = s.url_path.padEnd(32).slice(0, 32);
    const score = String(s.score).padStart(5);
    const grade = s.grade.padEnd(12).slice(0, 12);
    const missing = s.missing_fields.join(",").slice(0, 60);
    lines.push(`${url} ${score} ${grade} ${missing}`);
  }
  if (result.scores.length > 100) {
    lines.push(`... +${result.scores.length - 100} more`);
  }
  lines.push("");

  if (result.top_issues.length > 0) {
    lines.push(`─── Top Issues (${result.top_issues.length}) ───`);
    for (const issue of result.top_issues) {
      lines.push(`  ${issue}`);
    }
    lines.push("");
  }

  if (result.parse_failures.length > 0) {
    lines.push(`Parse failures: ${result.parse_failures.length}`);
  }
  if (result.scan_errors.length > 0) {
    lines.push(`Scan errors: ${result.scan_errors.length}`);
  }
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }

  return lines.join("\n");
}

export function formatNextjsAuditServerActions(result: ServerActionsAuditResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS SERVER ACTIONS SECURITY AUDIT");
  lines.push("");
  lines.push(
    `Actions: ${result.total} | excellent=${result.counts.excellent} good=${result.counts.good} needs_work=${result.counts.needs_work} poor=${result.counts.poor}`,
  );
  lines.push("");

  // Header
  lines.push("Action                          Score Grade        Auth     Validation Rate     Errors");
  lines.push("─────────────────────────────── ───── ──────────── ──────── ────────── ──────── ───────");
  for (const a of result.actions.slice(0, 100)) {
    const name = `${a.name}@${a.file.split("/").pop() ?? a.file}`.padEnd(31).slice(0, 31);
    const score = String(a.score).padStart(5);
    const grade = a.grade.padEnd(12).slice(0, 12);
    const auth = a.auth.confidence.padEnd(8).slice(0, 8);
    const validation = a.input_validation.lib.padEnd(10).slice(0, 10);
    const rate = a.rate_limiting.lib.padEnd(8).slice(0, 8);
    const errors = a.error_handling.has_try_catch ? "yes" : "no";
    lines.push(`${name} ${score} ${grade} ${auth} ${validation} ${rate} ${errors}`);
  }
  if (result.actions.length > 100) {
    lines.push(`... +${result.actions.length - 100} more`);
  }
  lines.push("");

  if (result.violations.length > 0) {
    lines.push(`Violations: ${result.violations.join(", ")}`);
  }
  if (result.parse_failures.length > 0) {
    lines.push(`Parse failures: ${result.parse_failures.length}`);
  }
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }

  return lines.join("\n");
}

export function formatNextjsApiContract(result: ApiContractResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS API CONTRACT");
  lines.push("");
  lines.push(`Handlers: ${result.total} | Completeness: ${result.completeness_score}%`);
  lines.push("");
  lines.push("| Method | Path | Body | Response | Status |");
  lines.push("| ------ | ---- | ---- | -------- | ------ |");
  for (const h of result.handlers.slice(0, 100)) {
    const body = h.request_schema
      ? h.request_schema.resolved
        ? "zod"
        : h.request_schema.type ?? "ref"
      : "—";
    const response = h.response_shapes.length > 0
      ? h.response_shapes.map((r) => r.type).join(",")
      : "—";
    const status = h.inferred_status_codes.length > 0
      ? h.inferred_status_codes.join(",")
      : "—";
    lines.push(`| ${h.method} | ${h.path} | ${body} | ${response} | ${status} |`);
  }
  if (result.handlers.length > 100) {
    lines.push(`... +${result.handlers.length - 100} more`);
  }
  lines.push("");
  if (result.parse_failures.length > 0) {
    lines.push(`Parse failures: ${result.parse_failures.length}`);
  }
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatNextjsBoundaryAnalyzer(result: NextjsBoundaryResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS CLIENT BOUNDARY ANALYZER");
  lines.push("");
  lines.push(`Client components: ${result.client_count} | Total LOC: ${result.total_client_loc}`);
  lines.push("");
  lines.push("Rank Path                                       LOC Imports Score");
  lines.push("──── ─────────────────────────────────────────── ─── ─────── ─────");
  for (const e of result.entries) {
    const rank = String(e.rank).padStart(4);
    const path = e.path.padEnd(43).slice(0, 43);
    const loc = String(e.signals.loc).padStart(3);
    const imports = String(e.signals.import_count).padStart(7);
    const score = String(e.score).padStart(5);
    lines.push(`${rank} ${path} ${loc} ${imports} ${score}`);
  }
  lines.push("");
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatNextjsDataFlow(result: NextjsDataFlowResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS DATA FLOW");
  lines.push("");
  lines.push(`Pages: ${result.total_pages} | Waterfalls: ${result.total_waterfalls}`);
  if (Object.keys(result.cache_summary).length > 0) {
    const cacheParts = Object.entries(result.cache_summary).map(([k, v]) => `${k}=${v}`);
    lines.push(`Cache: ${cacheParts.join(" ")}`);
  }
  lines.push("");
  lines.push("URL Path                            Fetches Waterfall");
  lines.push("─────────────────────────────────── ─────── ─────────");
  for (const e of result.entries.slice(0, 100)) {
    const url = e.url_path.padEnd(35).slice(0, 35);
    const fetches = String(e.fetches.length).padStart(7);
    const wf = String(e.waterfall_count).padStart(9);
    lines.push(`${url} ${fetches} ${wf}`);
  }
  lines.push("");
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatNextjsMiddlewareCoverage(result: NextjsMiddlewareCoverageResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS MIDDLEWARE COVERAGE");
  lines.push("");
  lines.push(
    `Routes: ${result.total} | protected=${result.coverage.protected.length} unprotected=${result.coverage.unprotected.length} | warnings=${result.warnings.length}`,
  );
  lines.push("");
  lines.push("URL                              Protected Severity");
  lines.push("──────────────────────────────── ───────── ────────");
  for (const url of result.coverage.protected.slice(0, 50)) {
    const u = url.padEnd(32).slice(0, 32);
    lines.push(`${u} yes       —`);
  }
  for (const url of result.coverage.unprotected.slice(0, 50)) {
    const u = url.padEnd(32).slice(0, 32);
    const warning = result.warnings.find((w) => w.route === url);
    const sev = warning ? warning.severity : "—";
    lines.push(`${u} no        ${sev}`);
  }
  lines.push("");
  if (result.warnings.length > 0) {
    lines.push(`Warnings:`);
    for (const w of result.warnings.slice(0, 20)) {
      lines.push(`  [${w.severity}] ${w.route} — ${w.reason}`);
    }
  }
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatFrameworkAudit(result: FrameworkAuditResult | PrioritizedAudit): string {
  // Priority mode: unified top-N findings list
  if ("mode" in result && result.mode === "priority") {
    const lines: string[] = [];
    lines.push("NEXT.JS FRAMEWORK AUDIT — PRIORITY MODE");
    lines.push("");
    lines.push(
      `Top ${result.findings.length} findings of ${result.total_findings} total | ${result.tools_run.length} tools | ${result.duration_ms}ms`,
    );
    lines.push("");
    lines.push("Sev    Tool               File                                          Issue");
    lines.push("────── ────────────────── ─────────────────────────────────────────── ──────────────────────");
    for (const f of result.findings) {
      const sev = f.severity.padEnd(6);
      const tool = f.tool.padEnd(18).slice(0, 18);
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const file = loc.padEnd(43).slice(0, 43);
      const issue = f.issue.slice(0, 60);
      lines.push(`${sev} ${tool} ${file} ${issue}`);
      if (f.suggested_fix) {
        lines.push(`        → ${f.suggested_fix.slice(0, 90)}`);
      }
    }
    return lines.join("\n");
  }

  // Full mode (default) — after priority mode returns, result is FrameworkAuditResult
  const fullResult = result as FrameworkAuditResult;
  const lines: string[] = [];
  lines.push("NEXT.JS FRAMEWORK AUDIT");
  lines.push("");
  lines.push(
    `Overall: ${fullResult.summary.overall_score}/100 (${fullResult.summary.grade}) | Duration: ${fullResult.duration_ms}ms`,
  );
  lines.push("");

  lines.push("Dimension          Score Weight Contribution");
  lines.push("─────────────────── ───── ────── ────────────");
  for (const [dim, info] of Object.entries(fullResult.summary.dimensions)) {
    if (!info) continue;
    const dimText = dim.padEnd(19).slice(0, 19);
    const score = String(info.score).padStart(5);
    const weight = String(info.weight).padStart(6);
    const contribution = info.contribution.toFixed(1).padStart(12);
    lines.push(`${dimText} ${score} ${weight} ${contribution}`);
  }
  lines.push("");

  if (fullResult.summary.top_issues.length > 0) {
    lines.push(`Top issues:`);
    for (const issue of fullResult.summary.top_issues.slice(0, 10)) {
      lines.push(`  - ${issue}`);
    }
  }
  if (fullResult.tool_errors.length > 0) {
    lines.push(`Tool errors: ${fullResult.tool_errors.length}`);
    for (const e of fullResult.tool_errors.slice(0, 5)) {
      lines.push(`  - ${e.tool}: ${e.error}`);
    }
  }
  return lines.join("\n");
}

export function formatNextjsLinkIntegrity(result: LinkIntegrityResult): string {
  const lines: string[] = [];
  lines.push("NEXT.JS LINK INTEGRITY");
  lines.push("");
  lines.push(
    `Refs: ${result.total_refs} | resolved=${result.resolved_count} broken=${result.broken_count} unresolved=${result.unresolved_count}`,
  );
  lines.push("");
  lines.push("Status     Href                                 Location");
  lines.push("────────── ──────────────────────────────────── ───────────────────────");
  for (const b of result.broken.slice(0, 50)) {
    const href = b.href.padEnd(36).slice(0, 36);
    const loc = `${b.file}:${b.line}`;
    lines.push(`broken     ${href} ${loc}`);
  }
  for (const u of result.unresolved.slice(0, 50)) {
    const raw = u.raw.padEnd(36).slice(0, 36);
    const loc = `${u.file}:${u.line}`;
    lines.push(`unresolved ${raw} ${loc}`);
  }
  lines.push("");
  if (result.workspaces_scanned.length > 0) {
    lines.push(`Workspaces scanned: ${result.workspaces_scanned.length}`);
  }
  if (result.limitations.length > 0) {
    lines.push(`Limitations: ${result.limitations.join("; ")}`);
  }
  return lines.join("\n");
}
