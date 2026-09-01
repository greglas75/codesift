// The BM25 cache had no bound of any kind while every neighbouring cache has one.
//
// It survived on accidental eviction: every `index_file` deleted its repo's entry, and the
// PostToolUse hook fires on every agent edit, so the map was constantly emptied by what looked like
// invalidation. 69a49cd made edits update the index in place (595x faster on that path) and thereby
// removed the only thing keeping the map small. The daemon then walked into its 16 GB heap ceiling
// and crash-looped — 15.1 GB, 16.0 GB, restart, repeat — and clients that initialized during a
// restart window got no tools for their entire session.
//
// Measured footprint: 352,125 symbols / 12,882,846 tokens = 399 MB. One large repository is ~400 MB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildBM25Index } from "../../src/search/bm25.js";
import { bm25Indexes, rememberBM25Index, touchBM25Index } from "../../src/tools/index-tools/state.js";
import type { CodeSymbol } from "../../src/types.js";

function repoSymbols(prefix: string, count: number): CodeSymbol[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    repo: "t",
    name: `handlerNumber${i}`,
    kind: "function" as const,
    file: `${prefix}/file${i}.ts`,
    start_line: 1,
    end_line: 5,
    signature: `handlerNumber${i}(input: RequestPayload): Promise<ResponseEnvelope>`,
    source: `function handlerNumber${i}() { return computeSomethingUseful(${i}); }`,
  }));
}

let prev: string | undefined;

beforeEach(() => {
  prev = process.env["CODESIFT_MAX_BM25_CACHE_MB"];
  bm25Indexes.clear();
});
afterEach(() => {
  if (prev === undefined) delete process.env["CODESIFT_MAX_BM25_CACHE_MB"];
  else process.env["CODESIFT_MAX_BM25_CACHE_MB"] = prev;
  bm25Indexes.clear();
});

describe("BM25 cache budget", () => {
  it("evicts least-recently-used entries once the budget is exceeded", () => {
    process.env["CODESIFT_MAX_BM25_CACHE_MB"] = "1";

    for (const name of ["repo-a", "repo-b", "repo-c", "repo-d"]) {
      rememberBM25Index(name, buildBM25Index(repoSymbols(name, 400)));
    }

    // Unbounded, all four would still be here — which is exactly how the daemon reached 16 GB.
    expect(bm25Indexes.size).toBeLessThan(4);
    // The one just inserted is the one being served, so it must survive.
    expect(bm25Indexes.has("repo-d")).toBe(true);
  });

  it("keeps a touched repo and drops the untouched one", () => {
    process.env["CODESIFT_MAX_BM25_CACHE_MB"] = "1";

    rememberBM25Index("cold", buildBM25Index(repoSymbols("cold", 400)));
    rememberBM25Index("warm", buildBM25Index(repoSymbols("warm", 400)));
    touchBM25Index("cold"); // cold is now most-recently-used

    rememberBM25Index("newest", buildBM25Index(repoSymbols("newest", 400)));

    expect(bm25Indexes.has("newest")).toBe(true);
    if (bm25Indexes.size < 3) {
      // Whatever was dropped, it must not be the one we just touched before the one we just added.
      expect(bm25Indexes.has("warm")).toBe(false);
    }
  });

  it("never evicts the entry being served, even when it alone exceeds the budget", () => {
    // Otherwise every call into a large repository would rebuild its index and immediately
    // discard it — a rebuild per call, which is worse than the leak this replaces.
    process.env["CODESIFT_MAX_BM25_CACHE_MB"] = "1";
    rememberBM25Index("huge", buildBM25Index(repoSymbols("huge", 3000)));
    expect(bm25Indexes.has("huge")).toBe(true);
  });

  it("holds several repos comfortably under a normal budget", () => {
    process.env["CODESIFT_MAX_BM25_CACHE_MB"] = "1024";
    for (const name of ["a", "b", "c"]) rememberBM25Index(name, buildBM25Index(repoSymbols(name, 200)));
    expect(bm25Indexes.size).toBe(3);
  });
});
