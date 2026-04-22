// ---------------------------------------------------------------------------
// Tests for 7 journal CLI handlers (a-i branches from plan line 305).
// Mocks generator, migrator, llm-client, sentinel parser, and fs/promises
// for the stats + lint reads. Each branch asserts one observable.
// ---------------------------------------------------------------------------

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../../src/tools/journal-generator.js", () => ({
  runJournalInit: vi.fn().mockResolvedValue({ status: "ok", phases: [] }),
  runJournalAppend: vi.fn().mockResolvedValue({ status: "ok", phases: [] }),
  runJournalRegenerate: vi.fn().mockResolvedValue({ status: "ok", phases: [] }),
  refreshOverviewAndRollup: vi.fn().mockResolvedValue({ status: "ok", phases: [] }),
}));
vi.mock("../../src/tools/journal-migrator.js", () => ({
  runMigrate: vi.fn().mockResolvedValue({ status: "planned", phaseCount: 0 }),
}));
vi.mock("../../src/tools/journal-llm-client.js", () => ({
  selectProvider: vi.fn().mockReturnValue({ generate: vi.fn() }),
}));
vi.mock("../../src/tools/journal-sentinel.js", () => ({
  parseSentinelBlocks: vi.fn().mockReturnValue([]),
  SentinelIntegrityError: class extends Error {
    readonly line: number;
    constructor(message: string, line: number) {
      super(`${message} (line ${line})`);
      this.line = line;
    }
  },
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(),
    readdir: vi.fn(),
  };
});

describe("journal CLI handlers", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevEnabled: string | undefined;
  let prevCi: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEnabled = process.env["CODESIFT_JOURNAL_ENABLED"];
    prevCi = process.env["CI"];
    delete process.env["CODESIFT_JOURNAL_ENABLED"];
    delete process.env["CI"];
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env["CODESIFT_JOURNAL_ENABLED"];
    else process.env["CODESIFT_JOURNAL_ENABLED"] = prevEnabled;
    if (prevCi === undefined) delete process.env["CI"];
    else process.env["CI"] = prevCi;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // (a) init --dry-run → runJournalInit({ dryRun: true })
  it("handleJournalInit forwards --dry-run to runJournalInit", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    const { handleJournalInit } = await import("../../src/cli/journal-commands.js");
    await handleJournalInit([], { "dry-run": true });
    expect(gen.runJournalInit).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  // (b) append missing --since → exit 1 with clear message
  it("handleJournalAppend without --since exits 1 with clear message", async () => {
    const { handleJournalAppend } = await import("../../src/cli/journal-commands.js");
    await handleJournalAppend([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("journal append requires --since");
  });

  // (c) refresh-overview does NOT invoke LLM provider
  it("handleJournalRefreshOverview does not invoke LLM provider", async () => {
    const llm = await import("../../src/tools/journal-llm-client.js");
    const gen = await import("../../src/tools/journal-generator.js");
    const { handleJournalRefreshOverview } = await import("../../src/cli/journal-commands.js");
    await handleJournalRefreshOverview([], {});
    expect(llm.selectProvider).not.toHaveBeenCalled();
    expect(gen.refreshOverviewAndRollup).toHaveBeenCalled();
  });

  // (d) regenerate with both --entry and --phase → exit 1
  it("handleJournalRegenerate with both --entry and --phase exits 1", async () => {
    const { handleJournalRegenerate } = await import("../../src/cli/journal-commands.js");
    await handleJournalRegenerate([], { entry: "2026-04-01", phase: "2026-04-framework" });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("exactly one of --entry=<date> or --phase=<slug>");
  });

  // (e) lint parses sentinels for each discovered md file
  it("handleJournalLint invokes parseSentinelBlocks for each journal md file", async () => {
    const fs = await import("node:fs/promises");
    const sentinel = await import("../../src/tools/journal-sentinel.js");
    (fs.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      "2026-04-framework.md",
      "2026-03-journal.md",
    ]);
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("<!-- auto:begin meta -->\n<!-- auto:end meta -->\n");
    const { handleJournalLint } = await import("../../src/cli/journal-commands.js");
    await handleJournalLint([], {});
    expect(sentinel.parseSentinelBlocks).toHaveBeenCalledTimes(2);
  });

  // (f) migrate --dry-run writes state (calls runMigrate with dryRun:true).
  // Without --dry-run, runMigrate is called with dryRun:false (migrator itself
  // owns the "state file exists" check; handler only dispatches).
  it("handleJournalMigrate passes --dry-run through and defaults to live otherwise", async () => {
    const mig = await import("../../src/tools/journal-migrator.js");
    const { handleJournalMigrate } = await import("../../src/cli/journal-commands.js");
    await handleJournalMigrate([], { "dry-run": true });
    expect(mig.runMigrate).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }));
    await handleJournalMigrate([], {});
    expect(mig.runMigrate).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false }));
  });

  // (g) stats reads checkpoint and prints completed + cost
  it("handleJournalStats prints completed count and running cost from checkpoint", async () => {
    const fs = await import("node:fs/promises");
    (fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ startedAt: "2026-04-21T10:00:00Z", completed: ["a", "b", "c"], costUsd: 0.42 }),
    );
    const { handleJournalStats } = await import("../../src/cli/journal-commands.js");
    await handleJournalStats([], {});
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("completed");
    expect(out).toContain("3");
    expect(out).toContain("0.42");
    expect(out).toContain("2026-04-21T10:00:00Z");
  });

  // (h) --force propagates from CLI to runJournalRegenerate; --entry/--phase values too
  it("handleJournalRegenerate propagates --force, --entry, --phase to runJournalRegenerate", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    const { handleJournalRegenerate } = await import("../../src/cli/journal-commands.js");
    await handleJournalRegenerate([], { entry: "2026-04-01", force: true });
    expect(gen.runJournalRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, entry: "2026-04-01" }),
    );
    vi.clearAllMocks();
    await handleJournalRegenerate([], { phase: "2026-04-ship" });
    expect(gen.runJournalRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "2026-04-ship" }),
    );
  });

  // (b+) --since value propagates from CLI to runJournalAppend
  it("handleJournalAppend propagates --since value to runJournalAppend", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    const { handleJournalAppend } = await import("../../src/cli/journal-commands.js");
    await handleJournalAppend([], { since: "2 weeks ago" });
    expect(gen.runJournalAppend).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2 weeks ago" }),
    );
  });

  // (i) CI=true defaults init → append path
  it("handleJournalInit with CI=true and no explicit intent flags redirects to append", async () => {
    process.env["CI"] = "true";
    const gen = await import("../../src/tools/journal-generator.js");
    const { handleJournalInit } = await import("../../src/cli/journal-commands.js");
    await handleJournalInit([], {});
    expect(gen.runJournalAppend).toHaveBeenCalled();
    expect(gen.runJournalInit).not.toHaveBeenCalled();
  });
});
