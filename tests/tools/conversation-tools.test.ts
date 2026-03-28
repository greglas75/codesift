import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "conv-test-"));
  dataDir = await mkdtemp(join(tmpdir(), "codesift-data-"));
  originalDataDir = process.env.CODESIFT_DATA_DIR;
  process.env.CODESIFT_DATA_DIR = dataDir;
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
});

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.CODESIFT_DATA_DIR;
  } else {
    process.env.CODESIFT_DATA_DIR = originalDataDir;
  }
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
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

  it("indexes files regardless of size (no limit)", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    // File with valid JSONL — no size limit
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "big question" }, uuid: "u1", sessionId: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "big answer" }] }, uuid: "a1", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "big.jsonl"), jsonl);

    const result = await indexConversations(tmpDir);
    expect(result.sessions_found).toBe(1);
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

// Cross-repo symbol resolution behavior is covered in conversation-resolution.test.ts.
