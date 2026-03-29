import { describe, it, expect } from "vitest";
import { classifyRole } from "../../src/tools/graph-tools.js";
import type { SymbolRole } from "../../src/tools/graph-tools.js";

describe("classifyRole", () => {
  it("classifies dead symbols (zero callers)", () => {
    expect(classifyRole(0, 0)).toBe("dead" satisfies SymbolRole);
    expect(classifyRole(0, 5)).toBe("dead" satisfies SymbolRole);
  });

  it("classifies leaf symbols (zero callees)", () => {
    expect(classifyRole(3, 0)).toBe("leaf" satisfies SymbolRole);
    expect(classifyRole(1, 0)).toBe("leaf" satisfies SymbolRole);
  });

  it("classifies utility symbols (many callers, few callees)", () => {
    // ratio >= 3, callers >= 3
    expect(classifyRole(9, 2)).toBe("utility" satisfies SymbolRole);
    expect(classifyRole(6, 1)).toBe("utility" satisfies SymbolRole);
    expect(classifyRole(3, 1)).toBe("utility" satisfies SymbolRole);
  });

  it("classifies entry points (few callers, many callees)", () => {
    // ratio <= 0.33, callees >= 3
    expect(classifyRole(1, 5)).toBe("entry" satisfies SymbolRole);
    expect(classifyRole(1, 10)).toBe("entry" satisfies SymbolRole);
  });

  it("classifies core symbols (high connectivity both ways)", () => {
    expect(classifyRole(3, 3)).toBe("core" satisfies SymbolRole);
    expect(classifyRole(5, 4)).toBe("core" satisfies SymbolRole);
    expect(classifyRole(2, 2)).toBe("core" satisfies SymbolRole);
  });

  it("defaults to leaf for low-connectivity symbols", () => {
    // 1 caller, 1 callee — ratio = 1, not enough for utility/entry/core
    expect(classifyRole(1, 1)).toBe("leaf" satisfies SymbolRole);
  });

  it("handles edge case ratios correctly", () => {
    // Exactly at utility boundary: ratio=3, callers=3
    expect(classifyRole(3, 1)).toBe("utility");
    // Just below utility: ratio=2.5, callers=5
    expect(classifyRole(5, 2)).toBe("core");
    // ratio=1/3=0.333... > 0.33, so NOT entry — needs callees >= 3 AND ratio < 0.33
    expect(classifyRole(1, 4)).toBe("entry");
  });
});
