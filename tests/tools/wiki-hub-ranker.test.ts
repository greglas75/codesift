import { describe, it, expect } from "vitest";
import { JS_BUILTIN_METHOD_NAMES } from "../../src/tools/wiki-hub-ranker.js";

describe("JS_BUILTIN_METHOD_NAMES", () => {
  it("contains at least 40 entries", () => {
    expect(JS_BUILTIN_METHOD_NAMES.size).toBeGreaterThanOrEqual(40);
  });

  it("contains expected prototype method names", () => {
    for (const name of ["map", "filter", "reduce", "slice", "now", "get", "then", "valueOf", "toString"]) {
      expect(JS_BUILTIN_METHOD_NAMES.has(name)).toBe(true);
    }
  });
});
