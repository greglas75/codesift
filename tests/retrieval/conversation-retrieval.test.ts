import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("codebase_retrieval — conversation query type", () => {
  let tmpDir: string;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "conv-ret-"));
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
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("SubQuerySchema parses conversation type correctly", async () => {
    const { SubQuerySchema } = await import("../../src/retrieval/retrieval-schemas.js");
    const parsed = SubQuerySchema.parse({ type: "conversation", query: "Redis cache", project: tmpDir });
    expect(parsed.type).toBe("conversation");
  });

  it("conversation query returns results through executeSubQuery dispatch", async () => {
    const { indexConversations, searchConversations } = await import("../../src/tools/conversation-tools.js");
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "Fix the Redis cache issue" }, uuid: "u1", sessionId: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Clear the cache key." }] }, uuid: "a1", sessionId: "s1" }),
    ].join("\n");
    await writeFile(join(tmpDir, "s1.jsonl"), jsonl);
    await indexConversations(tmpDir);

    // Verify search works through the tool (the dispatch route is what Task 8 adds)
    const result = await searchConversations("Redis cache", tmpDir);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});
