import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const GIB = 1024 ** 3;

// Mock node:os so we can drive totalmem(). homedir() stays real for config's
// dataDir default. mockedTotal is set per-test.
let mockedTotal = 128 * GIB;
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, totalmem: () => mockedTotal };
});

const { localEmbeddingsDisabled, embeddingMemBudgetBytes, indexCacheMemBudgetBytes } =
  await import("../../src/config.js");

const ENV = [
  "CODESIFT_DISABLE_LOCAL_EMBEDDINGS",
  "CODESIFT_MAX_EMBEDDING_MEM_MB",
  "CODESIFT_MAX_INDEX_CACHE_MB",
];

describe("low-RAM protection (auto-lite + RAM-aware cache budget)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    mockedTotal = 128 * GIB;
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("auto-disables the local model on a 16 GB machine", () => {
    mockedTotal = 16 * GIB;
    expect(localEmbeddingsDisabled()).toBe(true);
  });

  it("keeps the local model on a 128 GB machine", () => {
    mockedTotal = 128 * GIB;
    expect(localEmbeddingsDisabled()).toBe(false);
  });

  it("explicit =0 forces the model on even on a tiny machine", () => {
    mockedTotal = 8 * GIB;
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "0";
    expect(localEmbeddingsDisabled()).toBe(false);
  });

  it("explicit =1 forces lite even on a big machine", () => {
    mockedTotal = 128 * GIB;
    process.env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "1";
    expect(localEmbeddingsDisabled()).toBe(true);
  });

  it("scales the cache budget down on small machines", () => {
    mockedTotal = 16 * GIB;
    expect(embeddingMemBudgetBytes()).toBe(256 * 1024 * 1024);
    mockedTotal = 64 * GIB;
    expect(embeddingMemBudgetBytes()).toBe(1024 * 1024 * 1024);
  });

  it("explicit CODESIFT_MAX_EMBEDDING_MEM_MB overrides the scaled default", () => {
    mockedTotal = 16 * GIB;
    process.env.CODESIFT_MAX_EMBEDDING_MEM_MB = "2048";
    expect(embeddingMemBudgetBytes()).toBe(2048 * 1024 * 1024);
  });
});

/**
 * The tiers used to stop at 1024 MB above 32 GB, so a 33 GB laptop and a 128 GB
 * workstation hosting a hundred projects got the same budget. On the big machine
 * that is a LATENCY bug: indexes are ~350 MB, three fit, and a call into an
 * evicted repo pays a cold load — measured at 70.4 s for a 51k-symbol repo,
 * against Claude Code's 30 s connect timeout. The client says "failed to
 * connect"; nothing is broken, the answer just arrives too late.
 */
describe("cache budgets scale past the old 32 GB ceiling", () => {
  const MB = (bytes: number) => bytes / 1024 / 1024;

  it("gives a big machine more than a laptop", () => {
    mockedTotal = 128 * GIB;
    expect(MB(indexCacheMemBudgetBytes())).toBe(4096);
    expect(MB(embeddingMemBudgetBytes())).toBe(2048);
  });

  it("weights the index cache above embeddings — its miss is the one that times out", () => {
    mockedTotal = 128 * GIB;
    expect(MB(indexCacheMemBudgetBytes())).toBeGreaterThan(MB(embeddingMemBudgetBytes()));
  });

  it("leaves small machines exactly as they were", () => {
    for (const [ram, expected] of [[8, 256], [16, 256], [32, 512]] as const) {
      mockedTotal = ram * GIB;
      expect(MB(indexCacheMemBudgetBytes())).toBe(expected);
      expect(MB(embeddingMemBudgetBytes())).toBe(expected);
    }
  });

  it("never drops below the previous 1024 MB for anything above 32 GB", () => {
    // A 33 GB machine used to get 1024; scaling alone would have given it less,
    // which would be a regression dressed as an improvement.
    mockedTotal = 33 * GIB;
    expect(MB(indexCacheMemBudgetBytes())).toBeGreaterThanOrEqual(1024);
    expect(MB(embeddingMemBudgetBytes())).toBeGreaterThanOrEqual(1024);
  });

  it("caps, so a huge host cannot hand the whole machine to caches", () => {
    mockedTotal = 1024 * GIB;
    expect(MB(indexCacheMemBudgetBytes())).toBe(8192);
    expect(MB(embeddingMemBudgetBytes())).toBe(4096);
  });

  it("still lets an explicit setting win", () => {
    mockedTotal = 128 * GIB;
    process.env["CODESIFT_MAX_INDEX_CACHE_MB"] = "777";
    expect(MB(indexCacheMemBudgetBytes())).toBe(777);
  });
});
