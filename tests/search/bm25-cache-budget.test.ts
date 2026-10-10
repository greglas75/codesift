// Bug it catches: the BM25 budget stopped at 1 GB on any machine, below one 1.43M-symbol index
// (1.49 GB), so sessions on different worktrees evicted each other into a ~20 s rebuild per switch.
import { describe, expect, it } from "vitest";
import { bm25CacheBudgetBytes } from "../../src/search/bm25.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("bm25CacheBudgetBytes", () => {
  it.each([
    ["16 GB", 16 * GB, 256 * MB],
    ["32 GB", 32 * GB, 512 * MB],
    ["48 GB keeps the 1 GB floor", 48 * GB, 1536 * MB],
    ["128 GB scales to RAM/32", 128 * GB, 4096 * MB],
    ["512 GB caps at 8 GB", 512 * GB, 8192 * MB],
  ])("%s", (_case, total, expected) => {
    expect(bm25CacheBudgetBytes({}, total)).toBe(expected);
  });

  it("lets CODESIFT_MAX_BM25_CACHE_MB win", () => {
    expect(bm25CacheBudgetBytes({ CODESIFT_MAX_BM25_CACHE_MB: "300" }, 128 * GB)).toBe(300 * MB);
  });
});
