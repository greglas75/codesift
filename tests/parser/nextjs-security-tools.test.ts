import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { nextjsAuditServerActions } from "../../src/tools/nextjs-security-tools.js";
import {
  extractServerActionFunctions,
  detectAuthGuard,
  detectInputValidation,
  detectRateLimiting,
} from "../../src/tools/nextjs-security-readers.js";
import { scoreServerAction } from "../../src/tools/nextjs-security-scoring.js";

describe("nextjs-security-tools exports", () => {
  it("exports nextjsAuditServerActions function", () => {
    expect(typeof nextjsAuditServerActions).toBe("function");
  });

  it("exports extractServerActionFunctions reader", () => {
    expect(typeof extractServerActionFunctions).toBe("function");
  });

  it("exports detection readers", () => {
    expect(typeof detectAuthGuard).toBe("function");
    expect(typeof detectInputValidation).toBe("function");
    expect(typeof detectRateLimiting).toBe("function");
  });

  it("exports scoreServerAction", () => {
    expect(typeof scoreServerAction).toBe("function");
  });
});
