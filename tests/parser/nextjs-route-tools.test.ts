import { describe, it, expect, vi } from "vitest";

// Mock getCodeIndex for orchestrator integration tests (Task 30)
vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { nextjsRouteMap } from "../../src/tools/nextjs-route-tools.js";

describe("nextjs-route-tools exports", () => {
  it("exports nextjsRouteMap function", () => {
    expect(typeof nextjsRouteMap).toBe("function");
  });
});
