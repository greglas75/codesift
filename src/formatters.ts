/**
 * Compact text formatters for MCP tool output.
 * Raw text uses ~50-70% fewer tokens than JSON for the same data.
 */
import type { CodeSymbol, SymbolKind } from "./types.js";
import type { ReviewDiffResult, ReviewFinding } from "./tools/review-diff-tools.js";
import type { PerfHotspotsResult, PerfFinding } from "./tools/perf-tools.js";
import type { FanInFanOutResult, CoChangeResult } from "./tools/coupling-tools.js";
import type { ArchitectureSummaryResult } from "./tools/architecture-tools.js";

// ── Table formatter ──────────────────────────────

export function formatTable(
  headers: string[],
  rows: Array<string[]>,
  options?: { maxColWidth?: number }
): string {
  const maxCol = options?.maxColWidth ?? 40;
  const colCount = headers.length;

  // Compute column widths
  const widths = headers.map((h, i) => {
    const cellWidths = rows.map((r) => {
      const cell = r[i] ?? "";
      return cell.length > maxCol ? maxCol : cell.length;
    });
    return Math.min(maxCol, Math.max(h.length, ...cellWidths, 1));
  });

  const pad = (s: string, w: number) => {
    if (s.length > w) return s.slice(0, w - 3) + "...";
    return s.padEnd(w);
  };

  const formatRow = (cells: string[]) =>
    headers.map((_, i) => pad(cells[i] ?? "", widths[i] ?? 10)).join("  ");

  const headerLine = formatRow(headers);
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const dataLines = rows.map((r) => formatRow(r.slice(0, colCount)));

  return [headerLine, separator, ...dataLines].join("\n");
}

// ── Search symbols ────────────────────────────────

interface SearchResult {
  symbol: CodeSymbol;
  score: number;
}

export function formatSearchSymbols(results: SearchResult[]): string {
  if (results.length === 0) return "(no results)";
  return results.map((r) => {
    const sym = r.symbol;
    const loc = `${sym.file}:${sym.start_line}`;
    const sig = sym.signature ? ` ${sym.signature}` : "";
    const header = `${loc} ${sym.kind} ${sym.name}${sig}`;
    if (!sym.source) return header;
    return `${header}\n${sym.source}`;
  }).join("\n\n");
}

// ── File tree ─────────────────────────────────────

interface CompactFileEntry { path: string; symbols: number }
interface FileTreeNode { name: string; path: string; type: "dir" | "file"; symbol_count?: number; children?: FileTreeNode[] }

export function formatFileTree(data: CompactFileEntry[] | FileTreeNode[] | { entries: CompactFileEntry[]; truncated: boolean; total: number; hint: string }): string {
  // Truncated compact
  if ("entries" in data && "truncated" in data) {
    const entries = (data as { entries: CompactFileEntry[]; total: number; hint: string }).entries;
    const lines = entries.map((e) => e.symbols > 0 ? `${e.path} (${e.symbols})` : e.path);
    return `${lines.join("\n")}\n\n(${(data as { hint: string }).hint})`;
  }

  const arr = data as Array<CompactFileEntry | FileTreeNode>;
  if (arr.length === 0) return "(empty)";

  // Compact list — only files with symbols, capped at 250
  if ("symbols" in arr[0]!) {
    const MAX_FILES = 250;
    const withSymbols = (arr as CompactFileEntry[]).filter((e) => e.symbols > 0);
    const shown = withSymbols.slice(0, MAX_FILES);
    const without = arr.length - withSymbols.length;
    let result = shown.map((e) => `${e.path} (${e.symbols})`).join("\n");
    if (withSymbols.length > MAX_FILES) result += `\n(+${withSymbols.length - MAX_FILES} more files)`;
    if (without > 0) result += `\n(${without} files without symbols omitted)`;
    return result;
  }

  // Nested tree → indent
  const lines: string[] = [];
  function walk(nodes: FileTreeNode[], depth: number): void {
    for (const n of nodes) {
      const indent = "  ".repeat(depth);
      const syms = n.symbol_count ? ` (${n.symbol_count})` : "";
      lines.push(`${indent}${n.name}${syms}`);
      if (n.children) walk(n.children, depth + 1);
    }
  }
  walk(arr as FileTreeNode[], 0);
  return lines.join("\n");
}

// ── File outline ──────────────────────────────────

interface OutlineEntry { id: string; name: string; kind: SymbolKind; start_line: number; end_line: number; signature?: string; parent?: string }

export function formatFileOutline(data: { symbols: OutlineEntry[]; truncated?: boolean; total_symbols?: number }): string {
  if (data.symbols.length === 0) return "(no symbols)";
  const lines = data.symbols.map((s) => {
    const sig = s.signature ? ` ${s.signature}` : "";
    const parent = s.parent ? ` [${s.parent}]` : "";
    return `${String(s.start_line).padStart(4)}:${String(s.end_line).padStart(4)} ${s.kind} ${s.name}${sig}${parent}`;
  });
  let result = lines.join("\n");
  if (data.truncated) result += `\n\n(truncated: showing ${data.symbols.length}/${data.total_symbols} symbols)`;
  return result;
}

// ── Search patterns ───────────────────────────────

interface PatternMatch { name: string; kind: SymbolKind; file: string; start_line: number; context: string }
interface PatternResult { matches: PatternMatch[]; pattern: string; scanned_symbols: number }

export function formatSearchPatterns(data: PatternResult): string {
  const header = `pattern: ${data.pattern} (scanned ${data.scanned_symbols} symbols)`;
  if (data.matches.length === 0) return `${header}\n(no matches)`;
  const lines = data.matches.map((m) =>
    `${m.file}:${m.start_line} ${m.kind} ${m.name}: ${m.context.slice(0, 150)}`
  );
  return `${header}\n${lines.join("\n")}`;
}

// ── Find dead code ────────────────────────────────

interface DeadCodeCandidate { name: string; kind: SymbolKind; file: string; start_line: number; end_line: number }

export function formatDeadCode(data: { candidates: DeadCodeCandidate[]; scanned_symbols: number; scanned_files: number }): string {
  const header = `scanned ${data.scanned_symbols} symbols in ${data.scanned_files} files`;
  if (data.candidates.length === 0) return `${header}\n(no dead code found)`;
  const lines = data.candidates.map((c) =>
    `${c.file}:${c.start_line}-${c.end_line} ${c.kind} ${c.name}`
  );
  return `${header}\n${lines.join("\n")}`;
}

// ── Analyze complexity ────────────────────────────

interface ComplexityEntry { name: string; kind: string; file: string; start_line: number; lines: number; cyclomatic_complexity: number; max_nesting_depth: number }

export function formatComplexity(data: { functions: ComplexityEntry[]; summary: Record<string, number> }): string {
  if (data.functions.length === 0) return "(no functions found)";
  const rows = data.functions.map((f) => [
    String(f.cyclomatic_complexity),
    String(f.max_nesting_depth),
    String(f.lines),
    `${f.file}:${f.start_line}`,
    f.name,
  ]);
  const s = data.summary;
  const table = formatTable(["CC", "NEST", "LINES", "FILE:LINE", "NAME"], rows);
  return `${table}\n\navg_complexity=${s.avg_complexity} max=${s.max_complexity} total=${s.total_functions}`;
}

// ── Find clones ───────────────────────────────────

interface ClonePair { symbol_a: { name: string; file: string; start_line: number }; symbol_b: { name: string; file: string; start_line: number }; similarity: number; shared_lines: number }

export function formatClones(data: { clones: ClonePair[]; scanned_symbols: number; threshold: number }): string {
  if (data.clones.length === 0) return `(no clones found, threshold=${data.threshold}, scanned ${data.scanned_symbols} symbols)`;
  const rows = data.clones.map((c) => [
    `${Math.round(c.similarity * 100)}%`,
    String(c.shared_lines),
    `${c.symbol_a.file}:${c.symbol_a.start_line} ${c.symbol_a.name}`,
    `${c.symbol_b.file}:${c.symbol_b.start_line} ${c.symbol_b.name}`,
  ]);
  const table = formatTable(["SIM%", "SHARED", "SYMBOL_A", "SYMBOL_B"], rows);
  return `scanned ${data.scanned_symbols} symbols, threshold=${data.threshold}\n${table}`;
}

// ── Analyze hotspots ──────────────────────────────

interface HotspotEntry { file: string; commits: number; lines_changed: number; symbol_count: number; hotspot_score: number }

export function formatHotspots(data: { hotspots: HotspotEntry[]; period: string }): string {
  if (data.hotspots.length === 0) return `(no hotspots found, period: ${data.period})`;
  const rows = data.hotspots.map((h) => [
    String(h.hotspot_score),
    String(h.commits),
    String(h.lines_changed),
    h.file,
  ]);
  const table = formatTable(["SCORE", "COMMITS", "CHANGED", "FILE"], rows);
  return `period: ${data.period}\n${table}`;
}

// ── Repo outline ──────────────────────────────────

interface DirSummary { path: string; file_count: number; symbol_count: number; languages: string[] }

export function formatRepoOutline(data: { directories: DirSummary[]; total_symbols: number; total_files: number }): string {
  const header = `${data.total_files} files, ${data.total_symbols} symbols`;
  const lines = data.directories.map((d) =>
    `${String(d.symbol_count).padStart(4)} sym  ${d.path} (${d.file_count}f)`
  );
  return `${header}\n${lines.join("\n")}`;
}

// ── Suggest queries ───────────────────────────────

interface SuggestResult { top_files: Array<{ path: string; symbols: number }>; kind_distribution: Record<string, number>; example_queries: string[] }

export function formatSuggestQueries(data: SuggestResult): string {
  const top = data.top_files.map((f) => `  ${f.path} (${f.symbols})`).join("\n");
  const kinds = Object.entries(data.kind_distribution).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  const examples = data.example_queries.map((q) => `  ${q}`).join("\n");
  return `top files:\n${top}\n\nkinds:\n${kinds}\n\nexample queries:\n${examples}`;
}

// ── Scan secrets ──────────────────────────────────

interface SecretFinding { rule: string; masked_secret: string; confidence: string; severity: string; file: string; line: number }

export function formatSecrets(data: { findings: SecretFinding[]; files_scanned: number; files_with_secrets: number }): string {
  const header = `scanned ${data.files_scanned} files, ${data.files_with_secrets} with secrets`;
  if (data.findings.length === 0) return `${header}\n(no secrets found)`;
  const lines = data.findings.map((f) =>
    `[${f.severity}/${f.confidence}] ${f.file}:${f.line} ${f.rule}: ${f.masked_secret}`
  );
  return `${header}\n${lines.join("\n")}`;
}

// ── Conversations ─────────────────────────────────

interface ConversationResult { session_id: string; timestamp: string; user_question: string; assistant_answer: string; score: number }

export function formatConversations(data: { results: ConversationResult[] } | ConversationResult[]): string {
  const results = Array.isArray(data) ? data : data.results;
  if (results.length === 0) return "(no conversations found)";
  return results.map((r) => {
    const date = r.timestamp?.slice(0, 10) ?? "?";
    const question = r.user_question?.slice(0, 200) ?? "";
    const answer = r.assistant_answer?.slice(0, 300) ?? "";
    return `[${date}] Q: ${question}\nA: ${answer}`;
  }).join("\n\n");
}

// ── Classify roles ────────────────────────────────

interface RoleEntry { name: string; kind: string; file: string; role: string; callers: number; callees: number }

export function formatRoles(data: { symbols: RoleEntry[] } | RoleEntry[]): string {
  const symbols = Array.isArray(data) ? data : (data as { symbols: RoleEntry[] }).symbols;
  if (!symbols || symbols.length === 0) return "(no symbols classified)";
  return symbols.map((s) =>
    `${s.role.padEnd(8)} ${s.file}:${s.name} (${s.kind}) callers=${s.callers} callees=${s.callees}`
  ).join("\n");
}

// ── Assemble context ──────────────────────────────

interface AssembleResult {
  symbols?: Array<{ name: string; kind: string; file: string; start_line: number; source?: string; signature?: string }>;
  compact_symbols?: Array<{ name: string; kind: string; file: string; start_line: number; signature?: string; docstring?: string }>;
  file_summaries?: Array<{ path: string; language: string; exports: string[]; symbol_count: number }>;
  directory_overview?: Array<{ path: string; file_count: number; symbol_count: number; top_files: string[] }>;
  level: string;
  total_tokens: number;
  truncated: boolean;
  result_count: number;
}

export function formatAssembleContext(data: AssembleResult): string {
  const meta = `level=${data.level} results=${data.result_count}${data.truncated ? " (truncated)" : ""}`;

  // L0: full source
  if (data.symbols) {
    const lines = data.symbols.map((s) => {
      const sig = s.signature ? ` ${s.signature}` : "";
      const header = `${s.file}:${s.start_line} ${s.kind} ${s.name}${sig}`;
      return s.source ? `${header}\n${s.source}` : header;
    });
    return `${meta}\n\n${lines.join("\n\n")}`;
  }

  // L1: signatures
  if (data.compact_symbols) {
    const lines = data.compact_symbols.map((s) => {
      const sig = s.signature ? ` ${s.signature}` : "";
      const doc = s.docstring ? `  // ${s.docstring.slice(0, 80)}` : "";
      return `${s.file}:${s.start_line} ${s.kind} ${s.name}${sig}${doc}`;
    });
    return `${meta}\n${lines.join("\n")}`;
  }

  // L2: file summaries
  if (data.file_summaries) {
    const lines = data.file_summaries.map((f) =>
      `${f.path} [${f.language}] (${f.symbol_count} symbols): ${f.exports.join(", ")}`
    );
    return `${meta}\n${lines.join("\n")}`;
  }

  // L3: directory overview
  if (data.directory_overview) {
    const lines = data.directory_overview.map((d) =>
      `${d.path} (${d.file_count} files, ${d.symbol_count} symbols) top: ${d.top_files.join(", ")}`
    );
    return `${meta}\n${lines.join("\n")}`;
  }

  return meta;
}

// ── Detect communities ────────────────────────────

interface Community { id: number; name: string; files: string[]; symbol_count: number; internal_edges: number; external_edges: number; cohesion: number }
interface CommunitiesResult { communities: Community[]; modularity: number; total_files: number }

// ── Trace call chain ──────────────────────────────

interface CallNode { symbol: { name: string; kind: string; file: string; start_line: number }; children: CallNode[] }

export function formatCallTree(data: CallNode | string): string {
  if (typeof data === "string") return data; // mermaid
  const lines: string[] = [];
  function walk(node: CallNode, depth: number): void {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${node.symbol.file}:${node.symbol.start_line} ${node.symbol.kind} ${node.symbol.name}`);
    for (const child of node.children) walk(child, depth + 1);
  }
  walk(data, 0);
  return lines.join("\n");
}

// ── Trace route ───────────────────────────────────

interface RouteResult {
  path: string;
  handlers: Array<{ file: string; symbol?: { name: string; kind: string; file: string; start_line: number } }>;
  call_chain: Array<{ name: string; file: string; kind: string; depth: number }>;
  db_calls: Array<{ symbol_name: string; file: string; line: number; operation: string }>;
  middleware?: { file: string; matchers: string[]; applies: boolean };
  layout_chain?: string[];
  server_actions?: Array<{ name: string; file: string; called_from?: string }>;
}

export function formatTraceRoute(data: RouteResult | string): string {
  if (typeof data === "string") return data; // mermaid
  const parts: string[] = [`route: ${data.path}`];
  if (data.handlers.length > 0) {
    parts.push("\nhandlers:");
    for (const h of data.handlers) {
      const sym = h.symbol ? `${h.symbol.kind} ${h.symbol.name}` : "?";
      parts.push(`  ${h.file} ${sym}`);
    }
  }
  if (data.call_chain.length > 0) {
    parts.push("\ncall chain:");
    for (const c of data.call_chain) {
      const indent = "  ".repeat(c.depth + 1);
      parts.push(`${indent}${c.file}:${c.name} (${c.kind})`);
    }
  }
  if (data.db_calls.length > 0) {
    parts.push("\nDB calls:");
    for (const d of data.db_calls) {
      parts.push(`  ${d.file}:${d.line} ${d.operation} ${d.symbol_name}`);
    }
  }
  if (data.middleware) {
    const mw = data.middleware;
    const status = mw.applies ? "applies" : "does not apply";
    parts.push(`\nMiddleware: ${mw.file} (${status})`);
    if (mw.matchers.length > 0) {
      parts.push(`  matchers: ${mw.matchers.join(", ")}`);
    }
  }
  if (data.layout_chain && data.layout_chain.length > 0) {
    parts.push(`\nLayout chain: ${data.layout_chain.join(" \u2192 ")}`);
  }
  if (data.server_actions && data.server_actions.length > 0) {
    parts.push("\nServer Actions:");
    for (const sa of data.server_actions) {
      const from = sa.called_from ? ` (called from ${sa.called_from})` : "";
      parts.push(`  ${sa.name} (${sa.file})${from}`);
    }
  }
  return parts.join("\n");
}

// ── Diff outline ──────────────────────────────────

interface DiffOutlineResult {
  added: Array<{ name: string; kind: string; file: string; start_line: number }>;
  modified: Array<{ name: string; kind: string; file: string; start_line: number }>;
  deleted: string[];
}

export function formatDiffOutline(data: DiffOutlineResult): string {
  const parts: string[] = [];
  if (data.added.length > 0) {
    parts.push(`added (${data.added.length}):`);
    for (const s of data.added.slice(0, 50)) parts.push(`  + ${s.file}:${s.start_line} ${s.kind} ${s.name}`);
    if (data.added.length > 50) parts.push(`  ... +${data.added.length - 50} more`);
  }
  if (data.modified.length > 0) {
    parts.push(`modified (${data.modified.length}):`);
    for (const s of data.modified.slice(0, 50)) parts.push(`  ~ ${s.file}:${s.start_line} ${s.kind} ${s.name}`);
    if (data.modified.length > 50) parts.push(`  ... +${data.modified.length - 50} more`);
  }
  if (data.deleted.length > 0) {
    parts.push(`deleted files (${data.deleted.length}):`);
    for (const f of data.deleted) parts.push(`  - ${f}`);
  }
  if (parts.length === 0) return "(no changes)";
  return parts.join("\n");
}

// ── Changed symbols ───────────────────────────────

interface ChangedFileSymbols { file: string; symbols: string[]; diff?: string }

export function formatChangedSymbols(data: ChangedFileSymbols[]): string {
  if (data.length === 0) return "(no changed symbols)";
  return data.map((f) => {
    if (f.symbols.length <= 5) return `${f.file}: ${f.symbols.join(", ")}`;
    const shown = f.symbols.slice(0, 5).join(", ");
    return `${f.file} (${f.symbols.length}): ${shown} +${f.symbols.length - 5}`;
  }).join("\n");
}

// ── Impact analysis ───────────────────────────────

interface ImpactResult {
  changed_files: string[];
  affected_symbols: Array<{ name: string; kind: string; file: string; start_line: number }>;
  affected_tests: Array<{ test_file: string; reason: string }>;
  risk_scores: Array<{ file: string; risk: string; score: number }>;
  dependency_graph: Record<string, string[]>;
}

export function formatImpactAnalysis(data: ImpactResult): string {
  const parts: string[] = [];
  parts.push(`changed: ${data.changed_files.join(", ")}`);

  if (data.risk_scores.length > 0) {
    parts.push("\nrisk:");
    for (const r of data.risk_scores) {
      parts.push(`  [${r.risk}] ${r.file}`);
    }
  }

  if (data.affected_symbols.length > 0) {
    const MAX_SHOW = 15;
    parts.push(`\naffected (${data.affected_symbols.length}):`);
    for (const s of data.affected_symbols.slice(0, MAX_SHOW)) {
      parts.push(`  ${s.file}:${s.start_line} ${s.kind} ${s.name}`);
    }
    if (data.affected_symbols.length > MAX_SHOW) parts.push(`  +${data.affected_symbols.length - MAX_SHOW} more`);
  }

  if (data.affected_tests.length > 0) {
    parts.push("\ntests:");
    for (const t of data.affected_tests.slice(0, 10)) {
      parts.push(`  ${t.test_file}`);
    }
  }

  // Omit dep graph — too verbose, agent rarely uses it
  const depCount = Object.keys(data.dependency_graph).length;
  if (depCount > 0) parts.push(`\n(${depCount} files in dependency graph — omitted for brevity)`);

  return parts.join("\n");
}

// ── Knowledge map ─────────────────────────────────

interface KnowledgeMapResult {
  modules: Array<{ path: string; symbol_count: number }>;
  edges: Array<{ from: string; to: string }>;
  circular_deps: Array<{ cycle: string[] }>;
  truncated?: boolean;
  total_modules?: number;
}

export function formatKnowledgeMap(data: KnowledgeMapResult | { mermaid: string }): string {
  if ("mermaid" in data) return (data as { mermaid: string }).mermaid;
  const parts: string[] = [];
  parts.push(`${data.modules.length} modules, ${data.edges.length} edges`);
  if (data.truncated) parts[0] += ` (truncated from ${data.total_modules})`;

  if (data.modules.length > 0) {
    parts.push("\nmodules:");
    for (const m of data.modules.slice(0, 30)) {
      parts.push(`  ${m.path} (${m.symbol_count})`);
    }
  }
  if (data.edges.length > 0) {
    parts.push("\nedges:");
    for (const e of data.edges.slice(0, 50)) {
      parts.push(`  ${e.from} → ${e.to}`);
    }
  }
  if (data.circular_deps.length > 0) {
    parts.push("\ncircular:");
    for (const c of data.circular_deps) {
      parts.push(`  ${c.cycle.join(" → ")}`);
    }
  }
  return parts.join("\n");
}

export function formatCommunities(data: CommunitiesResult | string): string {
  if (typeof data === "string") return data; // mermaid format
  const header = `${data.communities.length} communities, ${data.total_files} files, modularity=${data.modularity.toFixed(2)}`;
  const lines = data.communities.map((c) => {
    const filesStr = c.files.slice(0, 10).join(", ");
    const more = c.files.length > 10 ? ` +${c.files.length - 10} more` : "";
    return `[${c.name}] ${c.symbol_count} symbols, cohesion=${c.cohesion.toFixed(2)}\n  ${filesStr}${more}`;
  });
  return `${header}\n\n${lines.join("\n\n")}`;
}

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

// ---------------------------------------------------------------------------
// Next.js component classifier formatter
// ---------------------------------------------------------------------------

import type { NextjsComponentsResult } from "./tools/nextjs-component-tools.js";

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

import type { NextjsRouteMapResult } from "./tools/nextjs-route-tools.js";
import type { NextjsMetadataAuditResult } from "./tools/nextjs-metadata-tools.js";
import type { ServerActionsAuditResult } from "./tools/nextjs-security-tools.js";
import type { ApiContractResult } from "./tools/nextjs-api-contract-tools.js";
import type { NextjsBoundaryResult } from "./tools/nextjs-boundary-tools.js";
import type { LinkIntegrityResult } from "./tools/nextjs-link-tools.js";
import type { NextjsDataFlowResult } from "./tools/nextjs-data-flow-tools.js";
import type { NextjsMiddlewareCoverageResult } from "./tools/nextjs-middleware-coverage-tools.js";

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
