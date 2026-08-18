// `web-tree-sitter` trees live in the WASM heap; dropping the JS reference frees nothing. The LRU
// evicted with `cache.delete(key)` alone, so every evicted tree leaked WASM memory until
// `parser.parse()` began throwing `memory access out of bounds` — after which EVERY parse failed,
// including three-line config files, and the import graph fell back to regex.
//
// Measured on this machine 2026-08-18: 7,224 occurrences in one daemon log, 284 of the last 500
// lines. A degradation running continuously with nothing in any tool result to show for it.
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
