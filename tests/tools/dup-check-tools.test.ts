import { describe, expect, it } from "vitest";
import {
  DupMatcher,
  classifyMatches,
  suppressionReason,
  type SourceSymbol,
} from "../../src/tools/dup-check-tools.js";

/** 16 normalised lines (closing braces are dropped by normalisation). */
function body(name: string, filtered = "filtered"): string {
  return `function ${name}(values: number[]): number {
  const items: number[] = [];
  for (const v of values) {
    if (v % 2 === 0) {
      items.push(v * 10);
    } else {
      items.push(v * 5);
    }
  }
  const ${filtered} = items.filter((x) => x > 50);
  const mapped = ${filtered}.map((x) => x + 1);
  const reduced = mapped.reduce((a, b) => a + b, 0);
  console.log("total", reduced);
  const capped = Math.min(reduced, 1000);
  const rounded = Math.round(capped);
  if (rounded < 0) {
    throw new Error("negative");
  }
  return rounded;
}`;
}

function sym(name: string, file: string, source: string, start_line = 1): SourceSymbol {
  return { name, kind: "function", file, start_line, end_line: start_line + source.split("\n").length - 1, source };
}

const UNRELATED = `function render(rows: string[]): string {
  const out: string[] = [];
  out.push("<table>");
  for (const row of rows) {
    out.push("<tr>");
    out.push("<td>" + row + "</td>");
    out.push("</tr>");
  }
  out.push("</table>");
  const html = out.join("");
  const trimmed = html.trim();
  const size = trimmed.length;
  console.info("rendered", size);
  if (size === 0) {
    return "";
  }
  return trimmed;
}`;

function matchesOf(changed: SourceSymbol[], pool: SourceSymbol[], threshold = 0.85, minLines = 8) {
  const matcher = new DupMatcher(changed, threshold, minLines);
  for (const s of pool) matcher.offer(s);
  return matcher.results();
}

describe("suppressionReason", () => {
  const file = [
    "// codesift-dup-ok: kept for the v1 API", // 1
    "",                                         // 2
    "",                                         // 3
    "function a() {",                           // 4
    "  return 1;",                              // 5
    "}",                                        // 6
    "/* codesift-dup-ok:   */",                 // 7
    "function b() {",                           // 8
    "  // codesift-dup-ok: generated twin */",  // 9
    "}",                                        // 10
    "// codesift-dup-ok: too far",              // 11
    "", "", "",                                 // 12-14
    "function c() {",                           // 15
    "}",                                        // 16
  ];
  it.each<{ name: string; start: number; end: number; expected: string | null }>([
    // Bug caught: the marker three lines above the symbol must still bind to it.
    { name: "reason three lines above", start: 4, end: 6, expected: "kept for the v1 API" },
    // Bug caught: an empty marker counted as an exemption; the body marker's `*/` leaked into the reason.
    { name: "empty marker above is ignored, reason inside the body wins", start: 8, end: 10, expected: "generated twin" },
    // Bug caught: a marker four lines up silenced an unrelated symbol.
    { name: "marker four lines above does not count", start: 15, end: 16, expected: null },
  ])("$name", ({ start, end, expected }) => {
    expect(suppressionReason(file, start, end)).toBe(expected);
  });

  it("reads a marker on a CRLF line", () => {
    // Bug caught: `(.*)$` cannot cross the trailing `\r`, so every marker in a CRLF file was ignored.
    expect(suppressionReason(["// codesift-dup-ok: adapter copy\r", "function x() {\r", "}\r"], 2, 3)).toBe("adapter copy");
  });

  it("a marker without a reason does not suppress", () => {
    // Bug caught: `codesift-dup-ok:` with nothing after it exempted the copy it should question.
    expect(suppressionReason(["// codesift-dup-ok:", "function x() {", "}"], 2, 3)).toBeNull();
  });
});

describe("DupMatcher", () => {
  it("finds an exact copy in another file", () => {
    // Bug caught: an identical body under the same name in a different file was taken for its own previous version.
    const [r] = matchesOf([sym("sum", "src/new.ts", body("sum"))], [sym("sum", "src/old.ts", body("sum"))]);
    expect(r?.matches).toEqual([
      expect.objectContaining({ existing: expect.objectContaining({ file: "src/old.ts" }), similarity: 1, exact: true }),
    ]);
  });

  it("finds a near copy with a renamed variable", () => {
    // Bug caught: only exact hashes were matched, so renaming one local hid the copy.
    const [r] = matchesOf([sym("sum", "src/new.ts", body("sum", "kept"))], [sym("sum", "src/old.ts", body("sum"))]);
    expect(r?.matches[0]).toMatchObject({ exact: false, shared_lines: 14 });
    expect(r?.matches[0]?.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("ignores a function below the similarity threshold", () => {
    // Bug caught: shared boilerplate lines (`return`, loops) alone triggered a finding.
    expect(matchesOf([sym("sum", "src/new.ts", body("sum"))], [sym("render", "src/old.ts", UNRELATED)])).toEqual([]);
  });

  it("never matches the symbol's own previous version", () => {
    // Bug caught: editing a function compared it with its own indexed copy and reported it as a clone.
    expect(matchesOf([sym("sum", "src/a.ts", body("sum", "kept"), 5)], [sym("sum", "src/a.ts", body("sum"), 3)])).toEqual([]);
  });

  it("reports two new copies in different files once", () => {
    // Bug caught: a pair of new copies was reported twice, once from each side.
    const a = sym("sumA", "src/a.ts", body("sumA"));
    const b = sym("sumB", "src/b.ts", body("sumB"));
    const { findings } = classifyMatches(matchesOf([a, b], [a, b]), () => null);
    expect(findings.map((f) => [f.new.file, f.existing.file])).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("reports the unmarked side when only one of two new copies is suppressed", () => {
    // Bug caught: marking one copy as intentional hid the other, depending on scan order.
    const a = sym("sumA", "src/a.ts", body("sumA"));
    const b = sym("sumB", "src/b.ts", body("sumB"));
    const { findings, allowed } = classifyMatches(matchesOf([a, b], [b, a]), (s) => (s.file === "src/a.ts" ? "twin" : null));
    expect(findings.map((f) => f.new.file)).toEqual(["src/b.ts"]);
    expect(allowed).toEqual([]);
  });
});
