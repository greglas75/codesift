import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn() };
});

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { execFileSync } from "node:child_process";
import { runMypy, runPyright, _resetTypeCheckCache } from "../../src/tools/typecheck-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);
const mockedExecFileSync = vi.mocked(execFileSync);

function makeIndex(): CodeIndex {
  return {
    repo: "test",
    root: "/tmp/test",
    symbols: [{
      id: "test:app.py:process:5",
      repo: "test",
      name: "process",
      kind: "function",
      file: "app.py",
      start_line: 5,
      end_line: 20,
    }],
    files: [{ path: "app.py", language: "python", symbol_count: 1, last_modified: Date.now() }],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 1,
    file_count: 1,
  };
}

describe("runMypy", () => {
  beforeEach(() => { vi.clearAllMocks(); _resetTypeCheckCache(); });

  it("returns tool_available=false when mypy missing", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());
    mockedExecFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

    const result = await runMypy("test");
    expect(result.tool_available).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("parses mypy text output with error code", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());

    let call = 0;
    mockedExecFileSync.mockImplementation(() => {
      call++;
      if (call === 1) return "mypy 1.8.0";
      const err = new Error("exit 1") as Error & { stdout: string };
      err.stdout = "/tmp/test/app.py:10: error: Argument 1 has incompatible type [arg-type]\n";
      throw err;
    });

    const result = await runMypy("test");
    expect(result.tool_available).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      tool: "mypy",
      file: "app.py",
      line: 10,
      severity: "error",
      rule: "arg-type",
    });
    expect(result.findings[0]!.containing_symbol).toMatchObject({
      name: "process",
      kind: "function",
    });
  });

  it("parses multiple mypy findings with mixed severity", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());

    let call = 0;
    mockedExecFileSync.mockImplementation(() => {
      call++;
      if (call === 1) return "mypy 1.8.0";
      const err = new Error("exit 1") as Error & { stdout: string };
      err.stdout =
        "/tmp/test/app.py:8: error: Incompatible return value [return-value]\n" +
        "/tmp/test/app.py:12: warning: Unused import [unused-import]\n" +
        "/tmp/test/app.py:15: note: Try this instead\n";
      throw err;
    });

    const result = await runMypy("test");
    expect(result.findings).toHaveLength(3);
    expect(result.by_severity).toMatchObject({ error: 1, warning: 1, note: 1 });
  });
});

describe("runPyright", () => {
  beforeEach(() => { vi.clearAllMocks(); _resetTypeCheckCache(); });

  it("parses pyright JSON output", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());

    let call = 0;
    mockedExecFileSync.mockImplementation(() => {
      call++;
      if (call === 1) return "pyright 1.1.350";
      const err = new Error("exit 1") as Error & { stdout: string };
      err.stdout = JSON.stringify({
        generalDiagnostics: [
          {
            file: "/tmp/test/app.py",
            range: { start: { line: 9, character: 4 } },
            severity: "error",
            message: "Missing import",
            rule: "reportMissingImports",
          },
        ],
      });
      throw err;
    });

    const result = await runPyright("test");
    expect(result.tool).toBe("pyright");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      tool: "pyright",
      file: "app.py",
      line: 10, // 0-indexed + 1
      severity: "error",
      rule: "reportMissingImports",
    });
  });

  it("returns empty result when pyright unavailable", async () => {
    mockedGetCodeIndex.mockResolvedValue(makeIndex());
    mockedExecFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

    const result = await runPyright("test");
    expect(result.tool_available).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});
