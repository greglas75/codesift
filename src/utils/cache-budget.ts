/**
 * Byte-budget eviction shared by the caches whose entries live in Rust memory (the native call graph,
 * native vector sets): V8 cannot see those bytes, so each cache prices its entries and evicts by this rule.
 */

/**
 * Which cached entries to drop, oldest first, until the finished ones fit `budget`. `entries` is in
 * use order (oldest first); a build still in flight has no size yet and is neither counted nor
 * dropped, and neither the newest entry nor `keep` is dropped — evicting what a caller just asked for
 * would rebuild it on the next call. So the result can stay over budget when those alone exceed it.
 */
export function entriesOverBudget(
  entries: ReadonlyArray<{ key: string; bytes: number | undefined }>,
  budget: number,
  /** The key the caller is about to return — kept wherever it sits in the order. */
  keep?: string,
): string[] {
  let total = 0;
  for (const e of entries) total += e.bytes ?? 0;
  const out: string[] = [];
  for (const e of entries.slice(0, -1)) {
    if (total <= budget) break;
    if (e.bytes === undefined || e.key === keep) continue;
    out.push(e.key);
    total -= e.bytes;
  }
  return out;
}
