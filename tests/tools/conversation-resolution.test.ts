import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockSearchSymbols = vi.hoisted(() => vi.fn());
const mockGetRepo = vi.hoisted(() => vi.fn());

vi.mock("../../src/tools/search-tools.js", () => ({
  searchSymbols: mockSearchSymbols,
}));

vi.mock("../../src/storage/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/storage/registry.js")>(
    "../../src/storage/registry.js",
  );
  return {
    ...actual,
    getRepo: mockGetRepo,
  };
});

describe("conversation path resolution", () => {
  let tempHome: string;
  let projectRoot: string;
  let dataDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "conv-home-"));
    projectRoot = await mkdtemp(join(tmpdir(), "conv-project-"));
    dataDir = await mkdtemp(join(tmpdir(), "codesift-data-"));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalDataDir = process.env.CODESIFT_DATA_DIR;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CODESIFT_DATA_DIR = dataDir;
    vi.resetModules();
    mockSearchSymbols.mockReset();
    mockGetRepo.mockReset();
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalDataDir === undefined) {
      delete process.env.CODESIFT_DATA_DIR;
    } else {
      process.env.CODESIFT_DATA_DIR = originalDataDir;
    }
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
    await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("indexConversations auto-detects the Claude conversation directory from cwd when path is omitted", async () => {
    const {
      indexConversations,
      getClaudeConversationProjectPath,
    } = await import("../../src/tools/conversation-tools.js");

    process.chdir(projectRoot);

    const conversationsDir = getClaudeConversationProjectPath(process.cwd());
    await mkdir(conversationsDir, { recursive: true });
    await writeFile(
      join(conversationsDir, "session.jsonl"),
      [
        JSON.stringify({ type: "user", message: { content: "question" }, uuid: "u1", sessionId: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n"),
    );

    const result = await indexConversations();
    expect(result.sessions_found).toBe(1);
    expect(result.turns_indexed).toBe(1);
  });

  it("findConversationsForSymbol resolves the code repo root to the matching conversation directory", async () => {
    const {
      indexConversations,
      findConversationsForSymbol,
      getClaudeConversationProjectPath,
    } = await import("../../src/tools/conversation-tools.js");

    const conversationsDir = getClaudeConversationProjectPath(projectRoot);
    await mkdir(conversationsDir, { recursive: true });
    await writeFile(
      join(conversationsDir, "session.jsonl"),
      [
        JSON.stringify({ type: "user", message: { content: "Can you refactor processPayment?" }, uuid: "u1", sessionId: "s1" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Sure, processPayment needs error handling." }] }, uuid: "a1", sessionId: "s1" }),
      ].join("\n"),
    );
    await indexConversations(conversationsDir);

    mockSearchSymbols.mockResolvedValue([
      {
        symbol: {
          id: "local/test:src/payment.ts:processPayment:1",
          name: "processPayment",
          kind: "function",
          file: "src/payment.ts",
          start_line: 1,
        },
        score: 12,
      },
    ]);
    mockGetRepo.mockResolvedValue({
      name: "local/test-repo",
      root: projectRoot,
      index_path: "/tmp/unused.index.json",
      symbol_count: 1,
      file_count: 1,
      updated_at: Date.now(),
    });

    const result = await findConversationsForSymbol("processPayment", "local/test-repo");

    expect(mockSearchSymbols).toHaveBeenCalledWith(
      "local/test-repo",
      "processPayment",
      expect.objectContaining({
        include_source: false,
        detail_level: "compact",
        top_k: 10,
      }),
    );
    expect(mockGetRepo).toHaveBeenCalled();
    expect(result.symbol).toEqual({
      name: "processPayment",
      file: "src/payment.ts",
      kind: "function",
    });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.user_question).toContain("processPayment");
    expect(result.session_count).toBe(1);
  });
});
