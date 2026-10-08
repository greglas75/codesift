/**
 * React context graph mapping.
 */
import type { CodeSymbol } from "../types.js";
import { getIndexSummary, streamRepoSymbols } from "./index-tools.js";

// ─────────────────────────────────────────────────────────────
// buildContextGraph — React context flow mapping (Item 10)
// ─────────────────────────────────────────────────────────────

export interface ReactContextInfo {
  name: string;
  created_in: { file: string; line: number };
  providers: { file: string; line: number }[];
  consumers: { file: string; component: string; line: number }[];
}

export interface ContextGraph {
  contexts: ReactContextInfo[];
}

const MAX_CONTEXT_SYMBOLS = 500;

/**
 * Build a graph of React Context flows: createContext → Provider → useContext consumers.
 *
 * Single-pass scan over all symbols (capped at 500). No cycle detection — relies
 * on visited set keyed by context name to prevent re-processing.
 *
 * Detection patterns:
 * - createContext call: `const X = createContext(...)` or `const X = React.createContext(...)`
 * - Provider usage: `<X.Provider value={...}>` (anywhere in any source)
 * - Consumer usage: `useContext(X)` (anywhere in any source)
 *
 * Phase 2 features (not implemented here):
 * - Cycle detection in provider chains
 * - Re-render impact analysis ("which consumers re-render when X changes")
 * - Context value type tracking
 */
export function buildContextGraph(symbols: CodeSymbol[]): ContextGraph {
  const contexts = new Map<string, ReactContextInfo>();
  const createPattern = /\bconst\s+(\w+)\s*(?::[^=]+)?\s*=\s*(?:React\.)?createContext\b/g;

  // Pass 1: Find context definitions
  let scanned = 0;
  for (const sym of symbols) {
    if (scanned >= MAX_CONTEXT_SYMBOLS) break;
    if (!sym.source) continue;
    scanned++;
    let m: RegExpExecArray | null;
    createPattern.lastIndex = 0;
    while ((m = createPattern.exec(sym.source)) !== null) {
      const name = m[1]!;
      if (contexts.has(name)) continue;  // visited — skip duplicate definition
      // Compute line offset within symbol source
      const linesBefore = sym.source.slice(0, m.index).split("\n").length;
      contexts.set(name, {
        name,
        created_in: { file: sym.file, line: sym.start_line + linesBefore - 1 },
        providers: [],
        consumers: [],
      });
    }
  }

  if (contexts.size === 0) return { contexts: [] };

  // Pass 2: Find providers and consumers
  scanned = 0;
  for (const sym of symbols) {
    if (scanned >= MAX_CONTEXT_SYMBOLS) break;
    if (!sym.source) continue;
    if (sym.kind !== "component" && sym.kind !== "hook") continue;
    scanned++;
    for (const [ctxName, info] of contexts) {
      // Provider: <X.Provider
      const providerRe = new RegExp(`<${ctxName}\\.Provider\\b`);
      if (providerRe.test(sym.source)) {
        info.providers.push({ file: sym.file, line: sym.start_line });
      }
      // Consumer: useContext(X)
      const consumerRe = new RegExp(`useContext\\s*\\(\\s*${ctxName}\\b`);
      if (consumerRe.test(sym.source)) {
        info.consumers.push({
          file: sym.file,
          component: sym.name,
          line: sym.start_line,
        });
      }
    }
  }

  return { contexts: [...contexts.values()] };
}

/**
 * `buildContextGraph` over a repository, without materialising its index (ADR-004 stage 2).
 *
 * The graph never looks past two prefixes of the symbol list: pass 1 stops at the first
 * MAX_CONTEXT_SYMBOLS symbols that carry source, pass 2 at the first MAX_CONTEXT_SYMBOLS
 * components/hooks that carry source. So the symbols are streamed in index order, the members of
 * either prefix are kept, and the stream stops once both prefixes are complete. Any symbol that
 * precedes a kept one inside a prefix is itself kept, so each pass meets exactly the sequence it
 * met over the full array, and the graph is the same one.
 *
 * Returns null when the repository is not indexed, mirroring the summary read.
 */
export async function analyzeContextGraph(repo: string): Promise<ContextGraph | null> {
  const summary = await getIndexSummary(repo);
  if (!summary) return null;

  const kept: CodeSymbol[] = [];
  let withSource = 0;
  let renderersWithSource = 0;
  await streamRepoSymbols(repo, { withSource: true }, (batch) => {
    for (const sym of batch) {
      if (!sym.source) continue;
      const inPass1 = withSource < MAX_CONTEXT_SYMBOLS;
      const isRenderer = sym.kind === "component" || sym.kind === "hook";
      const inPass2 = isRenderer && renderersWithSource < MAX_CONTEXT_SYMBOLS;
      if (inPass1) withSource++;
      if (inPass2) renderersWithSource++;
      if (inPass1 || inPass2) kept.push(sym);
      if (withSource >= MAX_CONTEXT_SYMBOLS && renderersWithSource >= MAX_CONTEXT_SYMBOLS) return false;
    }
    return undefined;
  }, { skipFreshness: true });

  return buildContextGraph(kept);
}
