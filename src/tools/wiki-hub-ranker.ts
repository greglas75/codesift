/**
 * Wiki hub ranker — ranks symbols by file-level PageRank with a builtin-name
 * blocklist gate to keep JS/TS prototype methods out of the hub list when
 * they accidentally collide with project symbols defined in low-importance
 * files. See spec D4 (Layer 2 + Layer 3).
 */
import type { ImportEdge } from "../utils/import-graph.js";
import { buildFilePageRank } from "../utils/import-graph.js";
import type { HubSymbol } from "./wiki-page-generators.js";

export interface RankedHubSymbol extends HubSymbol {
  pagerank: number;
  file_rank: number;
}

export interface RankHubsResult {
  hubs: RankedHubSymbol[];
  degraded_reason?: string;
}

interface HubCandidate {
  name: string;
  file: string;
  role: string;
  callers: number;
  callees: number;
}

/** Rank hubs by file-level PageRank, filtering builtin method names that
 *  only survive on low-importance files. */
export function rankHubsByPageRank(
  edges: ImportEdge[],
  candidates: HubCandidate[],
  options?: { topK?: number; minFileRank?: number },
): RankHubsResult {
  const topK = options?.topK ?? 30;
  if (edges.length === 0) {
    return { hubs: [], degraded_reason: "import_graph_empty" };
  }
  let scores: Map<string, number>;
  try {
    scores = buildFilePageRank(edges);
  } catch {
    return { hubs: [], degraded_reason: "pagerank_unavailable" };
  }
  if (scores.size === 0) {
    return { hubs: [], degraded_reason: "pagerank_unavailable" };
  }
  const sortedFiles = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const fileRank = new Map<string, number>();
  sortedFiles.forEach(([file], idx) => fileRank.set(file, idx + 1));

  const hubs: RankedHubSymbol[] = [];
  for (const c of candidates) {
    const rank = fileRank.get(c.file);
    if (rank === undefined) continue;
    const pr = scores.get(c.file) ?? 0;
    // Blocklist gate (D4 Layer 3): drop builtin names whose file isn't
    // structurally important (file_rank > 20).
    if (JS_BUILTIN_METHOD_NAMES.has(c.name) && rank > 20) continue;
    hubs.push({
      name: c.name,
      file: c.file,
      role: c.role,
      callers: c.callers,
      callees: c.callees,
      pagerank: pr,
      file_rank: rank,
    });
  }
  hubs.sort((a, b) => (b.pagerank - a.pagerank) || (b.callers - a.callers));
  return { hubs: hubs.slice(0, topK) };
}

/** JavaScript / TypeScript prototype method names frequently appearing as
 *  fake callers when extractCallSites misclassifies `obj.method(...)` as a
 *  call to a bare project function. Used to filter hubs whose defining file
 *  is not structurally important (PageRank file_rank > 20). */
export const JS_BUILTIN_METHOD_NAMES: ReadonlySet<string> = new Set([
  // Array.prototype
  "map", "filter", "reduce", "reduceRight", "forEach", "find", "findIndex",
  "findLast", "findLastIndex", "some", "every", "includes", "indexOf",
  "lastIndexOf", "slice", "splice", "concat", "join", "push", "pop",
  "shift", "unshift", "sort", "reverse", "flat", "flatMap", "fill",
  "copyWithin", "entries", "keys", "values", "at",
  // String.prototype (subset)
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll",
  "substring", "substr", "startsWith", "endsWith", "padStart", "padEnd",
  "repeat", "normalize", "toLowerCase", "toUpperCase", "charAt", "charCodeAt",
  "codePointAt",
  // Object.prototype / Object methods commonly reached via .x()
  "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
  // Number/Date common methods
  "now", "parse", "getTime", "getDate", "getMonth", "getFullYear",
  "toFixed", "toPrecision", "toISOString", "toJSON",
  // Promise / Map / Set
  "then", "catch", "finally", "get", "set", "has", "delete", "add", "clear",
  "size",
  // Misc common short names that frequently appear as .x() callsites
  "bind", "call", "apply", "flat",
]);
