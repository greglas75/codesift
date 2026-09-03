// How many indexes may be read into memory at once.
//
// Nothing limited it. Each cold load materialises a whole index — 349 MB and hundreds of thousands
// of objects for the largest repo here — so N concurrent first-touches allocate N times that at
// once, in a process with a fixed heap ceiling. Watched over a quarter of an hour on 2026-09-01 the
// daemon's RSS moved 0.3 GB → 8 GB and then into the OOM crash-loop that left clients with no tools
// for the rest of their sessions.
import { describe, it, expect } from "vitest";
import { withIndexLoadSlot, indexLoadGateState } from "../../src/tools/index-tools/load-gate.js";

const defer = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => { release = r; });
  return { p, release };
};

describe("index load gate", () => {
  it("never runs more than the limit at once", async () => {
    const env = { CODESIFT_INDEX_LOAD_CONCURRENCY: "2" } as NodeJS.ProcessEnv;
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => defer());

    const runs = gates.map((g) =>
      withIndexLoadSlot(async () => {
        running++; peak = Math.max(peak, running);
        await g.p;
        running--;
      }, { env }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(2);
    for (const g of gates) g.release();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("releases the slot when a load throws", async () => {
    // A leaked slot is permanent, and after `limit` of them nothing on this machine could ever load
    // an index again.
    const env = { CODESIFT_INDEX_LOAD_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    await expect(withIndexLoadSlot(async () => { throw new Error("boom"); }, { env })).rejects.toThrow("boom");
    expect(indexLoadGateState().active).toBe(0);
    await expect(withIndexLoadSlot(async () => "ok", { env })).resolves.toBe("ok");
  });

  it("serves waiters FIFO, so the longest-waiting caller goes next", async () => {
    // A stack starves the first arrival under sustained load — precisely the request whose client
    // timeout is closest to firing.
    const env = { CODESIFT_INDEX_LOAD_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    const order: number[] = [];
    const first = defer();
    const running = withIndexLoadSlot(async () => { order.push(0); await first.p; }, { env });
    await new Promise((r) => setTimeout(r, 5));
    const queued = [1, 2, 3].map((n) => withIndexLoadSlot(async () => { order.push(n); }, { env }));
    first.release();
    await Promise.all([running, ...queued]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("can be disabled for a caller who knows better", async () => {
    const env = { CODESIFT_INDEX_LOAD_CONCURRENCY: "0" } as NodeJS.ProcessEnv;
    let concurrent = 0; let peak = 0;
    const gates = Array.from({ length: 4 }, () => defer());
    const runs = gates.map((g) => withIndexLoadSlot(async () => {
      concurrent++; peak = Math.max(peak, concurrent); await g.p; concurrent--;
    }, { env }));
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(4);
    for (const g of gates) g.release();
    await Promise.all(runs);
  });
});
