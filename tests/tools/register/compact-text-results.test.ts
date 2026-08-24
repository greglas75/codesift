import { readFileSync } from "node:fs";
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

describe("renderCompactMatches — context lines", () => {
  const withCtx = {
    file: "src/a.ts",
    line: 12,
    content: "  const x = 1;",
    context_before: ["function f() {", "  // setup"],
    context_after: ["  return x;", "}"],
  };

  // 25.1% of real search_text calls pass context_lines. The first version of this renderer emitted
  // only `content`, so a quarter of all searches would have silently lost the lines they asked for —
  // measured 5576 B with context becoming 1990 B without, and nothing in the output said so.
  it("renders the requested context instead of discarding it", () => {
    const out = renderCompactMatches([withCtx]);
    expect(out).toContain("function f() {");
    expect(out).toContain("return x;");
  });

  it("numbers the context lines around the match and marks the hit", () => {
    expect(renderCompactMatches([withCtx]).split("\n")).toEqual([
      "src/a.ts:12",
      "  10 | function f() {",
      "  11 |   // setup",
      "> 12 | const x = 1;",
      "  13 |   return x;",
      "  14 | }",
    ]);
  });

  it("keeps the one-line form when no context was requested", () => {
    const { context_before: _b, context_after: _a, ...bare } = withCtx;
    expect(renderCompactMatches([bare])).toBe("src/a.ts:12 const x = 1;");
  });

  it("is still smaller than the JSON it replaces, with context included", () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({ ...withCtx, line: 12 + i * 10 }));
    expect(renderCompactMatches(hits).length).toBeLessThan(JSON.stringify(hits).length);
  });
});

describe("compact rendering is the default", () => {
  const KNOB = "CODESIFT_COMPACT_TEXT_RESULTS";
  const src = readFileSync(
    new URL("../../../src/register-tool-groups/core/search.ts", import.meta.url),
    "utf-8",
  );

  // search_text is 22.9% of all tokens in real telemetry (15.6M of 68M), and the JSON envelope is
  // 42% of what it ships. The default is the whole saving; an opt-in one is worth nothing, because
  // nobody sets it. Pinned as source rather than behaviour because the branch reads process.env at
  // call time and a test that mutates it races the rest of the suite.
  it("ships enabled — the knob only turns it OFF", () => {
    expect(src).toContain(`process.env["${KNOB}"] !== "0"`);
    expect(src).not.toContain(`process.env["${KNOB}"] === "1"`);
  });

  it("keeps an escape hatch documented next to the branch", () => {
    expect(src).toMatch(new RegExp(`${KNOB}=0`));
  });
});
