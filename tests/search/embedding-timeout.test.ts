// The embed deadline used to be a flat 30s for every request regardless of size, and the comment
// above it already described the failure that caused — batches aborting mid-flight and the caller
// then writing nothing. It happened for real: designer's chunk pass died on "The operation was
// aborted due to timeout" AFTER its symbol pass had written 3.6 GB.
//
// Chunks failed where symbols did not despite a SMALLER batch (96 vs 128), because cost tracks
// total input SIZE, not item count. Measured on this machine under load (Ollama + embeddinggemma):
// 96 chunks / 98,605 chars → 17.5s against a 30s ceiling.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV = "CODESIFT_EMBEDDING_TIMEOUT_MS";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env[ENV];
  delete process.env[ENV];
});

afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

// The module reads the env var once at load, so each case that cares about it needs the module
// evaluated again. `vi.resetModules()` is what does that — a cache-busting query string on the
// import specifier does not survive Vite's static analysis ("Unknown variable dynamic import").
async function freshTimeout(): Promise<(texts: readonly string[]) => number> {
  vi.resetModules();
  const mod = await import("../../src/search/semantic.js");
  return mod.embeddingTimeoutMs;
}

describe("embeddingTimeoutMs", () => {
  it("stays at essentially the 30s floor for a single short query", async () => {
    const timeout = await freshTimeout();
    // 30s is a BASE, not a clamp, so a 32-character query lands a hair above it.
    // Asserting exact equality here would be asserting that short inputs are free.
    const ms = timeout(["what does the auth middleware do"]);
    expect(ms).toBeGreaterThanOrEqual(30_000);
    expect(ms).toBeLessThan(30_100);
  });

  it("gives the measured 96-chunk batch far more than the 17.5s it took", async () => {
    const timeout = await freshTimeout();
    // 96 chunks averaging 1,027 chars — the batch that actually timed out at 30s.
    const batch = Array.from({ length: 96 }, () => "x".repeat(1027));
    const ms = timeout(batch);

    expect(ms).toBeGreaterThan(30_000);          // strictly more than the old flat value
    expect(ms).toBeGreaterThan(17_500 * 3);      // real margin over the measurement, not a nudge
    expect(ms).toBeLessThan(150_000);            // but still a deadline, not "forever"
  });

  it("scales with characters, not with the number of items", async () => {
    const timeout = await freshTimeout();
    const fewLong = timeout([("x".repeat(10_000))]);
    const manyShort = timeout(Array.from({ length: 100 }, () => "x".repeat(100)));

    // Same 10,000 characters either way — this is the property chunks vs symbols turned on.
    expect(fewLong).toBe(manyShort);
  });

  it("is monotonic in size", async () => {
    const timeout = await freshTimeout();
    const small = timeout([("x".repeat(1_000))]);
    const large = timeout([("x".repeat(500_000))]);
    expect(large).toBeGreaterThan(small);
  });

  it("caps rather than growing without bound", async () => {
    const timeout = await freshTimeout();
    // 50 MB of input would be ~35,000s unbounded.
    expect(timeout([("x".repeat(50_000_000))])).toBe(900_000);
  });

  it("an explicit CODESIFT_EMBEDDING_TIMEOUT_MS overrides the scaling entirely", async () => {
    process.env[ENV] = "5000";
    const timeout = await freshTimeout();

    expect(timeout(["short"])).toBe(5_000);
    expect(timeout(Array.from({ length: 96 }, () => "x".repeat(1027)))).toBe(5_000);
  });

  it("ignores a non-numeric or non-positive override instead of disabling the deadline", async () => {
    for (const bad of ["not-a-number", "0", "-1"]) {
      process.env[ENV] = bad;
      const timeout = await freshTimeout();
      const ms = timeout(["short"]);
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThan(30_100);
    }
  });
});
