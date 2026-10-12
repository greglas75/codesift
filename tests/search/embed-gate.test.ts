import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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
// A pid that is certainly gone. A constant like 999999 is a valid, assignable pid under Linux's pid_max.
const DEAD_PID = String(spawnSync(process.execPath, ["-e", ""]).pid);
let slotDir: string;
beforeEach(() => { slotDir = join(mkdtempSync(join(tmpdir(), "cs-gate-")), "embed-slots"); });
afterEach(() => rmSync(join(slotDir, ".."), { recursive: true, force: true }));
const opts = (env: NodeJS.ProcessEnv) => ({ env, slotDir });

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
      }, opts(env)),
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

    const a = withEmbedSlot(async () => { order.push("a"); await first.promise; }, opts(env));
    const b = withEmbedSlot(async () => { order.push("b"); }, opts(env));

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
    await expect(withEmbedSlot(async () => { throw new Error("boom"); }, opts(env))).rejects.toThrow("boom");
    expect(embedGateStateForTesting().active).toBe(0);

    let ran = false;
    await withEmbedSlot(async () => { ran = true; }, opts(env));
    expect(ran).toBe(true);
  });

  it("can be turned off for an unmetered provider", async () => {
    const env = { CODESIFT_EMBED_CONCURRENCY: "0" } as NodeJS.ProcessEnv;
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((g) => withEmbedSlot(() => g.promise, opts(env)));
    await new Promise((r) => setTimeout(r, 10));
    expect(embedGateStateForTesting().waiting).toBe(0);
    for (const g of gates) g.resolve();
    await Promise.all(runs);
  });

  it("waits while other processes hold every machine slot, then runs", async () => {
    // The 2026-10-11 collapse: eight embed children, each within its own cap of four, ~30 requests in
    // front of a server that embeds one text at a time. Another live process holding the only slot
    // must hold this one back too.
    const env = { CODESIFT_EMBED_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, "slot-0.lock"), String(process.ppid));

    let ran = false;
    const run = withEmbedSlot(async () => { ran = true; }, opts(env));
    await new Promise((r) => setTimeout(r, 150));
    expect(ran).toBe(false);

    rmSync(join(slotDir, "slot-0.lock"));
    await run;
    expect(ran).toBe(true);
    // Released: nothing left behind for the next process to wait on.
    expect(readdirSync(slotDir)).toEqual([]);
  });

  it("takes over a slot whose holder process is gone", async () => {
    const env = { CODESIFT_EMBED_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, "slot-0.lock"), DEAD_PID);
    let ran = false;
    await withEmbedSlot(async () => { ran = true; }, opts(env));
    expect(ran).toBe(true);
  });

  it("keeps embedding when the machine gate cannot be set up", async () => {
    const env = { CODESIFT_EMBED_CONCURRENCY: "1" } as NodeJS.ProcessEnv;
    writeFileSync(slotDir, "not a directory"); // mkdir of the slot dir fails
    let ran = false;
    await withEmbedSlot(async () => { ran = true; }, opts(env));
    expect(ran).toBe(true);
  });

  it("defaults to 4, matching the common Ollama setting", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    const runs = gates.map((g) => withEmbedSlot(() => g.promise, opts({} as NodeJS.ProcessEnv)));
    await new Promise((r) => setTimeout(r, 10));
    expect(embedGateStateForTesting().active).toBe(4);
    expect(embedGateStateForTesting().waiting).toBe(2);
    for (const g of gates) g.resolve();
    await Promise.all(runs);
  });
});
