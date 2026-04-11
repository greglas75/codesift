/**
 * Compact and counts formatters for progressive response shortening.
 * Used by registerShortener() to reduce large tool responses.
 */
import { formatTable } from "./formatters.js";

// ── Types (mirrors formatters.ts) ──────────────────

interface ComplexityEntry {
  name: string;
  kind: string;
  file: string;
  start_line: number;
  lines: number;
  cyclomatic_complexity: number;
  max_nesting_depth: number;
}

interface ClonePair {
  symbol_a: { name: string; file: string; start_line: number };
  symbol_b: { name: string; file: string; start_line: number };
  similarity: number;
  shared_lines: number;
}

interface HotspotEntry {
  file: string;
  commits: number;
  lines_changed: number;
  symbol_count: number;
  hotspot_score: number;
}

// ── Analyze complexity ─────────────────────────────

const MAX_COMPLEXITY_COMPACT = 25;

export function formatComplexityCompact(raw: unknown): string {
  const data = raw as { functions: ComplexityEntry[]; summary: Record<string, number> };
  if (data.functions.length === 0) return "(no functions found)";
  const capped = data.functions.slice(0, MAX_COMPLEXITY_COMPACT);
  const rows = capped.map((f) => [
    String(f.cyclomatic_complexity),
    String(f.lines),
    `${f.file}:${f.start_line}`,
    f.name,
  ]);
  return formatTable(["CC", "LINES", "FILE:LINE", "NAME"], rows);
}

export function formatComplexityCounts(raw: unknown): string {
  const data = raw as { functions: ComplexityEntry[]; summary: Record<string, number> };
  const s = data.summary;
  return `${s.total_functions} functions, avg_cc=${s.avg_complexity}, max_cc=${s.max_complexity}`;
}

// ── Find clones ────────────────────────────────────

const MAX_CLONES_COMPACT = 20;

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? filePath;
}

export function formatClonesCompact(raw: unknown): string {
  const data = raw as { clones: ClonePair[]; scanned_symbols: number; threshold: number };
  if (data.clones.length === 0) {
    return `(no clones found, threshold=${data.threshold}, scanned ${data.scanned_symbols} symbols)`;
  }
  const capped = data.clones.slice(0, MAX_CLONES_COMPACT);
  const rows = capped.map((c) => [
    `${Math.round(c.similarity * 100)}%`,
    String(c.shared_lines),
    `${basename(c.symbol_a.file)} ${c.symbol_a.name}`,
    `${basename(c.symbol_b.file)} ${c.symbol_b.name}`,
  ]);
  return formatTable(["SIM%", "SHARED", "SYMBOL_A", "SYMBOL_B"], rows);
}

export function formatClonesCounts(raw: unknown): string {
  const data = raw as { clones: ClonePair[]; scanned_symbols: number; threshold: number };
  return `${data.clones.length} clone pairs (threshold=${data.threshold}, scanned ${data.scanned_symbols})`;
}

// ── Trace route ───────────────────────────────────

interface TraceRouteResult {
  path: string;
  handlers: Array<{ file: string; method?: string; framework: string; symbol?: { name: string; kind: string; file: string; start_line: number } }>;
  call_chain: Array<{ name: string; file: string; kind: string; depth: number }>;
  db_calls: Array<{ symbol_name: string; file: string; line: number; operation: string }>;
}

const MAX_CHAIN_COMPACT = 20;

export function formatTraceRouteCompact(raw: unknown): string {
  const data = raw as TraceRouteResult;
  const parts: string[] = [`route: ${data.path}`];
  if (data.handlers.length > 0) {
    parts.push(`handlers (${data.handlers.length}):`);
    for (const h of data.handlers) {
      const sym = h.symbol ? `${h.symbol.kind} ${h.symbol.name}` : "?";
      parts.push(`  ${h.file} ${sym}`);
    }
  }
  if (data.call_chain.length > 0) {
    const capped = data.call_chain.slice(0, MAX_CHAIN_COMPACT);
    parts.push(`call chain (${data.call_chain.length}, showing ${capped.length}):`);
    for (const c of capped) {
      parts.push(`${"  ".repeat(c.depth + 1)}${c.file}:${c.name}`);
    }
    if (data.call_chain.length > MAX_CHAIN_COMPACT) {
      parts.push(`  ... +${data.call_chain.length - MAX_CHAIN_COMPACT} more`);
    }
  }
  if (data.db_calls.length > 0) {
    parts.push(`DB calls (${data.db_calls.length}):`);
    for (const d of data.db_calls.slice(0, 10)) {
      parts.push(`  ${d.file}:${d.line} ${d.operation}`);
    }
  }
  return parts.join("\n");
}

export function formatTraceRouteCounts(raw: unknown): string {
  const data = raw as TraceRouteResult;
  return `route ${data.path}: ${data.handlers.length} handlers, ${data.call_chain.length} call chain nodes, ${data.db_calls.length} DB calls`;
}

// ── Analyze hotspots ───────────────────────────────

const MAX_HOTSPOTS_COMPACT = 15;

export function formatHotspotsCompact(raw: unknown): string {
  const data = raw as { hotspots: HotspotEntry[]; period: string };
  if (data.hotspots.length === 0) return `(no hotspots found, period: ${data.period})`;
  const capped = data.hotspots.slice(0, MAX_HOTSPOTS_COMPACT);
  const rows = capped.map((h) => [
    String(h.hotspot_score),
    String(h.commits),
    h.file,
  ]);
  return formatTable(["SCORE", "COMMITS", "FILE"], rows);
}

export function formatHotspotsCounts(raw: unknown): string {
  const data = raw as { hotspots: HotspotEntry[]; period: string };
  return `${data.hotspots.length} hotspots, period: ${data.period}`;
}

// ── Next.js route map ──────────────────────────────

interface NextjsRouteMapRaw {
  routes: Array<{
    url_path: string;
    router: "app" | "pages";
    type: string;
    rendering: string;
    has_metadata: boolean;
  }>;
  conflicts: Array<{ url_path: string }>;
  middleware: { file: string; matchers: string[] } | null;
  workspaces_scanned: string[];
  scan_errors: string[];
  truncated: boolean;
}

const MAX_ROUTES_COMPACT = 25;

/** Grouped counts by router + rendering, then show top N URLs. */
export function formatNextjsRouteMapCompact(raw: unknown): string {
  const data = raw as NextjsRouteMapRaw;
  const lines: string[] = [];
  lines.push(`Routes: ${data.routes.length} | Conflicts: ${data.conflicts.length}`);

  const byRouter: Record<string, number> = {};
  const byRendering: Record<string, number> = {};
  for (const r of data.routes) {
    byRouter[r.router] = (byRouter[r.router] ?? 0) + 1;
    byRendering[r.rendering] = (byRendering[r.rendering] ?? 0) + 1;
  }
  const routerParts = Object.entries(byRouter).map(([k, v]) => `${k}=${v}`);
  const renderingParts = Object.entries(byRendering).map(([k, v]) => `${k}=${v}`);
  lines.push(`By router: ${routerParts.join(" ")}`);
  lines.push(`By rendering: ${renderingParts.join(" ")}`);

  if (data.middleware) {
    lines.push(`Middleware: ${data.middleware.file}`);
  }

  const top = data.routes.slice(0, MAX_ROUTES_COMPACT);
  for (const r of top) {
    lines.push(`  ${r.url_path} [${r.router}/${r.rendering}]`);
  }
  if (data.routes.length > MAX_ROUTES_COMPACT) {
    lines.push(`  ... +${data.routes.length - MAX_ROUTES_COMPACT} more`);
  }
  return lines.join("\n");
}

export function formatNextjsRouteMapCounts(raw: unknown): string {
  const data = raw as NextjsRouteMapRaw;
  return `${data.routes.length} routes, ${data.conflicts.length} conflicts, ${data.workspaces_scanned.length} workspaces`;
}

// ---------------------------------------------------------------------------
// Next.js metadata audit (T1)
// ---------------------------------------------------------------------------

interface NextjsMetadataAuditRaw {
  total_pages: number;
  scores: Array<{
    url_path: string;
    file_path: string;
    score: number;
    grade: string;
    violations: string[];
    missing_fields: string[];
  }>;
  counts: { excellent: number; good: number; needs_work: number; poor: number };
  top_issues: string[];
  workspaces_scanned: string[];
  parse_failures: string[];
  scan_errors: string[];
}

export function formatNextjsMetadataAuditCompact(raw: unknown): string {
  const data = raw as NextjsMetadataAuditRaw;
  const lines: string[] = [];
  lines.push(
    `${data.total_pages} pages | excellent=${data.counts.excellent} good=${data.counts.good} needs_work=${data.counts.needs_work} poor=${data.counts.poor}`,
  );
  if (data.top_issues.length > 0) {
    lines.push(`Top: ${data.top_issues.slice(0, 5).join(" | ")}`);
  }
  // Show top 3 worst-scoring routes
  const worst = [...data.scores].sort((a, b) => a.score - b.score).slice(0, 3);
  for (const s of worst) {
    lines.push(`  ${s.url_path} (${s.score}/${s.grade})`);
  }
  return lines.join("\n");
}

export function formatNextjsMetadataAuditCounts(raw: unknown): string {
  const data = raw as NextjsMetadataAuditRaw;
  return `${data.total_pages} pages: excellent=${data.counts.excellent}, good=${data.counts.good}, needs_work=${data.counts.needs_work}, poor=${data.counts.poor}`;
}

// ---------------------------------------------------------------------------
// Framework audit (T11)
// ---------------------------------------------------------------------------

interface FrameworkAuditRaw {
  summary: {
    overall_score: number;
    grade: string;
    dimensions: Record<string, { score: number; weight: number; contribution: number }>;
    top_issues: string[];
  };
  tool_errors: Array<{ tool: string; error: string }>;
  duration_ms: number;
}

export function formatFrameworkAuditCompact(raw: unknown): string {
  const data = raw as FrameworkAuditRaw;
  const lines: string[] = [];
  lines.push(`Score: ${data.summary.overall_score}/100 (${data.summary.grade}) | ${data.duration_ms}ms`);
  if (data.summary.top_issues.length > 0) {
    lines.push(`Top: ${data.summary.top_issues.slice(0, 5).join(" | ")}`);
  }
  return lines.join("\n");
}

export function formatFrameworkAuditCounts(raw: unknown): string {
  const data = raw as FrameworkAuditRaw;
  return `Score ${data.summary.overall_score}/100 (${data.summary.grade}), ${Object.keys(data.summary.dimensions).length} dimensions, ${data.tool_errors.length} errors`;
}

// ---------------------------------------------------------------------------
// Next.js server actions audit (T2)
// ---------------------------------------------------------------------------

interface ServerActionsAuditRaw {
  total: number;
  actions: Array<{
    name: string;
    file: string;
    line: number;
    score: number;
    grade: "poor" | "needs_work" | "good" | "excellent";
    top_missing: string[];
  }>;
  counts: { excellent: number; good: number; needs_work: number; poor: number };
  violations: string[];
  parse_failures: string[];
  scan_errors: string[];
}

const MAX_VIOLATIONS_COMPACT = 5;

export function formatServerActionsAuditCompact(raw: unknown): string {
  const data = raw as ServerActionsAuditRaw;
  const lines: string[] = [];
  lines.push(
    `${data.total} actions | excellent=${data.counts.excellent} good=${data.counts.good} needs_work=${data.counts.needs_work} poor=${data.counts.poor}`,
  );

  // Show top violations
  if (data.violations.length > 0) {
    lines.push(`Top violations: ${data.violations.slice(0, MAX_VIOLATIONS_COMPACT).join(" | ")}`);
  }

  // Show top 5 worst-scoring actions
  const worst = [...data.actions].sort((a, b) => a.score - b.score).slice(0, 5);
  for (const a of worst) {
    lines.push(`  ${a.file}:${a.line} ${a.name} (${a.score}/${a.grade})`);
  }

  if (data.parse_failures.length > 0) {
    lines.push(`parse failures: ${data.parse_failures.length}`);
  }
  return lines.join("\n");
}

export function formatServerActionsAuditCounts(raw: unknown): string {
  const data = raw as ServerActionsAuditRaw;
  const highSeverity = data.counts.poor + data.counts.needs_work;
  return `${data.total} actions audited, ${data.violations.length} violations (${highSeverity} high severity)`;
}

// ---------------------------------------------------------------------------
// Next.js API contract (T3)
// ---------------------------------------------------------------------------

interface ApiContractRaw {
  handlers: Array<{
    method: string;
    path: string;
    completeness: number;
    file: string;
  }>;
  total: number;
  completeness_score: number;
  parse_failures: string[];
  scan_errors: string[];
}

export function formatApiContractCompact(raw: unknown): string {
  const data = raw as ApiContractRaw;
  const lines: string[] = [];
  lines.push(`${data.total} endpoints | completeness ${data.completeness_score}%`);

  // Count handlers with resolved Zod schemas (completeness >= 0.5 means request_schema resolved)
  const withSchemas = data.handlers.filter((h) => h.completeness >= 0.5).length;
  lines.push(`With Zod schemas: ${withSchemas}/${data.total}`);

  // Show method/path/completeness per handler (no body schemas or response shapes)
  for (const h of data.handlers) {
    lines.push(`  ${h.method} ${h.path} (${Math.round(h.completeness * 100)}%) ${h.file}`);
  }

  if (data.parse_failures.length > 0) {
    lines.push(`parse failures: ${data.parse_failures.length}`);
  }
  return lines.join("\n");
}

export function formatApiContractCounts(raw: unknown): string {
  const data = raw as ApiContractRaw;
  const withSchemas = data.handlers.filter((h) => h.completeness >= 0.5).length;
  return `${data.total} endpoints, ${withSchemas} with Zod schemas, completeness ${data.completeness_score}%`;
}

// ---------------------------------------------------------------------------
// Next.js boundary analyzer (T4)
// ---------------------------------------------------------------------------

interface BoundaryAnalyzerRaw {
  entries: Array<{
    rank: number;
    path: string;
    signals: { loc: number; import_count: number; dynamic_import_count: number; third_party_imports: string[] };
    score: number;
  }>;
  client_count: number;
  total_client_loc: number;
  largest_offender: { path: string; score: number; signals: { loc: number } } | null;
  parse_failures: string[];
  scan_errors: string[];
}

const MAX_BOUNDARY_COMPACT = 10;

export function formatBoundaryAnalyzerCompact(raw: unknown): string {
  const data = raw as BoundaryAnalyzerRaw;
  const lines: string[] = [];
  lines.push(`${data.client_count} client components | total LOC ${data.total_client_loc}`);

  const top = data.entries.slice(0, MAX_BOUNDARY_COMPACT);
  const rows = top.map((e) => [
    String(e.rank),
    String(e.score),
    String(e.signals.loc),
    e.path,
  ]);
  lines.push(formatTable(["RANK", "SCORE", "LOC", "PATH"], rows));

  if (data.entries.length > MAX_BOUNDARY_COMPACT) {
    lines.push(`... +${data.entries.length - MAX_BOUNDARY_COMPACT} more`);
  }
  return lines.join("\n");
}

export function formatBoundaryAnalyzerCounts(raw: unknown): string {
  const data = raw as BoundaryAnalyzerRaw;
  const topName = data.largest_offender?.path ?? "none";
  return `${data.client_count} client components, total LOC ${data.total_client_loc}, top offender: ${topName}`;
}
