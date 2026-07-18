import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const GIB = 1024 ** 3;

// Mock node:os so we can drive totalmem(). homedir() stays real for config's
// dataDir default. mockedTotal is set per-test.
let mockedTotal = 128 * GIB;
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, totalmem: () => mockedTotal };
});

const { localEmbeddingsDisabled, embeddingMemBudgetBytes } = await import("../../src/config.js");

const ENV = ["CODESIFT_DISABLE_LOCAL_EMBEDDINGS", "CODESIFT_MAX_EMBEDDING_MEM_MB"];

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
