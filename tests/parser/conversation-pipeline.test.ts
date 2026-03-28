import { getLanguageForExtension } from "../../src/parser/parser-manager.js";

describe("conversation pipeline wiring", () => {
  it("getLanguageForExtension returns 'conversation' for .jsonl", () => {
    expect(getLanguageForExtension(".jsonl")).toBe("conversation");
  });

  it("extractConversationSymbols is re-exported from symbol-extractor", async () => {
    const mod = await import("../../src/parser/symbol-extractor.js");
    expect(typeof mod.extractConversationSymbols).toBe("function");
  });
});
