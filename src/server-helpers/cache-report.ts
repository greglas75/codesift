/**
 * What the process is holding, per cache, priced the same way each cache prices itself.
 *
 * Every long-lived cache here has a documented budget, and on 2026-09-27 the daemon reached
 * 15,194 MB of a 16,384 MB heap while those budgets summed to about 3.3 GB. Attributing the
 * difference took an afternoon of reading modules and writing standalone probes, because `/health`
 * reports heap TOTAL and nothing about who holds it — so the only way to ask "which cache" was to
 * reproduce each one outside the process and extrapolate.
 *
 * Two of the four things that afternoon found were caches with no bound at all, and neither was
 * visible from outside. The point of this report is that the next such question is a curl, not an
 * investigation:
 *
 *   - `entries` is what a count-based bound would have measured, and is the number that misleads;
 *   - `bytes` is each cache's OWN estimate — the one its eviction acts on. Where the two disagree
 *     with reality the estimate is what matters, because the estimate is what evicts.
 *
 * DO NOT read `vitals.heap_used_mb` minus the sum of these as "unattributed retention". `heapUsed`
 * includes garbage that has not been collected yet, and this process allocates heavily per call —
 * measured 103 s after a restart: heap 3,352 MB against 1,187 MB of priced caches, on a daemon that
 * was holding exactly one index and one BM25 index. Comparing the two is only meaningful after a
 * forced GC, which /health deliberately does not do (a synchronous full GC on a 16 GB heap is its own
 * outage). These numbers answer "which cache is growing, and is its own bound working" — a question
 * that needs a series of samples, not one.
 *
 * `bytes` is deliberately absent, not zero, for a cache that prices nothing: a zero here would read
 * as "holds nothing" when it means "nobody counted", which is the same mistake as an unknown result
 * shape counting as an empty result in the telemetry.
 */
export interface CacheReportEntry {
  entries: number;
  bytes?: number;
}

export type CacheReport = Record<string, CacheReportEntry>;

export async function readCacheReport(): Promise<CacheReport> {
  const report: CacheReport = {};
  try {
    const state = await import("../tools/index-tools/state.js");
    const stats = state.cacheEntryCounts();
    report["code_indexes"] = { entries: stats.indexes, bytes: stats.index_bytes };
    report["code_bm25"] = { entries: stats.bm25, bytes: stats.bm25_bytes };
    report["embeddings"] = { entries: stats.embeddings };
  } catch { /* a cache that cannot be read is reported by its absence */ }
  try {
    const conv = await import("../tools/conversation-cache.js");
    const stats = conv.conversationCacheStats();
    report["conversation_bm25"] = { entries: stats.bm25, bytes: stats.bm25_bytes };
    report["conversation_embeddings"] = { entries: stats.embeddings };
  } catch { /* ditto */ }
  try {
    const gate = await import("../tools/index-tools/load-gate.js");
    const { active, waiting } = gate.indexLoadGateState();
    report["index_load_gate"] = { entries: active + waiting };
  } catch { /* ditto */ }
  return report;
}
