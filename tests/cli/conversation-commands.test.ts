import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mockIndexConversations = vi.fn().mockResolvedValue({
  sessions_found: 1,
  turns_indexed: 2,
  skipped_noise_records: 0,
  compacted_sessions: 0,
  elapsed_ms: 10,
});

vi.mock("../../src/tools/conversation-tools.js", () => ({
  indexConversations: mockIndexConversations,
}));

import { COMMAND_MAP } from "../../src/cli/commands.js";

describe("conversation CLI commands", () => {
  let stdoutSpy: MockInstance;
  let stderrSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the index-conversations command", () => {
    expect(COMMAND_MAP["index-conversations"]).toBeDefined();
    expect(typeof COMMAND_MAP["index-conversations"]).toBe("function");
  });

  it("calls indexConversations without a path when omitted", async () => {
    await COMMAND_MAP["index-conversations"]!([], {});

    expect(mockIndexConversations).toHaveBeenCalledWith(undefined);
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("passes the optional path through and suppresses output in quiet mode", async () => {
    await COMMAND_MAP["index-conversations"]!(["/tmp/claude-project"], { quiet: true });

    expect(mockIndexConversations).toHaveBeenCalledWith("/tmp/claude-project");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
