/** Core and repository-oriented text formatters. */
import type { CodeSymbol, SymbolKind } from "./types.js";

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
