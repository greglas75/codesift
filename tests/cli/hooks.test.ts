import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Static import — handlePrecheckRead reads env vars at call time, not module load time,
// so module caching in singleFork mode is not a problem.
import { handlePrecheckRead, handlePrecheckBash, handlePostindexFile } from "../../src/cli/hooks.js";

// ---------------------------------------------------------------------------
// Mock indexFile so handlePostindexFile doesn't hit real storage
// ---------------------------------------------------------------------------
const mockIndexFile = vi.fn().mockResolvedValue({ indexed: 1 });

vi.mock("../../src/tools/index-tools.js", () => ({
  indexFile: (...args: unknown[]) => mockIndexFile(...args),
}));

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
    writeFileSync(filePath, "line\n".repeat(20));

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

  it("uses default 50 for invalid CODESIFT_READ_HOOK_MIN_LINES", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-test-"));
    const filePath = join(tmpDir, "medium.ts");
    writeFileSync(filePath, "line\n".repeat(30)); // 30 lines < 50 default

    process.env["CODESIFT_READ_HOOK_MIN_LINES"] = "abc";
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0); // 30 < 50 default
    rmSync(tmpDir, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // Wiki context injection tests (Task 11)
  // -------------------------------------------------------------------------

  it("wiki inject: injects community summary when manifest maps file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "example.ts");
    writeFileSync(filePath, "line\n".repeat(20)); // small file (under 50 line threshold)

    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const manifest = {
      index_hash: "abc123",
      file_to_community: { "src/example.ts": "auth-module" },
    };
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    const summaryContent = "## Auth Module\nHandles authentication logic.";
    writeFileSync(join(wikiDir, "auth-module.summary.md"), summaryContent);

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toContain("Auth Module");
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: exits 0 silently when manifest is missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "example.ts");
    writeFileSync(filePath, "line\n".repeat(20));

    // No .codesift/wiki directory at all

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toBe("");
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: exits 0 silently when manifest JSON is malformed", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "example.ts");
    writeFileSync(filePath, "line\n".repeat(20));

    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "wiki-manifest.json"), "{ not valid json {{{}}}");

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toBe("");
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: exits 0 silently when file not in file_to_community map", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "example.ts");
    writeFileSync(filePath, "line\n".repeat(20));

    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const manifest = {
      index_hash: "abc123",
      file_to_community: { "src/other.ts": "some-module" },
    };
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "some-module.summary.md"), "## Some Module");

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toBe("");
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: exits 0 silently when summary .md file is missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "example.ts");
    writeFileSync(filePath, "line\n".repeat(20));

    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const manifest = {
      index_hash: "abc123",
      file_to_community: { "src/example.ts": "missing-module" },
    };
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    // No missing-module.summary.md written

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toBe("");
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: large file still exits 2 with redirect (regression)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "big.ts");
    writeFileSync(filePath, "line\n".repeat(250)); // large — triggers redirect

    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const manifest = {
      index_hash: "abc123",
      file_to_community: { "src/big.ts": "auth-module" },
    };
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "auth-module.summary.md"), "## Auth Module summary");

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    // Must still exit 2 — wiki inject does NOT fire for large files
    expect(exitCode).toBe(2);
    expect(stdoutOutput).toContain("CodeSift tools");
    expect(stdoutOutput).not.toContain("Auth Module summary");
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: injected content is under 2000 char budget", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "example.ts");
    writeFileSync(filePath, "line\n".repeat(20));

    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const manifest = {
      index_hash: "abc123",
      file_to_community: { "src/example.ts": "big-community" },
    };
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    // Write a summary that is over 2000 chars
    const longSummary = "## Big Community\n" + "x".repeat(3000);
    writeFileSync(join(wikiDir, "big-community.summary.md"), longSummary);

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput.length).toBeLessThanOrEqual(2000);
    rmSync(tmpDir, { recursive: true });
  });

  it("wiki inject: resolves manifest by walking up from file path, not hardcoded", async () => {
    // File is nested 2 levels deep under the repo root
    const tmpDir = mkdtempSync(join(tmpdir(), "hook-wiki-"));
    const deepDir = join(tmpDir, "src", "nested", "deep");
    mkdirSync(deepDir, { recursive: true });
    const filePath = join(deepDir, "util.ts");
    writeFileSync(filePath, "line\n".repeat(20));

    // Manifest lives at repo root, NOT adjacent to the file
    const wikiDir = join(tmpDir, ".codesift", "wiki");
    mkdirSync(wikiDir, { recursive: true });
    const manifest = {
      index_hash: "abc123",
      file_to_community: { "src/nested/deep/util.ts": "utils-module" },
    };
    writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(wikiDir, "utils-module.summary.md"), "## Utils Module\nShared utilities.");

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });

    await handlePrecheckRead();

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toContain("Utils Module");
    rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// handlePrecheckBash tests
// ---------------------------------------------------------------------------

describe("handlePrecheckBash", () => {
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
  });

  it("exits 2 for find with -name (file exploration)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'find /project -type f -name "*.ts"' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
    expect(stdoutOutput).toContain("get_file_tree");
  });

  it("exits 2 for find with -iname", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'find . -iname "*.tsx" ! -path "*/node_modules/*"' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
  });

  it("exits 0 for find with -exec (destructive)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'find . -name "*.tmp" -exec rm {} \\;' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(0);
  });

  it("exits 0 for find with -delete", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'find . -name "*.log" -delete' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(0);
  });

  it("exits 2 for grep -r (recursive grep)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'grep -r "handleRequest" src/' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
    expect(stdoutOutput).toContain("search_text");
  });

  it("exits 2 for grep -rn (recursive with line numbers)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'grep -rn "TODO" .' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
  });

  it("exits 2 for rg (ripgrep)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'rg "createUser" --type ts' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
    expect(stdoutOutput).toContain("search_text");
  });

  it("exits 0 for git grep (not intercepted)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'git grep "pattern" HEAD' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(0);
  });

  it("exits 0 for regular bash commands", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(0);
  });

  it("exits 0 for git commands", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(0);
  });

  it("exits 2 for grep -R (uppercase recursive)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'grep -Rn "handleRequest" src/' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
    expect(stdoutOutput).toContain("search_text");
  });

  it("exits 2 for grep --recursive (long form)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'grep --recursive "TODO" src/' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(2);
  });

  it("exits 0 for non-recursive grep (single file)", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'grep "pattern" src/server.ts' },
    });

    await handlePrecheckBash();

    expect(exitCode).toBe(0);
  });

  it("exits 0 when HOOK_TOOL_INPUT not set", async () => {
    delete process.env["HOOK_TOOL_INPUT"];
    await handlePrecheckBash();
    expect(exitCode).toBe(0);
  });

  it("exits 0 on malformed JSON", async () => {
    process.env["HOOK_TOOL_INPUT"] = "not json {{{";
    await handlePrecheckBash();
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handlePostindexFile tests
// ---------------------------------------------------------------------------

describe("handlePostindexFile", () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = undefined;
    mockIndexFile.mockClear();
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["HOOK_TOOL_INPUT"];
  });

  it("calls indexFile for a .ts file Edit event", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/project/src/foo.ts" },
    });

    await handlePostindexFile();

    expect(mockIndexFile).toHaveBeenCalledWith("/project/src/foo.ts");
    expect(exitCode).toBe(0);
  });

  it("does NOT call indexFile for a .json file", async () => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/project/package.json" },
    });

    await handlePostindexFile();

    expect(mockIndexFile).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("exits 0 when HOOK_TOOL_INPUT not set", async () => {
    delete process.env["HOOK_TOOL_INPUT"];

    await handlePostindexFile();

    expect(mockIndexFile).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("exits 0 on malformed JSON (never blocks the agent)", async () => {
    process.env["HOOK_TOOL_INPUT"] = "not json{{{";

    await handlePostindexFile();

    expect(mockIndexFile).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("exits 0 even when indexFile rejects (fire-and-forget safety)", async () => {
    mockIndexFile.mockRejectedValueOnce(new Error("index failure"));

    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/project/src/bar.ts" },
    });

    await handlePostindexFile();

    expect(exitCode).toBe(0);
  });
});
