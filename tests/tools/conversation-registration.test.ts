describe("conversation tool registration", () => {
  it("conversation-tools exports all three handler functions", async () => {
    const mod = await import("../../src/tools/conversation-tools.js");
    expect(typeof mod.indexConversations).toBe("function");
    expect(typeof mod.searchConversations).toBe("function");
    expect(typeof mod.findConversationsForSymbol).toBe("function");
  });
});
