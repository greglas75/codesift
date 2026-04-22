// ---------------------------------------------------------------------------
// Kill-switch tests: CODESIFT_JOURNAL_ENABLED=false gates every journal CLI
// handler. Asserts exit(1) + stderr message + no generator/migrator calls.
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
vi.mock("../../src/tools/journal-sentinel.js", () => ({
  parseSentinelBlocks: vi.fn().mockReturnValue([]),
  SentinelIntegrityError: class extends Error {},
}));

const KILL_MSG = "journal disabled by CODESIFT_JOURNAL_ENABLED=false; set to 1 to enable";

describe("journal CLI kill-switch", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEnv = process.env["CODESIFT_JOURNAL_ENABLED"];
    process.env["CODESIFT_JOURNAL_ENABLED"] = "false";
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env["CODESIFT_JOURNAL_ENABLED"];
    else process.env["CODESIFT_JOURNAL_ENABLED"] = prevEnv;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  async function assertGated(handlerName: string, toolCheck: () => void): Promise<void> {
    const mod = await import("../../src/cli/journal-commands.js");
    const fn = (mod as unknown as Record<string, (a: string[], f: Record<string, unknown>) => Promise<void>>)[handlerName];
    await fn([], {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrCalls).toContain(KILL_MSG);
    toolCheck();
  }

  it("handleJournalInit is gated", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    await assertGated("handleJournalInit", () => {
      expect(gen.runJournalInit).not.toHaveBeenCalled();
    });
  });

  it("handleJournalAppend is gated", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    await assertGated("handleJournalAppend", () => {
      expect(gen.runJournalAppend).not.toHaveBeenCalled();
    });
  });

  it("handleJournalRefreshOverview is gated", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    await assertGated("handleJournalRefreshOverview", () => {
      expect(gen.refreshOverviewAndRollup).not.toHaveBeenCalled();
    });
  });

  it("handleJournalRegenerate is gated", async () => {
    const gen = await import("../../src/tools/journal-generator.js");
    await assertGated("handleJournalRegenerate", () => {
      expect(gen.runJournalRegenerate).not.toHaveBeenCalled();
    });
  });

  it("handleJournalLint is gated", async () => {
    const sentinel = await import("../../src/tools/journal-sentinel.js");
    await assertGated("handleJournalLint", () => {
      expect(sentinel.parseSentinelBlocks).not.toHaveBeenCalled();
    });
  });

  it("handleJournalMigrate is gated", async () => {
    const mig = await import("../../src/tools/journal-migrator.js");
    await assertGated("handleJournalMigrate", () => {
      expect(mig.runMigrate).not.toHaveBeenCalled();
    });
  });

  it("handleJournalStats is gated", async () => {
    // stats has no tool mock to check — gating assertion above is sufficient.
    await assertGated("handleJournalStats", () => {
      // no-op; exit+stderr already asserted
    });
  });
});
