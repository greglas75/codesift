import { describe, expect, it } from "vitest";
import { DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_PREPARE_TIMEOUT_MS } from "../../src/tools/review-diff/constants.js";
import { withTimeout } from "../../src/tools/review-diff/timeout.js";

/**
 * review_diff's checks were bounded and the phase before them was not. That matters because the
 * tool-level timeout above it is not a safe backstop: it answers `timed_out` and lets the work keep
 * running (the pathology behind RequestContext.abortSignal — scan_secrets measured at 5.1 hours
 * against a 90-second budget). An unbounded phase under such a ceiling is how a call becomes an
 * orphan that nobody is waiting for.
 */
describe("review_diff preparation budget", () => {
  it("leaves room for a full round of checks inside the 90s client timeout", () => {
    expect(DEFAULT_PREPARE_TIMEOUT_MS + DEFAULT_CHECK_TIMEOUT_MS).toBeLessThan(90_000);
  });

  it("is a real ceiling, not a formality", () => {
    expect(DEFAULT_PREPARE_TIMEOUT_MS).toBeGreaterThan(10_000);
  });

  it("withTimeout resolves the sentinel rather than hanging", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20)).resolves.toEqual({ status: "timeout" });
  });

  it("lets work that finishes in time through untouched", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1_000)).resolves.toBe("done");
  });
});
