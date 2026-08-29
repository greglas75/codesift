import { describe, it, expect, afterEach } from "vitest";
import {
  withEmbedSlot,
  embedGateStateForTesting,
  resetEmbedGateForTesting,
} from "../../src/search/embed-gate.js";

/**
 * Nothing limited concurrent embedding requests, and the remote does — OLLAMA_NUM_PARALLEL=4 on the
 * host this machine embeds against. Everything past the fourth queued until it exceeded the client
 * timeout, and the stall-retry answered each timeout by splitting the batch in two, producing MORE
 * requests against the same queue. Measured 2026-08-30: hundreds of `embed batch of N stalled …
 * retrying` lines and a daemon unable to answer /health for fifteen minutes after a restart.
 */
describe("embed concurrency gate", () => {
  afterEach(() => resetEmbedGateForTesting());

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("never runs more than the limit at once", async () => {
    const env = { CODESIFT_EMBED_CONCURRENCY: "2" } as NodeJS.ProcessEnv;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let peak = 0;

    const runs = gates.map((g) =>
      withEmbedSlot(async () => {
        peak = Math.max(peak, embedGateStateForTesting().active);
        await g.promise;
      }, { env }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(embedGateStateForTesting().active).toBe(2);
    expect(embedGateStateForTesting().waiting).toBe(2);

    for (const g of gates) g.resolve();
    await Promise.all(runs);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("lets a waiting caller through when a slot frees", async () => {
    const env = { CODESIFT_EMBED_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    const first = deferred();
    const order: string[] = [];

    const a = withEmbedSlot(async () => { order.push("a"); await first.promise; }, { env });
    const b = withEmbedSlot(async () => { order.push("b"); }, { env });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["a"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("releases the slot when the call THROWS", async () => {
    // A failing batch that kept its slot would shrink the gate by one every time, which under the
    // very timeouts this exists to prevent would deadlock it shut.
    const env = { CODESIFT_EMBED_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    await expect(withEmbedSlot(async () => { throw new Error("boom"); }, { env })).rejects.toThrow("boom");
    expect(embedGateStateForTesting().active).toBe(0);

    let ran = false;
    await withEmbedSlot(async () => { ran = true; }, { env });
    expect(ran).toBe(true);
  });

  it("can be turned off for an unmetered provider", async () => {
    const env = { CODESIFT_EMBED_CONCURRENCY: "0" } as NodeJS.ProcessEnv;
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((g) => withEmbedSlot(() => g.promise, { env }));
    await new Promise((r) => setTimeout(r, 10));
    expect(embedGateStateForTesting().waiting).toBe(0);
    for (const g of gates) g.resolve();
    await Promise.all(runs);
  });

  it("defaults to 4, matching the common Ollama setting", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    const runs = gates.map((g) => withEmbedSlot(() => g.promise, { env: {} as NodeJS.ProcessEnv }));
    await new Promise((r) => setTimeout(r, 10));
    expect(embedGateStateForTesting().active).toBe(4);
    expect(embedGateStateForTesting().waiting).toBe(2);
    for (const g of gates) g.resolve();
    await Promise.all(runs);
  });
});
