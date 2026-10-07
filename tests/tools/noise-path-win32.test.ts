import { describe, expect, it } from "vitest";
import { isNoisePath } from "../../src/tools/symbol-tool-internals.js";

describe("isNoisePath", () => {
  it("filters build output whatever the separator", () => {
    expect(isNoisePath("dist/x.js")).toBe(true);
    expect(isNoisePath("dist\\x.js")).toBe(true);
    expect(isNoisePath("node_modules\\pkg\\index.js")).toBe(true);
  });

  it("keeps source files", () => {
    expect(isNoisePath("modules\\buyers\\X.php")).toBe(false);
    expect(isNoisePath("src/a.ts")).toBe(false);
  });
});
