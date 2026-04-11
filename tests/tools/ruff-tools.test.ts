import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

// Mock execFileSync to avoid requiring ruff installation
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { execFileSync } from "node:child_process";
import { runRuff, _resetRuffCache } from "../../src/tools/ruff-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);
const mockedExecFileSync = vi.mocked(execFileSync);

function makeIndex(): CodeIndex {
  return {
    repo: "test", root: "/tmp/test",
    symbols: [
      {
        id: "test:app.py:process:5", repo: "test", name: "process",
        kind: "function", file: "app.py", start_line: 5, end_line: 20,
      },
    ],
    files: [{ path: "app.py", language: "python", symbol_count: 1, last_modified: Date.now() }],
    created_at: Date.now(), updated_at: Date.now(),
    symbol_count: 1, file_count: 1,
  };
}

describe("runRuff", () => {
  beforeEach(() => { vi.clearAllMocks(); _resetRuffCache(); });

  it("returns ruff_available=false when ruff not installed", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());
    mockedExecFileSync.mockImplementation(() => { throw new Error("not found"); });

    const result = await runRuff("test");
    expect(result.ruff_available).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("parses ruff JSON output and correlates with symbols", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());

    // First call: ruff version (succeeds)
    // Second call: ruff check (exits with code 1, findings in stdout)
    let callCount = 0;
    mockedExecFileSync.mockImplementation((...args: unknown[]) => {
      callCount++;
      if (callCount === 1) return "0.8.0"; // ruff version

      // ruff check — simulate exit code 1 with findings
      const err = new Error("exit 1") as Error & { stdout: string };
      err.stdout = JSON.stringify([
        {
          code: "B006",
          message: "Do not use mutable data structures for argument defaults",
          filename: "/tmp/test/app.py",
          location: { row: 10, column: 15 },
        },
      ]);
      throw err;
    });

    const result = await runRuff("test");
    expect(result.ruff_available).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      rule: "B006",
      file: "app.py",
      line: 10,
      containing_symbol: { name: "process", kind: "function" },
    });
    expect(result.by_rule.B006).toBe(1);
  });

  it("handles empty ruff output gracefully", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());
    mockedExecFileSync.mockReturnValue("[]" as never);

    const result = await runRuff("test");
    expect(result.ruff_available).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
