import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { nextjsMetadataAudit } from "../../src/tools/nextjs-metadata-tools.js";

describe("nextjs-metadata-tools exports", () => {
  it("exports nextjsMetadataAudit function", () => {
    expect(typeof nextjsMetadataAudit).toBe("function");
  });
});
