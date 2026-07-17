import { describe, expect, it } from "vitest";
import { findOutboundCalls } from "../../src/tools/cross-repo-outbound-lexer.js";

describe("findOutboundCalls lexer states", () => {
  it.each([
    ["single-quoted string", `const text = 'fetch("/hidden")';`, 0],
    ["template text", "const text = `fetch('/hidden')`;", 0],
    ["regex character class", String.raw`const re = /[\\/]/g; fetch("/visible");`, 1],
    ["division expression", `const ratio = total / count; fetch("/visible");`, 1],
  ])("handles %s", (_name, source, count) => {
    expect(findOutboundCalls(source)).toHaveLength(count);
  });

  it("returns from nested template interpolation before detecting a real call", () => {
    const source = "const text = `x ${fn({ nested: { value: '}' } })} fetch('/hidden')`;\nfetch('/visible');";
    expect(findOutboundCalls(source)).toEqual([
      expect.objectContaining({ callee: "fetch", line: 2, urlLiteral: { kind: "string", raw: "/visible" } }),
    ]);
  });

  it("preserves line accounting through escaped string newlines", () => {
    const source = "const text = 'hidden\\\nfetch(\"/still-hidden\")';\nfetch('/visible');";
    expect(findOutboundCalls(source)).toEqual([
      expect.objectContaining({ line: 3, urlLiteral: { kind: "string", raw: "/visible" } }),
    ]);
  });

  it("counts newlines skipped before a URL literal", () => {
    const source = "fetch(\n  '/first'\n);\nfetch('/second');";
    expect(findOutboundCalls(source).map((call) => call.line)).toEqual([1, 4]);
  });

  it("does not detect call-looking text inside a regex after return", () => {
    const source = `function pattern() { return /fetch\\(\"https:\\/\\/hidden\"\\)/; }\nfetch('/visible');`;
    expect(findOutboundCalls(source)).toEqual([
      expect.objectContaining({ line: 2, urlLiteral: { kind: "string", raw: "/visible" } }),
    ]);
  });

  it("reads nested templates and regex braces inside URL interpolation", () => {
    const source = "fetch(`${`inner-${value}`}/${/}/.source}/x`);\nfetch('/after');";
    expect(findOutboundCalls(source)).toEqual([
      expect.objectContaining({ line: 1, urlLiteral: { kind: "template", raw: "${`inner-${value}`}/${/}/.source}/x" } }),
      expect.objectContaining({ line: 2, urlLiteral: { kind: "string", raw: "/after" } }),
    ]);
  });
});
