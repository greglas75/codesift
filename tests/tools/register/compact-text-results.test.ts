import { describe, expect, it } from "vitest";
import { renderCompactMatches } from "../../../src/register-tool-groups/core/search.js";

const hit = (over: Record<string, unknown> = {}) => ({
  file: "src/a.ts",
  line: 12,
  content: "  const x = 1;",
  containing_symbol: { name: "doThing", kind: "function", start_line: 5, end_line: 30, in_degree: 2 },
  ...over,
});

describe("renderCompactMatches", () => {
  it("renders path:line [symbol] content", () => {
    expect(renderCompactMatches([hit()])).toBe("src/a.ts:12 [doThing] const x = 1;");
  });

  it("omits the symbol when the hit has none", () => {
    expect(renderCompactMatches([hit({ containing_symbol: undefined })])).toBe("src/a.ts:12 const x = 1;");
  });

  it("renders one line per hit", () => {
    const out = renderCompactMatches([hit(), hit({ line: 40, content: "y()" })]);
    expect(out.split("\n")).toEqual(["src/a.ts:12 [doThing] const x = 1;", "src/a.ts:40 [doThing] y()"]);
  });

  // The caller falls back to the JSON shape on an empty string, so "cannot render" MUST be
  // distinguishable from "rendered nothing". Returning a partial list instead would silently drop
  // matches — a search that quietly loses hits is worse than a verbose one.
  it("returns empty for a shape it cannot represent, rather than dropping rows", () => {
    for (const bad of [[{ file: 1, line: 2 }], [{ file: "a.ts" }], [{ line: 3 }], [null], [undefined]]) {
      expect(renderCompactMatches(bad as unknown[])).toBe("");
    }
    // one bad row poisons the whole render — not just its own line
    expect(renderCompactMatches([hit(), { nope: true }])).toBe("");
  });

  it("tolerates a missing content field without losing the location", () => {
    expect(renderCompactMatches([hit({ content: undefined })])).toBe("src/a.ts:12 [doThing] ");
  });

  it("is materially shorter than the JSON it replaces", () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit({ line: i + 1 }));
    expect(renderCompactMatches(hits).length).toBeLessThan(JSON.stringify(hits).length / 2);
  });
});
