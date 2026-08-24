import { describe, expect, it } from "vitest";
import { formatFileOutline } from "../../src/formatters-core.js";

type Row = { id: string; name: string; kind: string; start_line: number; end_line: number };
const row = (name: string, kind: string, start: number, end = start): Row =>
  ({ id: `r:${name}`, name, kind, start_line: start, end_line: end });

describe("formatFileOutline line spans", () => {
  // `14:  14` says the same thing twice, and most outline entries are single-line — 34 of 45 on a
  // real file. get_file_outline is the second most-called tool in telemetry (8,004 calls, 4.6M
  // tokens), so the repeat was ~8% of its output.
  it("prints one number for a single-line symbol", () => {
    expect(formatFileOutline({ symbols: [row("x", "variable", 14)] as never })).toBe("  14 variable x");
  });

  it("keeps both numbers for a real span", () => {
    expect(formatFileOutline({ symbols: [row("f", "function", 10, 20)] as never })).toBe("  10-20 function f");
  });

  // The filter is only safe if the agent can tell it happened. Otherwise "not in the outline" and
  // "does not exist" look identical.
  it("names what was omitted and how to get it back", () => {
    const out = formatFileOutline({ symbols: [row("f", "function", 1, 9)] as never, locals_hidden: 12 });
    expect(out).toMatch(/12 local variable\(s\)/);
    expect(out).toMatch(/include_locals=true/);
  });

  it("says nothing when nothing was hidden", () => {
    expect(formatFileOutline({ symbols: [row("f", "function", 1, 9)] as never })).not.toMatch(/omitted/);
  });
});
