import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "conv-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("indexConversations", () => {

  it("indexes JSONL files in a directory and returns stats", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1", timestamp: "2026-03-28T10:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "session1.jsonl"), jsonl);

    const result = await indexConversations(tmpDir);
    expect(result.sessions_found).toBe(1);
    expect(result.turns_indexed).toBeGreaterThanOrEqual(1);
    expect(result.elapsed_ms).toBeGreaterThan(0);
  });

  it("skips files larger than 10MB", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const bigContent = "x".repeat(11 * 1024 * 1024);
    await writeFile(join(tmpDir, "big.jsonl"), bigContent);

    const result = await indexConversations(tmpDir);
    expect(result.sessions_found).toBe(0);
  });

  it("handles empty directory", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const result = await indexConversations(tmpDir);
    expect(result.sessions_found).toBe(0);
    expect(result.turns_indexed).toBe(0);
  });

  it("indexes multiple sessions", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    for (let i = 1; i <= 3; i++) {
      const jsonl = [
        JSON.stringify({ type: "user", message: { content: `question ${i}` }, uuid: `u${i}`, sessionId: `s${i}` }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] }, uuid: `a${i}`, sessionId: `s${i}` }),
      ].join("\n");
      await writeFile(join(tmpDir, `session${i}.jsonl`), jsonl);
    }

    const result = await indexConversations(tmpDir);
    expect(result.sessions_found).toBe(3);
    expect(result.turns_indexed).toBe(3);
  });
});

describe("searchConversations", () => {
  it("returns matching turns ranked by BM25 score", async () => {
    const { indexConversations, searchConversations } = await import("../../src/tools/conversation-tools.js");
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "How do I fix the auth middleware bug?" }, uuid: "u1", sessionId: "s1", timestamp: "2026-03-28T10:00:00Z", gitBranch: "main" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Check the JWT validation in auth.ts." }] }, uuid: "a1", sessionId: "s1" }),
      JSON.stringify({ type: "user", message: { content: "What about the database migration?" }, uuid: "u2", sessionId: "s1", timestamp: "2026-03-28T10:05:00Z", gitBranch: "main" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Run prisma migrate." }] }, uuid: "a2", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
    await indexConversations(tmpDir);

    const result = await searchConversations("auth middleware", tmpDir);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.user_question).toContain("auth");
    expect(result.results[0]!.score).toBeGreaterThan(0);
  });

  it("returns empty results for non-matching query", async () => {
    const { indexConversations, searchConversations } = await import("../../src/tools/conversation-tools.js");
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
    await indexConversations(tmpDir);

    const result = await searchConversations("zzz_nonexistent_term_zzz", tmpDir);
    expect(result.results).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    const { indexConversations, searchConversations } = await import("../../src/tools/conversation-tools.js");
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ type: "user", message: { content: `auth question ${i}` }, uuid: `u${i}`, sessionId: "s1" }));
      lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `auth answer ${i}` }] }, uuid: `a${i}`, sessionId: "s1" }));
    }
    await writeFile(join(tmpDir, "s1.jsonl"), lines.join("\n"));
    await indexConversations(tmpDir);

    const result = await searchConversations("auth", tmpDir, 3);
    expect(result.results.length).toBeLessThanOrEqual(3);
  });
});

describe("findConversationsForSymbol", () => {
  it("finds conversations mentioning a symbol name", async () => {
    const { indexConversations, findConversationsForSymbol } = await import("../../src/tools/conversation-tools.js");
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "Can you refactor processPayment?" }, uuid: "u1", sessionId: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Sure, processPayment needs error handling." }] }, uuid: "a1", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
    await indexConversations(tmpDir);

    const result = await findConversationsForSymbol("processPayment", tmpDir);
    expect(result.conversations.length).toBeGreaterThanOrEqual(1);
    expect(result.session_count).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when symbol is not mentioned", async () => {
    const { indexConversations, findConversationsForSymbol } = await import("../../src/tools/conversation-tools.js");
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "some question" }, uuid: "u1", sessionId: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "some answer" }] }, uuid: "a1", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
    await indexConversations(tmpDir);

    const result = await findConversationsForSymbol("nonExistentSymbol", tmpDir);
    expect(result.conversations).toHaveLength(0);
    expect(result.session_count).toBe(0);
  });
});
