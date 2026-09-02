// How long one page of an index read is allowed to hold the daemon's only thread.
//
// `node:sqlite` is synchronous by design — DatabaseSync and StatementSync are the entire module,
// there is no async class to switch to — so a page is a blocking syscall for as long as the disk
// takes. The reader pages and yields between pages, which bounds the stall to ONE page; the page
// size is therefore the latency floor for every other client, the `initialize` handshake included.
//
// The feedback loop aims each page at 50 ms. Its floor was 500 rows, which held while pages were
// slow for CPU reasons (GC, allocation vary by ~an order of magnitude) and did not hold when the
// DISK was the slow part. Measured 2026-09-02 with 21 concurrent `npm ci`: 50,835 IOPS at ~6.9 KB
// each, the daemon in state `U`, `initialize` at 40 s, and clients spending the rest of their
// session with no CodeSift tools.
import { describe, it, expect } from "vitest";
import { nextPageRows } from "../../src/storage/sqlite/index-io.js";

describe("page sizing under a slow disk", () => {
  it("shrinks far below the old 500-row floor when pages run long", () => {
    // A page of 4,000 rows that took 4 s is the saturated-disk case. The old floor could only ask
    // for 500 — still ~500 ms of blocking, which is what made the handshake time out.
    expect(nextPageRows(4_000, 4_000)).toBeLessThan(500);
  });

  it("bottoms out at a page the daemon can afford, not at seconds", () => {
    // At 2 ms per row — a disk roughly 100x slower than a warm page cache — the budget wants 25
    // rows and the floor allows 50, so one page blocks for ~100 ms. That is the honest guarantee:
    // not the 50 ms target, but two orders of magnitude below the multi-second pages measured
    // during the incident, and short enough that a handshake queued behind one still answers.
    const msPerRow = 2;
    let rows = 50;
    for (let i = 0; i < 12; i++) rows = nextPageRows(rows, rows * msPerRow);
    expect(rows).toBe(50);
    expect(rows * msPerRow).toBeLessThanOrEqual(120);

    // The old floor is what made this unaffordable: 500 rows at the same per-row cost is a full
    // second of blocking per page, and there was no way for the loop to ask for less.
    expect(500 * msPerRow).toBeGreaterThan(500);
  });

  it("never asks for a single row — per-row yielding was measured to take minutes", () => {
    expect(nextPageRows(50, 100_000)).toBeGreaterThanOrEqual(50);
  });

  it("still ramps up on a fast disk, so the smaller first page costs only a page or two", () => {
    let rows = 50;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) { rows = nextPageRows(rows, 1); seen.push(rows); }
    expect(seen[0]).toBeGreaterThan(1_000);
    expect(rows).toBe(20_000);
  });

  it("is bounded above, so one fast page cannot ask for the whole table", () => {
    expect(nextPageRows(20_000, 1)).toBe(20_000);
  });

  it("treats a zero-millisecond page as one millisecond rather than dividing by zero", () => {
    expect(Number.isFinite(nextPageRows(500, 0))).toBe(true);
  });
});
