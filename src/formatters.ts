/**
 * Compact text formatters for MCP tool output.
 * Raw text uses ~50-70% fewer tokens than JSON for the same data.
 */
import type { CodeSymbol, SymbolKind } from "./types.js";
import type { ReviewDiffResult, ReviewFinding } from "./tools/review-diff-tools.js";

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
    headers.map((_, i) => pad(cells[i] ?? "", widths[i])).join("  ");

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
  const lines = data.functions.map((f) =>
    `CC=${String(f.cyclomatic_complexity).padStart(2)} nest=${f.max_nesting_depth} ${String(f.lines).padStart(4)}L ${f.file}:${f.start_line} ${f.name}`
  );
  const s = data.summary;
  return `${lines.join("\n")}\n\navg_complexity=${s.avg_complexity} max=${s.max_complexity} total=${s.total_functions}`;
}

// ── Find clones ───────────────────────────────────

interface ClonePair { symbol_a: { name: string; file: string; start_line: number }; symbol_b: { name: string; file: string; start_line: number }; similarity: number; shared_lines: number }

export function formatClones(data: { clones: ClonePair[]; scanned_symbols: number; threshold: number }): string {
  if (data.clones.length === 0) return `(no clones found, threshold=${data.threshold}, scanned ${data.scanned_symbols} symbols)`;
  const lines = data.clones.map((c) =>
    `${Math.round(c.similarity * 100)}% (${c.shared_lines}L) ${c.symbol_a.file}:${c.symbol_a.start_line} ${c.symbol_a.name} ↔ ${c.symbol_b.file}:${c.symbol_b.start_line} ${c.symbol_b.name}`
  );
  return `scanned ${data.scanned_symbols} symbols, threshold=${data.threshold}\n${lines.join("\n")}`;
}

// ── Analyze hotspots ──────────────────────────────

interface HotspotEntry { file: string; commits: number; lines_changed: number; symbol_count: number; hotspot_score: number }

export function formatHotspots(data: { hotspots: HotspotEntry[]; period: string }): string {
  if (data.hotspots.length === 0) return `(no hotspots found, period: ${data.period})`;
  const lines = data.hotspots.map((h) =>
    `score=${String(h.hotspot_score).padStart(6)} commits=${String(h.commits).padStart(3)} changed=${String(h.lines_changed).padStart(5)} ${h.file}`
  );
  return `period: ${data.period}\n${lines.join("\n")}`;
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
