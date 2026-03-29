/**
 * Tests for conversation search exports that were previously untested:
 * - searchAllConversations (cross-project search)
 * - findConversationsForSymbol (cross-reference)
 * - getConversationBM25Index (cache accessor)
 * - toConversationResult formatting (via integration)
 */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

// Fixture: JSONL conversation matching Claude Code's actual format
let turnCounter = 0;
function makeConversationJsonl(
  turns: Array<{ user: string; assistant: string }>,
  sessionId = "s1",
): string {
  const lines: string[] = [];
  for (const t of turns) {
    turnCounter++;
    lines.push(
      JSON.stringify({
        type: "user",
        message: { content: t.user },
        uuid: `u${turnCounter}`,
        sessionId,
        timestamp: `2026-03-28T10:${String(turnCounter).padStart(2, "0")}:00Z`,
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: t.assistant }] },
        uuid: `a${turnCounter}`,
        sessionId,
      }),
    );
  }
  return lines.join("\n");
}

let tmpDir: string;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  turnCounter = 0;
  tmpDir = await mkdtemp(join(tmpdir(), "conv-cross-"));
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
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("getConversationBM25Index", () => {
  it("returns null for unknown repo", async () => {
    const { getConversationBM25Index } = await import("../../src/tools/conversation-tools.js");
    expect(getConversationBM25Index("conversations/nonexistent")).toBeNull();
  });

  it("returns cached BM25 index after indexConversations", async () => {
    const { indexConversations, getConversationBM25Index } = await import(
      "../../src/tools/conversation-tools.js"
    );

    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "session1.jsonl"),
      makeConversationJsonl([{ user: "How does caching work?", assistant: "BM25 uses an inverted index." }]),
    );
    await indexConversations(tmpDir);

    const repoName = `conversations/${basename(tmpDir)}`;
    const index = getConversationBM25Index(repoName);
    expect(index).not.toBeNull();
    expect(index!.symbols.size).toBeGreaterThan(0);
  });

  it("returns different indexes for different repos", async () => {
    const { indexConversations, getConversationBM25Index } = await import(
      "../../src/tools/conversation-tools.js"
    );

    const dir1 = await mkdtemp(join(tmpDir, "repo1-"));
    const dir2 = await mkdtemp(join(tmpDir, "repo2-"));
    await writeFile(
      join(dir1, "s1.jsonl"),
      makeConversationJsonl([{ user: "Alpha topic", assistant: "Alpha answer" }]),
    );
    await writeFile(
      join(dir2, "s2.jsonl"),
      makeConversationJsonl([{ user: "Beta topic", assistant: "Beta answer" }]),
    );

    await indexConversations(dir1);
    await indexConversations(dir2);

    const idx1 = getConversationBM25Index(`conversations/${basename(dir1)}`);
    const idx2 = getConversationBM25Index(`conversations/${basename(dir2)}`);
    expect(idx1).not.toBeNull();
    expect(idx2).not.toBeNull();
    expect(idx1).not.toBe(idx2);
  });
});

describe("searchAllConversations", () => {
  it("searches across multiple indexed conversation repos", async () => {
    const { indexConversations, searchAllConversations } = await import(
      "../../src/tools/conversation-tools.js"
    );
    const { registerRepo } = await import("../../src/storage/registry.js");
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    const { getIndexPath } = await import("../../src/storage/index-store.js");

    // Create two conversation repos
    const dir1 = await mkdtemp(join(tmpDir, "proj1-"));
    const dir2 = await mkdtemp(join(tmpDir, "proj2-"));
    await writeFile(
      join(dir1, "session.jsonl"),
      makeConversationJsonl([{ user: "authentication flow design", assistant: "Use JWT with refresh tokens." }]),
    );
    await writeFile(
      join(dir2, "session.jsonl"),
      makeConversationJsonl([{ user: "authentication middleware setup", assistant: "Use passport.js." }]),
    );

    // Index both
    await indexConversations(dir1);
    await indexConversations(dir2);

    // Register both with conversations/ prefix
    const repoName1 = `conversations/${basename(dir1)}`;
    const repoName2 = `conversations/${basename(dir2)}`;
    await registerRepo(config.registryPath, {
      name: repoName1,
      root: dir1,
      index_path: getIndexPath(config.dataDir, dir1),
      symbol_count: 1,
      file_count: 1,
      updated_at: Date.now(),
    });
    await registerRepo(config.registryPath, {
      name: repoName2,
      root: dir2,
      index_path: getIndexPath(config.dataDir, dir2),
      symbol_count: 1,
      file_count: 1,
      updated_at: Date.now(),
    });

    const result = await searchAllConversations("authentication", 10);
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect(result.projects_searched).toBeGreaterThanOrEqual(2);
    // Results should be sorted by score descending
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i]!.score).toBeLessThanOrEqual(result.results[i - 1]!.score);
    }
  });

  it("returns empty when no conversation repos exist", async () => {
    const { searchAllConversations } = await import("../../src/tools/conversation-tools.js");
    // Fresh data dir has no repos
    const result = await searchAllConversations("anything", 5);
    expect(result.results).toEqual([]);
    expect(result.total_matches).toBe(0);
    expect(result.projects_searched).toBe(0);
  });

  it("respects limit parameter", async () => {
    const { indexConversations, searchAllConversations } = await import(
      "../../src/tools/conversation-tools.js"
    );
    const { registerRepo } = await import("../../src/storage/registry.js");
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    const { getIndexPath } = await import("../../src/storage/index-store.js");

    // Create a repo with multiple matching turns
    const dir1 = await mkdtemp(join(tmpDir, "limit-"));
    await writeFile(
      join(dir1, "s1.jsonl"),
      makeConversationJsonl([
        { user: "caching strategy design", assistant: "Use Redis for hot data." },
        { user: "caching invalidation approach", assistant: "Use TTL with stale-while-revalidate." },
        { user: "caching layer implementation", assistant: "Add middleware cache wrapper." },
      ]),
    );
    await indexConversations(dir1);
    await registerRepo(config.registryPath, {
      name: `conversations/${basename(dir1)}`,
      root: dir1,
      index_path: getIndexPath(config.dataDir, dir1),
      symbol_count: 3,
      file_count: 1,
      updated_at: Date.now(),
    });

    const result = await searchAllConversations("caching", 1);
    expect(result.results).toHaveLength(1);
  });

  it("filters out conv-test and conv-ret repos", async () => {
    const { searchAllConversations } = await import("../../src/tools/conversation-tools.js");
    const { registerRepo } = await import("../../src/storage/registry.js");
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();

    // Register test repos that should be filtered out
    await registerRepo(config.registryPath, {
      name: "conversations/conv-test-abc123",
      root: "/fake/test",
      index_path: "/fake/test/index",
      symbol_count: 1,
      file_count: 1,
      updated_at: Date.now(),
    });
    await registerRepo(config.registryPath, {
      name: "conversations/conv-ret-xyz789",
      root: "/fake/ret",
      index_path: "/fake/ret/index",
      symbol_count: 1,
      file_count: 1,
      updated_at: Date.now(),
    });

    const result = await searchAllConversations("anything", 10);
    // conv-test and conv-ret should be excluded
    expect(result.projects_searched).toBe(0);
  });

  it("gracefully handles repos that fail to load", async () => {
    const { searchAllConversations } = await import("../../src/tools/conversation-tools.js");
    const { registerRepo } = await import("../../src/storage/registry.js");
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();

    // Register a repo pointing to a nonexistent directory
    await registerRepo(config.registryPath, {
      name: "conversations/broken-repo",
      root: "/nonexistent/path/to/conversations",
      index_path: "/nonexistent/index",
      symbol_count: 1,
      file_count: 1,
      updated_at: Date.now(),
    });

    // Should not throw
    const result = await searchAllConversations("test", 5);
    expect(result.projects_searched).toBe(1);
    expect(result.results).toEqual([]);
  });
});

describe("findConversationsForSymbol", () => {
  it("finds conversations mentioning a symbol name", async () => {
    const { indexConversations, findConversationsForSymbol } = await import(
      "../../src/tools/conversation-tools.js"
    );
    const { registerRepo } = await import("../../src/storage/registry.js");
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    const { getIndexPath } = await import("../../src/storage/index-store.js");

    // Create conversation mentioning a function name
    const convDir = await mkdtemp(join(tmpDir, "symbol-"));
    await writeFile(
      join(convDir, "session.jsonl"),
      makeConversationJsonl([
        { user: "What does validateUserInput do?", assistant: "It checks email format and password strength." },
        { user: "Can we optimize processPayment?", assistant: "Consider batching the DB writes." },
      ]),
    );
    await indexConversations(convDir);

    // Register a fake code repo pointing at our conversation dir
    const codeRepoDir = await mkdtemp(join(tmpDir, "code-"));
    const codeRepoName = `local/${basename(codeRepoDir)}`;
    await registerRepo(config.registryPath, {
      name: codeRepoName,
      root: codeRepoDir,
      index_path: getIndexPath(config.dataDir, codeRepoDir),
      symbol_count: 0,
      file_count: 0,
      updated_at: Date.now(),
    });

    // Override HOME so getClaudeConversationProjectPath resolves to our temp dir
    const originalHome = process.env.HOME;
    const fakeHome = await mkdtemp(join(tmpDir, "home-"));
    const projectsDir = join(fakeHome, ".claude", "projects");
    await mkdir(projectsDir, { recursive: true });

    // Index conversations under the project path
    const encodedCwd = codeRepoDir.replace(/\//g, "-");
    const projectConvDir = join(projectsDir, encodedCwd);
    await mkdir(projectConvDir, { recursive: true });
    await writeFile(
      join(projectConvDir, "session.jsonl"),
      makeConversationJsonl([
        { user: "Let me explain validateUserInput", assistant: "It validates email and password." },
      ]),
    );
    process.env.HOME = fakeHome;
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();

    try {
      await indexConversations(projectConvDir);
      const result = await findConversationsForSymbol("validateUserInput", codeRepoName, 5);

      expect(result.symbol.name).toBe("validateUserInput");
      expect(result.conversations.length).toBeGreaterThanOrEqual(1);
      expect(result.session_count).toBeGreaterThanOrEqual(1);
      // Verify conversations contain the search term
      const hasRelevant = result.conversations.some(
        (c) => c.user_question.includes("validateUserInput") || c.assistant_answer.includes("validate"),
      );
      expect(hasRelevant).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      resetConfigCache();
    }
  });

  it("returns empty conversations when symbol not discussed", async () => {
    const { indexConversations, findConversationsForSymbol } = await import(
      "../../src/tools/conversation-tools.js"
    );
    const { registerRepo } = await import("../../src/storage/registry.js");
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    const { getIndexPath } = await import("../../src/storage/index-store.js");

    // Create conversation that doesn't mention the symbol
    const convDir = await mkdtemp(join(tmpDir, "nosym-"));
    await writeFile(
      join(convDir, "session.jsonl"),
      makeConversationJsonl([{ user: "How does React rendering work?", assistant: "Virtual DOM diffing." }]),
    );
    await indexConversations(convDir);

    const codeRepoDir = await mkdtemp(join(tmpDir, "code-nosym-"));
    await registerRepo(config.registryPath, {
      name: `local/${basename(codeRepoDir)}`,
      root: codeRepoDir,
      index_path: getIndexPath(config.dataDir, codeRepoDir),
      symbol_count: 0,
      file_count: 0,
      updated_at: Date.now(),
    });

    // Search for a symbol that was never discussed
    const result = await findConversationsForSymbol(
      "totallyUnrelatedFunctionXYZ",
      `local/${basename(codeRepoDir)}`,
      5,
    );
    expect(result.symbol.name).toBe("totallyUnrelatedFunctionXYZ");
    expect(result.conversations).toEqual([]);
    expect(result.session_count).toBe(0);
  });

  it("falls back gracefully when code repo not found", async () => {
    const { indexConversations, findConversationsForSymbol } = await import(
      "../../src/tools/conversation-tools.js"
    );

    // Index a conversation so search has data
    const convDir = await mkdtemp(join(tmpDir, "fallback-"));
    await writeFile(
      join(convDir, "session.jsonl"),
      makeConversationJsonl([{ user: "Fix the parseConfig function", assistant: "Added null check." }]),
    );
    await indexConversations(convDir);

    // Search with a nonexistent code repo — should not throw
    const result = await findConversationsForSymbol("parseConfig", "local/nonexistent-repo", 5);
    expect(result.symbol.name).toBe("parseConfig");
    // May or may not find results (depends on CWD resolution), but should not throw
    expect(result).toHaveProperty("conversations");
    expect(result).toHaveProperty("session_count");
  });
});

describe("toConversationResult output format", () => {
  it("extracts turn_index from symbol id", async () => {
    const { indexConversations, searchConversations } = await import(
      "../../src/tools/conversation-tools.js"
    );

    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "session.jsonl"),
      makeConversationJsonl([
        { user: "First question about parsing", assistant: "First answer about parsing." },
        { user: "Second question about parsing", assistant: "Second answer about parsing." },
      ]),
    );
    await indexConversations(tmpDir);

    const { results } = await searchConversations("parsing", tmpDir, 10);
    expect(results.length).toBeGreaterThanOrEqual(1);

    // turn_index should be a non-negative integer
    for (const r of results) {
      expect(r.turn_index).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.turn_index)).toBe(true);
    }
  });

  it("extracts session_id and file from results", async () => {
    const { indexConversations, searchConversations } = await import(
      "../../src/tools/conversation-tools.js"
    );

    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "my-session.jsonl"),
      makeConversationJsonl([{ user: "Explain dependency injection", assistant: "DI is a pattern." }]),
    );
    await indexConversations(tmpDir);

    const { results } = await searchConversations("dependency injection", tmpDir, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const first = results[0]!;
    expect(first.session_id).toBeTruthy();
    expect(first.file).toBe("my-session.jsonl");
    expect(first.user_question).toContain("dependency injection");
    expect(first.score).toBeGreaterThan(0);
  });

  it("handles assistant answer extraction with separator", async () => {
    const { indexConversations, searchConversations } = await import(
      "../../src/tools/conversation-tools.js"
    );

    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "answer.jsonl"),
      makeConversationJsonl([
        { user: "What is memoization?", assistant: "Memoization caches function results to avoid recomputation." },
      ]),
    );
    await indexConversations(tmpDir);

    const { results } = await searchConversations("memoization", tmpDir, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // assistant_answer should contain extracted text (may be truncated to 500 chars)
    expect(results[0]!.assistant_answer.length).toBeGreaterThan(0);
  });
});
