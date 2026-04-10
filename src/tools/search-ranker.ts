// search-ranker.ts — Classify, dedup, and rank text search hits by symbol context
import type { TextMatch, CodeIndex, CodeSymbol } from "../types.js";

// ── Label bonus for ranking ────────────────────────────────
const LABEL_BONUS: Record<string, number> = {
  function: 1.0,
  component: 1.0,  // React component — same priority as function
  method: 0.9,
  hook: 0.9,       // React custom hook — same priority as method
  class: 0.8,
  type: 0.5,
};
const DEFAULT_LABEL_BONUS = 0.3;

const MAX_HITS_PER_SYMBOL = 2;

// ── Binary search: find symbol containing a given line ─────
function findContainingSymbol(
  symbols: CodeSymbol[],
  line: number,
): CodeSymbol | undefined {
  let lo = 0;
  let hi = symbols.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sym = symbols[mid]!;

    if (line < sym.start_line) {
      hi = mid - 1;
    } else if (line > sym.end_line) {
      lo = mid + 1;
    } else {
      // line is within [start_line, end_line]
      return sym;
    }
  }
  return undefined;
}

// ── Main pipeline ──────────────────────────────────────────
export async function classifyHitsWithSymbols(
  matches: TextMatch[],
  index: CodeIndex,
  bm25Idx: { centrality: Map<string, number> },
): Promise<TextMatch[]> {
  // Edge: empty matches
  if (matches.length === 0) return [];

  // Edge: no symbols — return unclassified
  if (!index.symbols || index.symbols.length === 0) return [...matches];

  // ── Phase 2: Classify ──────────────────────────────────
  // Group symbols by file, sorted by start_line
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const sym of index.symbols) {
    let arr = symbolsByFile.get(sym.file);
    if (!arr) {
      arr = [];
      symbolsByFile.set(sym.file, arr);
    }
    arr.push(sym);
  }
  // Sort each file's symbols by start_line (defensive)
  for (const arr of symbolsByFile.values()) {
    arr.sort((a, b) => a.start_line - b.start_line);
  }

  // Track original hit count per symbol (before dedup)
  const hitCountByKey = new Map<string, number>();

  const classified: TextMatch[] = matches.map((m) => {
    const fileSymbols = symbolsByFile.get(m.file);
    if (!fileSymbols) return m;

    const sym = findContainingSymbol(fileSymbols, m.line);
    if (!sym) return m;

    const inDegree = bm25Idx.centrality.get(m.file) ?? 0;
    const key = `${sym.name}\0${sym.file}`;
    hitCountByKey.set(key, (hitCountByKey.get(key) ?? 0) + 1);

    return {
      ...m,
      containing_symbol: {
        name: sym.name,
        kind: sym.kind,
        start_line: sym.start_line,
        end_line: sym.end_line,
        in_degree: inDegree,
      },
    };
  });

  // ── Phase 3: Dedup ─────────────────────────────────────
  // Group by composite key; unclassified kept as-is
  const groups = new Map<string, TextMatch[]>();
  const unclassified: TextMatch[] = [];

  for (const hit of classified) {
    if (!hit.containing_symbol) {
      unclassified.push(hit);
      continue;
    }
    const key = `${hit.containing_symbol.name}\0${hit.file}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(hit);
  }

  // Keep max MAX_HITS_PER_SYMBOL per function, chosen by content diversity
  const deduped: TextMatch[] = [...unclassified];
  for (const [, hits] of groups) {
    if (hits.length <= MAX_HITS_PER_SYMBOL) {
      deduped.push(...hits);
      continue;
    }
    // Pick most diverse content
    const seen = new Set<string>();
    const picked: TextMatch[] = [];
    for (const h of hits) {
      const trimmed = h.content.trim();
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        picked.push(h);
        if (picked.length >= MAX_HITS_PER_SYMBOL) break;
      }
    }
    // If fewer unique than cap, fill from remaining
    if (picked.length < MAX_HITS_PER_SYMBOL) {
      for (const h of hits) {
        if (!picked.includes(h)) {
          picked.push(h);
          if (picked.length >= MAX_HITS_PER_SYMBOL) break;
        }
      }
    }
    deduped.push(...picked);
  }

  // ── Phase 4: Rank ──────────────────────────────────────
  deduped.sort((a, b) => {
    const scoreA = computeScore(a, hitCountByKey);
    const scoreB = computeScore(b, hitCountByKey);
    return scoreB - scoreA; // descending
  });

  return deduped;
}

function computeScore(
  match: TextMatch,
  hitCountByKey: Map<string, number>,
): number {
  const cs = match.containing_symbol;
  if (!cs) return 0; // unclassified sinks to bottom

  const key = `${cs.name}\0${match.file}`;
  const inDegree = cs.in_degree ?? 0;
  const labelBonus = LABEL_BONUS[cs.kind] ?? DEFAULT_LABEL_BONUS;
  const matchCount = hitCountByKey.get(key) ?? 1;

  return inDegree * 0.5 + labelBonus + matchCount * 0.3;
}
