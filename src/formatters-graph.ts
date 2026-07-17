/** Graph, route, diff, and dependency-map text formatters. */
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
  // Cap unbounded lists — a `since=<old sha>` spanning thousands of files
  // once produced a 141K-token response from these two loops alone.
  const MAX_CHANGED = 100;
  const MAX_RISK = 50;
  const changedShown = data.changed_files.slice(0, MAX_CHANGED);
  let changedLine = `changed: ${changedShown.join(", ")}`;
  if (data.changed_files.length > MAX_CHANGED) {
    changedLine += ` … +${data.changed_files.length - MAX_CHANGED} more files`;
  }
  parts.push(changedLine);

  if (data.risk_scores.length > 0) {
    parts.push("\nrisk:");
    for (const r of data.risk_scores.slice(0, MAX_RISK)) {
      parts.push(`  [${r.risk}] ${r.file}`);
    }
    if (data.risk_scores.length > MAX_RISK) {
      parts.push(`  +${data.risk_scores.length - MAX_RISK} more (narrow the since= range for full detail)`);
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
