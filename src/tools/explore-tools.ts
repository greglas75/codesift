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
import { commitDelivered, elideShownSource, type ShownSourceView } from "../server-helpers/shown-source.js";
import { CHARS_PER_TOKEN } from "../server-helpers/response-budget.js";
import type { CodeSymbol } from "../types.js";

const DEFAULT_TOKEN_BUDGET = 6_000;
const DEFAULT_TOP = 3;
const MAX_TOP = 8;
const CANDIDATES = 15;
const NEIGHBOUR_LIMIT = 6;
const MIN_SOURCE_CHARS = 400;

export interface ExploreOptions {
  top?: number | undefined;
  token_budget?: number | undefined;
  file_pattern?: string | undefined;
  /** Resend source even when the ledger says this conversation already has it. */
  full_source?: boolean | undefined;
}

type Neighbours = Awaited<ReturnType<typeof callNeighbours>>;

function location(sym: Pick<CodeSymbol, "file" | "start_line">): string {
  return `${sym.file}:${sym.start_line}`;
}

function neighbourLine(label: string, list: CodeSymbol[], total: number): string | null {
  if (total === 0) return null;
  const shown = list.map((s) => `${s.name} (${location(s)})`).join(", ");
  const more = total > list.length ? ` … +${total - list.length} more (trace_call_chain for all)` : "";
  return `  ${label}: ${shown}${more}`;
}

/** Keep whole lines of `source` within `maxChars`; `clipped` says whether anything was dropped. */
function clipSource(source: string, maxChars: number): { text: string; clipped: boolean } {
  if (source.length <= maxChars) return { text: source, clipped: false };
  const lines = source.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  // A first line longer than the whole room would otherwise leave an empty body above a "1 more
  // lines" note — the header with nothing under it. Show its head instead.
  if (kept.length === 0) {
    return {
      text: `${source.slice(0, maxChars)}\n  … line continues (budget) — raise token_budget, or top=1, for the full body`,
      clipped: true,
    };
  }
  const dropped = lines.length - kept.length;
  return {
    text: `${kept.join("\n")}\n  … ${dropped} more lines (budget) — raise token_budget, or top=1, for the full body`,
    clipped: true,
  };
}

function graphLines(neighbours: Neighbours | Error, id: string): string[] {
  // A failed lookup is reported as a failure. Rendering it as "no callers" would make an
  // infrastructure fault indistinguishable from a real, empty answer.
  if (neighbours instanceof Error) return [`  (call graph unavailable: ${neighbours.message})`];
  const n = neighbours.get(id);
  if (!n) return [];
  const callers = neighbourLine("called by", n.callers, n.callersTotal);
  const callees = neighbourLine("calls", n.callees, n.calleesTotal);
  if (!callers && !callees) return ["  (no direct callers or callees found in non-test code)"];
  return [callers, callees].filter((l): l is string => l !== null);
}

/** One primary match: header, source (or pointer), call graph. */
function renderPrimary(
  sym: CodeSymbol,
  id: string,
  neighbours: Neighbours | Error,
  sourceRoom: number,
  force: boolean,
): { block: string; view: ShownSourceView<CodeSymbol>; clipped: boolean } {
  const view = elideShownSource(sym, force ? { force } : undefined);
  const { symbol, note } = view;
  const sig = symbol.signature ? ` ${symbol.signature}` : "";
  const lines = [`${location(symbol)}-${symbol.end_line} ${symbol.kind} ${symbol.name}${sig}`];
  let clipped = false;
  if (note) lines.push(note);
  else if (symbol.source) {
    const clip = clipSource(symbol.source, sourceRoom);
    clipped = clip.clipped;
    lines.push(clip.text);
  }
  lines.push(...graphLines(neighbours, id));
  return { block: lines.join("\n"), view, clipped };
}

/** Rank, then resolve the top ids to full symbols — in rank order, keyed by the index's own ids. */
async function resolvePrimary(
  repo: string,
  primaryIds: string[],
): Promise<{ resolvedIds: string[]; ordered: CodeSymbol[] }> {
  const primary = await getSymbols(repo, primaryIds);
  // Search results carry the canonical `repo:file:name:line`; getSymbols returns the same symbols
  // with the repo prefix stripped. Compare in one form, or every lookup misses.
  const canon = (id: string): string => (id.startsWith(`${repo}:`) ? id.slice(repo.length + 1) : id);
  const byId = new Map(primary.map((s) => [canon(s.id), s]));
  const resolvedIds = primaryIds.filter((id) => byId.has(canon(id)));
  return { resolvedIds, ordered: resolvedIds.map((id) => byId.get(canon(id)) as CodeSymbol) };
}

export async function explore(repo: string, query: string, options: ExploreOptions = {}): Promise<string> {
  // Number.isFinite, not `??`: a NaN top clamps through Math.max/min to NaN and slices to nothing.
  const rawTop = Number.isFinite(options.top) ? (options.top as number) : DEFAULT_TOP;
  const top = Math.min(Math.max(1, Math.floor(rawTop)), MAX_TOP);
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

  const { resolvedIds, ordered } = await resolvePrimary(repo, hits.slice(0, top).map((h) => h.symbol.id));
  const neighbours: Neighbours | Error = await callNeighbours(repo, resolvedIds, NEIGHBOUR_LIMIT)
    .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));

  const perSymbol = Math.max(MIN_SOURCE_CHARS, Math.floor((budgetChars * 0.8) / Math.max(1, ordered.length)));
  const sections: string[] = [];
  const delivered: Array<{ view: ShownSourceView<unknown>; chars: number }> = [];
  let used = 0;
  ordered.forEach((sym, i) => {
    const room = Math.min(perSymbol, Math.max(MIN_SOURCE_CHARS, budgetChars - used));
    const { block, view, clipped } = renderPrimary(sym, resolvedIds[i] ?? sym.id, neighbours, room, options.full_source === true);
    used += block.length;
    sections.push(block);
    // A clipped body was not delivered whole, so it must not earn an "unchanged" pointer later —
    // but its length still counts toward the budget walk for the blocks after it.
    delivered.push({ view: clipped ? { ...view, commit: () => {} } : view, chars: block.length + 2 });
  });

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
  commitDelivered(delivered);
  return sections.join("\n\n");
}
