import { describe, expect, it } from "vitest";
import { findEndByte } from "../../../src/parser/extractors/sql-boundaries.js";

describe("findEndByte", () => {
  it("uses the final byte when a single-line construct has no newline", () => {
    const source = "CREATE SCHEMA app";
    expect(findEndByte(source, 0, "single-line")).toBe(source.length - 1);
  });
});
