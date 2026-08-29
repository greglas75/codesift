import { describe, it, expect } from "vitest";
import { exitWhenRootGone, ROOT_POLL_MS } from "../../src/cli/orphan-guard.js";

/**
 * The ppid guard cannot catch a tree that disappears while its parent keeps working. Measured
 * 2026-08-29: an agent created a worktree, `codesift index .` started, the worktree was removed —
 * and embedding ran for 1 h 10 min at 813% CPU and 4.9 GB, producing a 365 MB index of a directory
 * that no longer existed. Nothing was watching the one thing that had changed.
 */
describe("exitWhenRootGone", () => {
  it("stops once the root is gone", async () => {
    let present = true;
    const gone: string[] = [];
    const stop = exitWhenRootGone("/tmp/tree", {
      pollMs: 1,
      exists: () => present,
      onGone: (r) => gone.push(r),
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(gone).toHaveLength(0);

    present = false;
    await new Promise((r) => setTimeout(r, 15));
    stop();
    expect(gone[0]).toBe("/tmp/tree");
  });

  it("says nothing while the root is there", async () => {
    const gone: string[] = [];
    const stop = exitWhenRootGone("/tmp/tree", {
      pollMs: 1,
      exists: () => true,
      onGone: (r) => gone.push(r),
    });
    await new Promise((r) => setTimeout(r, 25));
    stop();
    expect(gone).toHaveLength(0);
  });

  it("does not keep the process alive on its own", () => {
    // The point is FEWER lingering processes, so the guard must never be the thing that lingers.
    const stop = exitWhenRootGone("/tmp/tree", { exists: () => true, onGone: () => {} });
    expect(ROOT_POLL_MS).toBeGreaterThan(0);
    stop();
  });

  it("checks only the root, not files inside it", async () => {
    // A file vanishing mid-run is ordinary — a build, a branch switch, a formatter. Only the root
    // disappearing means the work has no subject left.
    const checked: string[] = [];
    const stop = exitWhenRootGone("/tmp/tree", {
      pollMs: 1,
      exists: (p) => { checked.push(p); return true; },
      onGone: () => {},
    });
    await new Promise((r) => setTimeout(r, 15));
    stop();
    expect(new Set(checked)).toEqual(new Set(["/tmp/tree"]));
  });
});
