// Refusing to start a cold index load while the daemon cannot afford one.
//
// A cold getCodeIndex reads a whole index into memory — 349 MB and hundreds of thousands of objects
// for the largest repo here — through a SYNCHRONOUS SQLite API. With the disk saturated (measured
// 2026-09-02: 50,835 IOPS at ~6.9 KB, process in uninterruptible I/O) that read takes minutes and
// every other client waits behind it. The caller then hits its own 120 s timeout and reports
// "CODESIFT UNAVAILABLE", so the session runs with NO tools — the worst available outcome, and
// avoidable, because BM25 and the resident caches still answer in milliseconds.
import { describe, it, expect } from "vitest";
import {
  assessOverload, DaemonOverloadedError, isOverloadedError,
} from "../../src/tools/index-tools/overload-guard.js";

const healthy = {
  event_loop_lag_ms: 5, heap_used_mb: 500, heap_limit_mb: 16_384,
  heap_used_pct: 3, rss_mb: 900, uptime_s: 3_600,
};

describe("overload guard", () => {
  it("allows a cold load on a healthy daemon", () => {
    expect(assessOverload(healthy).refuse).toBe(false);
  });

  it("does not fire on the ordinary lag of a large read", () => {
    // A few hundred milliseconds is normal while any big index is being paged in. Refusing there
    // would make an index that can never be loaded, which is worse than one that loads slowly.
    expect(assessOverload({ ...healthy, event_loop_lag_ms: 400 }).refuse).toBe(false);
  });

  it("refuses when the loop is already oversubscribed", () => {
    const d = assessOverload({ ...healthy, event_loop_lag_ms: 8_000 });
    expect(d.refuse).toBe(true);
    expect(d.reason).toMatch(/block every other client/);
  });

  it("refuses near the heap ceiling — an OOM restart drops every call, not just this one", () => {
    const d = assessOverload({ ...healthy, heap_used_mb: 14_000, heap_used_pct: 90 });
    expect(d.refuse).toBe(true);
    expect(d.reason).toMatch(/OOM restart/);
  });

  it("tells the agent what still works, so it degrades instead of giving up", () => {
    // The whole point: an agent that reads "unavailable" stops using tools it could still use.
    const msg = new DaemonOverloadedError("local/big", "the loop is 8000 ms behind").message;
    expect(msg).toMatch(/text and symbol search, outlines and file trees still answer/);
    expect(msg).toMatch(/Retry this one in a few seconds/);
    expect(msg).toMatch(/local\/big/);
  });

  it("is detected structurally, not by instanceof", () => {
    // A duplicated module instance across a worker or bundler boundary breaks instanceof and would
    // silently reclassify this as an unknown fault — the same reasoning as AmbiguousSymbolIdError.
    expect(isOverloadedError(new DaemonOverloadedError("r", "why"))).toBe(true);
    expect(isOverloadedError({ overloaded: true })).toBe(true);
    expect(isOverloadedError(new Error("something else"))).toBe(false);
    expect(isOverloadedError(null)).toBe(false);
  });
});
