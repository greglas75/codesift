/**
 * explore — one call that answers "where is X and how does it connect".
 *
 * Agents reach an answer through a sequence: search for a name, read the definition, look for its
 * callers, read one of those. Each step is a round trip and a tool choice. codegraph v1.6 went as far
 * as exposing ONE tool by default ("one strong tool steers agents better than a menu"), and our own
 * harness runs point the same way: in a 35-session SWE-bench-style run, 20 sessions called exactly one
 * codesift tool. This tool bundles that sequence, under a token budget:
 *
 *   1. rank symbols for the query (BM25, the same ranking search_symbols uses);
 *   2. the top few with FULL source — or an "unchanged" pointer if already shown (shown-source.ts);
 *   3. their direct callers and callees (depth 1, tests excluded);
 *   4. the remaining matches as one-line locations, so nothing found is silently dropped.
 *
 * It composes existing, tested pieces; it adds no retrieval logic of its own.
 */
import { searchSymbols } from "./search-tools.js";
import { getSymbols } from "./symbol-lookup-tools.js";
import { callNeighbours } from "./graph-tools.js";
import { elideShownSource } from "../server-helpers/shown-source.js";
import type { CodeSymbol } from "../types.js";

const CHARS_PER_TOKEN = 3.5;
const DEFAULT_TOKEN_BUDGET = 6_000;
const DEFAULT_TOP = 3;
const MAX_TOP = 8;
const CANDIDATES = 15;
const NEIGHBOUR_LIMIT = 6;

export interface ExploreOptions {
  top?: number | undefined;
  token_budget?: number | undefined;
  file_pattern?: string | undefined;
}

function location(sym: Pick<CodeSymbol, "file" | "start_line">): string {
  return `${sym.file}:${sym.start_line}`;
}

function neighbourLine(label: string, list: CodeSymbol[], total: number): string | null {
  if (total === 0) return null;
  const shown = list.map((s) => `${s.name} (${location(s)})`).join(", ");
  const more = total > list.length ? ` … +${total - list.length} more (trace_call_chain for all)` : "";
  return `  ${label}: ${shown}${more}`;
}

/** Keep whole lines of `source` within `maxChars`, saying how many were dropped. */
function clipSource(source: string, maxChars: number): string {
  if (source.length <= maxChars) return source;
  const lines = source.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  return `${kept.join("\n")}\n  … ${dropped} more lines (budget) — get_symbol for the full body`;
}

export async function explore(repo: string, query: string, options: ExploreOptions = {}): Promise<string> {
  const top = Math.min(Math.max(1, Math.floor(options.top ?? DEFAULT_TOP)), MAX_TOP);
  const budgetTokens = options.token_budget && options.token_budget > 0 ? options.token_budget : DEFAULT_TOKEN_BUDGET;
  const budgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);

  const hits = await searchSymbols(repo, query, {
    include_source: false,
    // "standard", not "compact": compact results drop the canonical id, and the id is what the
    // source and call-graph lookups below key on.
    detail_level: "standard",
    top_k: CANDIDATES,
    file_pattern: options.file_pattern,
  });
  if (hits.length === 0) {
    return `No symbols match "${query}". For a literal string or error message use search_text; ` +
      "for a concept, semantic_search. If the repo changed since indexing, index_folder once.";
  }

  const primaryIds = hits.slice(0, top).map((h) => h.symbol.id);
  const primary = await getSymbols(repo, primaryIds);
  // Search results carry the canonical `repo:file:name:line`; getSymbols returns the same symbols
  // with the repo prefix stripped. Compare in one form, or every lookup misses.
  const canon = (id: string): string => (id.startsWith(`${repo}:`) ? id.slice(repo.length + 1) : id);
  const byId = new Map(primary.map((s) => [canon(s.id), s]));
  // getSymbols does not promise request order; the ranking is the point, so restore it.
  const resolvedIds = primaryIds.filter((id) => byId.has(canon(id)));
  const ordered = resolvedIds.map((id) => byId.get(canon(id)) as CodeSymbol);
  // The adjacency is keyed by the index's own (canonical) ids — the ones search handed back.
  const neighbours = await callNeighbours(repo, resolvedIds, NEIGHBOUR_LIMIT)
    .catch(() => new Map<string, never>());

  const sections: string[] = [];
  let used = 0;
  // Structure first: every primary symbol gets its header and graph lines even if source runs out.
  const perSymbolSourceBudget = Math.max(400, Math.floor((budgetChars * 0.8) / Math.max(1, ordered.length)));

  for (const sym of ordered) {
    const { symbol, note } = elideShownSource(sym);
    const sig = symbol.signature ? ` ${symbol.signature}` : "";
    const lines = [`${location(symbol)}-${symbol.end_line} ${symbol.kind} ${symbol.name}${sig}`];
    if (note) lines.push(note);
    else if (symbol.source) {
      const room = Math.min(perSymbolSourceBudget, Math.max(400, budgetChars - used));
      lines.push(clipSource(symbol.source, room));
    }
    const n = neighbours.get(resolvedIds[ordered.indexOf(sym)] ?? "");
    if (n) {
      const callers = neighbourLine("called by", n.callers, n.callersTotal);
      const callees = neighbourLine("calls", n.callees, n.calleesTotal);
      if (callers) lines.push(callers);
      if (callees) lines.push(callees);
      if (!callers && !callees) lines.push("  (no direct callers or callees found in non-test code)");
    }
    const block = lines.join("\n");
    used += block.length;
    sections.push(block);
  }

  // Anything ranked but not rendered above — including a top hit whose lookup failed — is listed,
  // so a resolution fault shows up as a location rather than as a silently shorter answer.
  const rendered = new Set(resolvedIds);
  const rest = hits.filter((h) => !rendered.has(h.symbol.id));
  if (rest.length > 0) {
    sections.push(
      `--- other matches (${rest.length}) ---\n` +
        rest.map((h) => `${location(h.symbol)} ${h.symbol.kind} ${h.symbol.name}`).join("\n"),
    );
  }
  return sections.join("\n\n");
}
