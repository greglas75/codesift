// "No hotspots found" must not be what a FAILED git call looks like.
//
// `getGitChurn` returns an empty map when git fails, and builds a `note` saying so. The formatter's
// parameter type did not have a `note` field at all, so the note could never be printed: a timed-out
// `git log` came back as "(no hotspots found, period: last 180 days)" — a confident finding about a
// repository with six months of dense history. The daemon log held 138 of those failures.
import { describe, it, expect } from "vitest";
import { formatHotspots } from "../../src/formatters-core.js";
import { formatHotspotsCompact } from "../../src/formatters-shortening.js";

describe("empty hotspots", () => {
  for (const [name, format] of [["core", formatHotspots], ["compact", formatHotspotsCompact]] as const) {
    it(`${name}: says WHY when the result is empty because something failed`, () => {
      const out = format({
        hotspots: [], period: "last 180 days",
        note: "git log failed: Command failed: git log --numstat",
      });
      expect(out).toMatch(/no hotspots found/);
      expect(out).toMatch(/git log failed/);
    });

    it(`${name}: stays terse when the repository genuinely has none`, () => {
      // A quiet repository is a real answer and must not be dressed up as a fault.
      expect(format({ hotspots: [], period: "last 7 days" }))
        .toBe("(no hotspots found, period: last 7 days)");
    });
  }
});
