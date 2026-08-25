import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../src/tools/secret-tools.ts", import.meta.url), "utf-8");

/**
 * The scan walked every indexed file with no ceiling and no abort check — measured at 27.9s and
 * 10,533 findings on this repo, with a telemetry p90 of 23.4s. The tool-level timeout above it does
 * not stop the loop; it answers `timed_out` and lets the work run on, which is how this exact tool
 * reached 5.1 hours against a 90-second budget.
 */
describe("scan_secrets scan budget", () => {
  it("honours the client abort signal", () => {
    expect(src).toContain("currentAbortSignal");
    expect(src).toMatch(/abortSignal\?\.aborted/);
  });

  it("has a wall-clock ceiling inside the 90s tool timeout", () => {
    const m = /SCAN_BUDGET_MS = ([\d_]+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ""))).toBeLessThan(90_000);
  });

  // The one wrong answer a secret scanner must never give is a false all-clear. A scan that stopped
  // early has not seen the rest of the repo, so it cannot report "full" — whatever the cache holds.
  it("never reports full coverage after stopping early", () => {
    expect(src).toMatch(/if \(stoppedEarly\) scanCoverage =/);
  });

  it("says the unscanned files are not known to be clean", () => {
    expect(src).toMatch(/NOT known to be clean/);
  });
});
