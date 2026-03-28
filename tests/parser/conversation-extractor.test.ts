import { extractConversationSymbols } from "../../src/parser/extractors/conversation.js";

const makeJsonl = (records: object[]): string =>
  records.map((r) => JSON.stringify(r)).join("\n");

describe("extractConversationSymbols — basic turn pairs", () => {
  it("extracts a user+assistant pair as conversation_turn", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "How do I fix the auth bug?" }, uuid: "u1", timestamp: "2026-03-28T10:00:00Z", sessionId: "s1", gitBranch: "main" },
      { type: "assistant", message: { content: [{ type: "text", text: "You need to check the middleware." }] }, uuid: "a1", timestamp: "2026-03-28T10:00:05Z", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "session.jsonl", "conversations/test");

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.kind).toBe("conversation_turn");
    expect(symbols[0]!.name).toBe("How do I fix the auth bug?");
    expect(symbols[0]!.source).toContain("How do I fix the auth bug?");
    expect(symbols[0]!.source).toContain("You need to check the middleware.");
    expect(symbols[0]!.start_line).toBe(1);
    expect(symbols[0]!.end_line).toBe(2);
    expect(symbols[0]!.parent).toBe("s1");
  });

  it("handles user message as plain string content", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "plain string message" }, uuid: "u1", timestamp: "2026-03-28T10:00:00Z", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "response" }] }, uuid: "a1", timestamp: "2026-03-28T10:00:05Z", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.name).toBe("plain string message");
  });

  it("handles assistant content as array of text blocks", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "question" }, uuid: "u1", timestamp: "2026-03-28T10:00:00Z", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "part1 " }, { type: "text", text: "part2" }] }, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.source).toContain("part1 part2");
  });

  it("skips non-user/assistant records (progress, system, etc.)", () => {
    const source = makeJsonl([
      { type: "progress", content: "loading..." },
      { type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1" },
      { type: "system", subType: "turn_duration", duration: 5000 },
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" },
      { type: "file-history-snapshot", files: [] },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols).toHaveLength(1);
  });

  it("truncates name to 100 chars", () => {
    const longQuestion = "x".repeat(200);
    const source = makeJsonl([
      { type: "user", message: { content: longQuestion }, uuid: "u1", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.name.length).toBeLessThanOrEqual(100);
  });

  it("returns empty array for empty file", () => {
    const symbols = extractConversationSymbols("", "empty.jsonl", "conversations/test");
    expect(symbols).toEqual([]);
  });

  it("skips malformed JSON lines without crashing", () => {
    const source = '{"type":"user","message":{"content":"q"},"uuid":"u1","sessionId":"s1"}\nINVALID JSON\n{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]},"uuid":"a1","sessionId":"s1"}';
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols).toHaveLength(1);
  });

  it("produces word-split tokens for natural language", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "how does authentication work" }, uuid: "u1", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "The auth module handles login." }] }, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.tokens).toContain("authentication");
    expect(symbols[0]!.tokens).toContain("auth");
    expect(symbols[0]!.tokens).toContain("login");
  });
});

describe("extractConversationSymbols — compaction handling", () => {
  it("skips isCompactSummary user messages", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "original question" }, uuid: "u1", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "original answer" }] }, uuid: "a1", sessionId: "s1" },
      { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 50000 } },
      { type: "user", message: { content: "This session is being continued..." }, uuid: "u2", sessionId: "s1", isCompactSummary: true },
      { type: "assistant", message: { content: [{ type: "text", text: "continuing work" }] }, uuid: "a2", sessionId: "s1" },
      { type: "user", message: { content: "new question after compact" }, uuid: "u3", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "new answer" }] }, uuid: "a3", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");

    const names = symbols.filter(s => s.kind === "conversation_turn").map(s => s.name);
    expect(names).toContain("original question");
    expect(names).toContain("new question after compact");
    expect(names).not.toContain("This session is being continued...");
  });

  it("indexes last compact summary as conversation_summary", () => {
    const source = makeJsonl([
      { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 50000 } },
      { type: "user", message: { content: "Summary of session: worked on auth module" }, uuid: "u1", sessionId: "s1", isCompactSummary: true },
      { type: "assistant", message: { content: [{ type: "text", text: "continuing" }] }, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");

    const summaries = symbols.filter(s => s.kind === "conversation_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.source).toContain("Summary of session");
  });

  it("only indexes the LAST summary for multi-compaction files", () => {
    const source = makeJsonl([
      { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 50000 } },
      { type: "user", message: { content: "First summary" }, uuid: "u1", sessionId: "s1", isCompactSummary: true },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, uuid: "a1", sessionId: "s1" },
      { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 60000 } },
      { type: "user", message: { content: "Second summary" }, uuid: "u2", sessionId: "s1", isCompactSummary: true },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, uuid: "a2", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");

    const summaries = symbols.filter(s => s.kind === "conversation_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.source).toContain("Second summary");
  });
});

describe("extractConversationSymbols — noise filtering", () => {
  it("strips tool_result content entirely", () => {
    const source = makeJsonl([
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "HUGE FILE DUMP ".repeat(100) }] }, uuid: "u1", sessionId: "s1", toolUseResult: true },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols.every(s => !s.source.includes("HUGE FILE DUMP"))).toBe(true);
  });

  it("keeps tool_use name but truncates input to 200 chars", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "check this file" }, uuid: "u1", sessionId: "s1" },
      { type: "assistant", message: { content: [
        { type: "text", text: "Let me read it." },
        { type: "tool_use", name: "Read", input: { file_path: "/very/long/path/" + "x".repeat(300) } },
      ]}, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.source).toContain("Read");
    expect(symbols[0]!.source.length).toBeLessThan(1000);
  });

  it("replaces image blocks with [image] placeholder", () => {
    const source = makeJsonl([
      { type: "user", message: { content: [{ type: "image", source: { data: "base64..." } }, { type: "text", text: "fix this UI" }] }, uuid: "u1", sessionId: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "I see the issue." }] }, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.source).toContain("[image]");
    expect(symbols[0]!.source).toContain("fix this UI");
    expect(symbols[0]!.source).not.toContain("base64");
  });

  it("includes thinking blocks in source", () => {
    const source = makeJsonl([
      { type: "user", message: { content: "solve this" }, uuid: "u1", sessionId: "s1" },
      { type: "assistant", message: { content: [
        { type: "thinking", thinking: "Let me analyze the problem step by step." },
        { type: "text", text: "Here is the solution." },
      ]}, uuid: "a1", sessionId: "s1" },
    ]);
    const symbols = extractConversationSymbols(source, "s.jsonl", "conversations/test");
    expect(symbols[0]!.source).toContain("Here is the solution.");
  });
});
