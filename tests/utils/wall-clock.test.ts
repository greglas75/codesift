import { describe, it, expect } from "vitest";
import { raceWallClock } from "../../src/utils/wall-clock.js";

describe("raceWallClock", () => {
  it("returns the work result when work resolves before the timeout", async () => {
    const result = await raceWallClock(
      Promise.resolve("ok"),
      1000,
      () => "TIMEOUT",
    );
    expect(result).toBe("ok");
  });

  it("returns the timeout value when work outlasts the cap", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late"), 200),
    );
    const result = await raceWallClock(
      slow,
      20,
      () => ({ truncated: true, hint: "narrow scope" }),
    );
    expect(result).toEqual({ truncated: true, hint: "narrow scope" });
  });

  it("does not throw when the underlying work rejects after the cap", async () => {
    const failing = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("boom")), 200),
    );
    // We want the timeout sentinel to win — adding a noop catch on the
    // underlying promise is the caller's responsibility, but raceWallClock
    // itself should not surface the rejection when timeout fires first.
    failing.catch(() => undefined);
    const result = await raceWallClock(failing, 20, () => "TIMEOUT");
    expect(result).toBe("TIMEOUT");
  });
});
