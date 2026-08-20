// `web-tree-sitter` trees live in the WASM heap; dropping the JS reference frees nothing. The LRU
// evicted with `cache.delete(key)` alone, so every evicted tree leaked WASM memory. That is a fact
// about the code — and the Hono extractors already called `tree.delete()` where this cache did not.
//
// What these tests do NOT claim is causation for the 7,224 `memory access out of bounds` failures
// in the daemon log on 2026-08-18. Two reproductions on the PRE-FIX build came back clean: one repo
// of 15,058 files, then 5 repos x 3 rounds = 41,580 file-indexings in a single process. Zero errors
// both times. Those failures coincided with the machine at 17.6 of 18.4 GB of swap while jetsam was
// killing system daemons, and WASM throws the same error when the heap cannot grow.
//
// So this is a leak fixed on its own merits, not a diagnosis confirmed.
import { describe, it, expect, beforeEach } from "vitest";
import { getCachedParse, setCachedParse, resetParseCache } from "../../src/parser/parse-cache.js";

function fakeTree(freed: string[], id: string) {
  return { delete: () => freed.push(id) } as never;
}

beforeEach(() => resetParseCache());

describe("parse cache releases WASM memory", () => {
  it("frees the evicted tree, not just its map entry", () => {
    const freed: string[] = [];
    // MAX_ENTRIES is 500; fill past it so the least-recently-used entry is evicted.
    for (let i = 0; i < 501; i++) {
      setCachedParse("typescript", `source ${i}`, fakeTree(freed, `t${i}`));
    }
    // The first inserted is the least recently used, so it is the one that goes.
    expect(freed).toContain("t0");
  });

  it("frees everything on reset", () => {
    const freed: string[] = [];
    setCachedParse("typescript", "a", fakeTree(freed, "a"));
    setCachedParse("typescript", "b", fakeTree(freed, "b"));
    resetParseCache();
    expect(freed.sort()).toEqual(["a", "b"]);
  });

  it("does not free a tree that is still cached", () => {
    // The failure mode on the other side: releasing a live tree is a use-after-free in WASM, which
    // is worse than the leak it would fix.
    const freed: string[] = [];
    setCachedParse("typescript", "keep", fakeTree(freed, "keep"));
    expect(getCachedParse("typescript", "keep")).not.toBeNull();
    expect(freed).toEqual([]);
  });

  it("survives a tree that was already released elsewhere", () => {
    // The Hono extractors call `tree.delete()` themselves. A double free must not take the process
    // down over cache housekeeping.
    const exploding = { delete: () => { throw new Error("already freed"); } } as never;
    setCachedParse("typescript", "boom", exploding);
    expect(() => resetParseCache()).not.toThrow();
  });
});
