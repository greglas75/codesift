import type { NativeBm25Handle } from "../../native/index.js";
import { wrapNativeBM25, type NativeBM25Index } from "../../search/bm25.js";
import type { CodeSymbol } from "../../types.js";

/**
 * A native BM25 index over `repo` that holds no symbols: hits are read from the store by id, in index
 * order, so a colliding id ends on its last row — the entry an index-ordered Map holds.
 */
export function storeBackedBM25(native: NativeBm25Handle, repo: string): NativeBM25Index {
  return wrapNativeBM25(native, new Map(), async (ids) => {
    // narrow-reads → registry → this module: loaded at call time, keeping the cycle out of module evaluation.
    const { findRepoSymbolsByRequestedIds } = await import("./narrow-reads.js");
    const byId = new Map<string, CodeSymbol>();
    for (const symbol of await findRepoSymbolsByRequestedIds(repo, ids, { withSource: true, skipFreshness: true })) {
      byId.set(symbol.id, symbol);
    }
    return byId;
  });
}

