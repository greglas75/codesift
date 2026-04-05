import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Static import — handlePrecheckRead reads env vars at call time, not module load time,
// so module caching in singleFork mode is not a problem.
import { handlePrecheckRead } from "../../src/cli/hooks.js";

describe("handlePrecheckRead", () => {
  let exitCode: number | undefined;
  let stdoutOutput: string;

  beforeEach(() => {
    exitCode = undefined;
    stdoutOutput = "";
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["HOOK_TOOL_INPUT"];
    delete process.env["CODESIFT_READ_HOOK_MIN_LINES"];
  });

  it("exits 2 for large .ts file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    const filePath = join(tmpDir, "big.ts");
    writeFileSync(filePath, "line\n".repeat(250));

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(2);
    rmSync(tmpDir, { recursive: true });
  });

  it("exits 0 for small .ts file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    const filePath = join(tmpDir, "small.ts");
    writeFileSync(filePath, "line\n".repeat(50));

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    rmSync(tmpDir, { recursive: true });
  });

  it("exits 0 for non-code extension", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    const filePath = join(tmpDir, "data.json");
    writeFileSync(filePath, "line\n".repeat(500));

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    rmSync(tmpDir, { recursive: true });
  });

  it("exits 0 when HOOK_TOOL_INPUT not set", async () => {
    delete process.env["HOOK_TOOL_INPUT"];
    await handlePrecheckRead();
    expect(exitCode).toBe(0);
  });

  it("exits 0 on malformed JSON", async () => {
    process.env["HOOK_TOOL_INPUT"] = "not json {{{";
    await handlePrecheckRead();
    expect(exitCode).toBe(0);
  });

  it("exits 0 when file not found", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/nonexistent/file.ts" },
    });
    await handlePrecheckRead();
    expect(exitCode).toBe(0);
  });

  it("respects CODESIFT_READ_HOOK_MIN_LINES env var", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    const filePath = join(tmpDir, "medium.ts");
    writeFileSync(filePath, "line\n".repeat(100)); // 100 lines

    process.env["CODESIFT_READ_HOOK_MIN_LINES"] = "50";
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(2); // 100 > 50 threshold
    rmSync(tmpDir, { recursive: true });
  });

  it("uses default 200 for invalid CODESIFT_READ_HOOK_MIN_LINES", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    const filePath = join(tmpDir, "medium.ts");
    writeFileSync(filePath, "line\n".repeat(150)); // 150 lines < 200 default

    process.env["CODESIFT_READ_HOOK_MIN_LINES"] = "abc";
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0); // 150 < 200 default
    rmSync(tmpDir, { recursive: true });
  });
});
