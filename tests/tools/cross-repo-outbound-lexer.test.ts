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
});
