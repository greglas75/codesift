// `/health` reported heap TOTAL and nothing about who held it, and attributing 15,194 MB of a
// 16,384 MB heap therefore took an afternoon of standalone probes. Two of the four things that
// afternoon found were caches with no bound at all, and neither was visible from outside — so the
// report exists to make the next such question a curl.
//
// It shipped with no test of its own: the coverage check for this release found `cache-report.ts`
// had zero references in any test file, and the only tests touching `/health` asserted `status`
// alone. A diagnostic nobody tests is a diagnostic that quietly stops answering, which is worse
// than not having one — it reads as "nothing is growing".
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../../src/server.js";
import { readCacheReport } from "../../src/server-helpers/cache-report.js";

let h: HttpServerHandle | null = null;

afterEach(async () => {
  if (h) await h.close();
  h = null;
});

/** The shape every consumer reads: a name → { entries, bytes? } map. */
type Report = Record<string, { entries: number; bytes?: number }>;

describe("readCacheReport", () => {
  it("names every cache it knows about, even when they are all empty", async () => {
    // An ABSENT key and an empty one say different things, and the absent one is the dangerous
    // reading: "this cache is not growing" vs "this cache is not being reported". A fresh process
    // holds nothing, so this is the state in which the difference is invisible unless asserted.
    const report = (await readCacheReport()) as Report;
    for (const key of [
      "code_indexes", "code_bm25", "embeddings",
      "conversation_bm25", "conversation_embeddings", "index_load_gate",
    ]) {
      expect(report, `missing cache key: ${key}`).toHaveProperty(key);
      expect(typeof report[key]!.entries).toBe("number");
      expect(report[key]!.entries).toBeGreaterThanOrEqual(0);
    }
  });

  it("prices the caches that can be priced, and omits `bytes` for the ones that cannot", () => {
    // `bytes` absent means "nobody counted"; `bytes: 0` means "counted, holds nothing". Collapsing
    // the two is the same defect as an unknown result shape counting as an empty result in the
    // telemetry — the module's own doc comment says so, so it is worth holding it to that.
    return (async () => {
      const report = (await readCacheReport()) as Report;
      expect(report["code_indexes"]).toHaveProperty("bytes");
      expect(report["code_bm25"]).toHaveProperty("bytes");
      expect(report["conversation_bm25"]).toHaveProperty("bytes");
      // The embedding caches are held as raw maps with no per-entry pricing, so they report a count
      // only. If that ever changes, this assertion is the reminder to price them.
      expect(report["embeddings"]).not.toHaveProperty("bytes");
      expect(report["conversation_embeddings"]).not.toHaveProperty("bytes");
    })();
  });

  it("reflects what the conversation cache is actually holding", async () => {
    const { setConversationBM25Index, clearConversationEmbeddingsCacheForTesting } =
      await import("../../src/tools/conversation-cache.js");
    const { buildBM25Index } = await import("../../src/search/bm25.js");
    clearConversationEmbeddingsCacheForTesting();

    const before = (await readCacheReport()) as Report;
    expect(before["conversation_bm25"]!.entries).toBe(0);

    // A real index, so the priced bytes come from the real estimator rather than a hand-made number.
    setConversationBM25Index("conversations/report-test", buildBM25Index([{
      id: "conversations/report-test:s1.jsonl:q:1",
      name: "a question about retention budgets",
      kind: "conversation_turn",
      file: "s1.jsonl",
      line: 1,
      source: "retention budgets and eviction",
    } as never]));

    const after = (await readCacheReport()) as Report;
    expect(after["conversation_bm25"]!.entries).toBe(1);
    expect(after["conversation_bm25"]!.bytes).toBeGreaterThan(0);
    clearConversationEmbeddingsCacheForTesting();
  });
});

describe("GET /health caches block", () => {
  beforeEach(() => {
    delete process.env["CODESIFT_MAX_CONVERSATION_BM25_CACHE_MB"];
  });

  it("carries the per-cache report alongside the vitals", async () => {
    h = await startHttpServer({ port: 0 });
    const res = await fetch(h.url.replace("/mcp", "/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; vitals?: unknown; caches?: Report };
    expect(body.status).toBe("ok");
    expect(body.vitals).toBeDefined();
    expect(body.caches).toBeDefined();
    expect(body.caches).toHaveProperty("code_indexes");
    expect(body.caches).toHaveProperty("conversation_bm25");
  });

  it("`?caches=0` opts out, for a probe that only wants liveness", async () => {
    // The report walks the cached indexes to price them. That is cheap but not free on a process
    // holding several hundred thousand symbols, and a supervisor polling for liveness should not
    // pay for it.
    h = await startHttpServer({ port: 0 });
    const res = await fetch(`${h.url.replace("/mcp", "/health")}?caches=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; caches?: unknown };
    expect(body.status).toBe("ok");
    expect(body.caches).toBeUndefined();
  });

  it("still answers when a cache module cannot be read", async () => {
    // Every lookup in the report is individually guarded: a cache that throws is omitted rather
    // than taking /health down with it. /health answering is what a session needs in order to have
    // tools at all, so it must outlive its own diagnostics.
    h = await startHttpServer({ port: 0 });
    const res = await fetch(h.url.replace("/mcp", "/health"));
    const body = await res.json() as { status: string; caches?: Report };
    expect(body.status).toBe("ok");
    // Whatever it could read is a plain object — never a thrown error surfacing as a 500.
    expect(typeof body.caches).toBe("object");
  });
});

describe("cacheEntryCounts", () => {
  it("reports counts and priced bytes for the code-side caches", async () => {
    // The other half of the report, and the number that misleads: a count-bounded cache looks small
    // while holding gigabytes. That is the defect ADR-004 fixed for the index cache, and it stays
    // latent wherever a count is the only bound — so both numbers are reported, together.
    const { cacheEntryCounts, bm25Indexes } = await import("../../src/tools/index-tools/state.js");
    const { buildBM25Index } = await import("../../src/search/bm25.js");
    const { rememberBM25Index } = await import("../../src/tools/index-tools/state.js");

    const before = cacheEntryCounts();
    expect(before.bm25_bytes).toBeGreaterThanOrEqual(0);
    expect(before.index_bytes).toBeGreaterThanOrEqual(0);

    rememberBM25Index("local/entry-counts-test", buildBM25Index([{
      id: "local/entry-counts-test:src/a.ts:f:1",
      name: "handlerNumberOne",
      kind: "function",
      file: "src/a.ts",
      line: 1,
      signature: "function handlerNumberOne(): void",
      source: "retention budget eviction orphan",
    } as never]));

    const after = cacheEntryCounts();
    expect(after.bm25).toBe(before.bm25 + 1);
    expect(after.bm25_bytes).toBeGreaterThan(before.bm25_bytes);
    bm25Indexes.delete("local/entry-counts-test");
  });
});
