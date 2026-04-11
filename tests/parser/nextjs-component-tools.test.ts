import { describe, it, expect } from "vitest";
import { analyzeNextjsComponents } from "../../src/tools/nextjs-component-tools.js";

describe("nextjs-component-tools exports", () => {
  it("exports analyzeNextjsComponents function", () => {
    expect(typeof analyzeNextjsComponents).toBe("function");
  });
});
