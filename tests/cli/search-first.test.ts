import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  handlePrecheckWrite,
  isHumanPrompt,
  isSearchToolUse,
  readLinesBackward,
  searchedSinceLastPrompt,
} from "../../src/cli/hooks/search-first.js";

const hookEnv = { serverRunning: true };

vi.mock("../../src/cli/hooks/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/hooks/shared.js")>();
  return { ...actual, isCodesiftServerRunning: () => hookEnv.serverRunning };
});

const prompt = (text: string, origin: Record<string, unknown> | undefined = { kind: "human" }) =>
  JSON.stringify({ type: "user", origin, message: { role: "user", content: text } });
const toolUse = (name: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const toolResult = () =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });

describe("isSearchToolUse", () => {
  it.each([
    ["mcp__codesift__search_symbols", {}, true],
    ["mcp__codesift__semantic_search", {}, true],
    ["mcp__plugin_codesift__find_clones", {}, true],
    // index_file changes the index; it looks nothing up — counting it would let any edit unlock the gate
    ["mcp__codesift__index_file", {}, false],
    ["mcp__other__search_symbols", {}, false],
    ["Grep", {}, true],
    ["Glob", {}, true],
    ["Bash", { command: "grep -rn formatPercent apps/" }, true],
    ["Bash", { command: "cd x && rg -l useQuery" }, true],
    ["Bash", { command: "git grep -n foo" }, true],
    ["Bash", { command: "codesift symbols local/x formatPercent" }, true],
    // a test run or a build is not a lookup
    ["Bash", { command: "npx vitest run src/a.test.ts" }, false],
    ["Agent", { subagent_type: "Explore" }, true],
    ["Agent", { subagent_type: "general-purpose" }, false],
    ["Read", { file_path: "a.ts" }, false],
  ])("%s %j → %s", (name, input, expected) => {
    expect(isSearchToolUse(name, input)).toBe(expected);
  });
});

describe("isHumanPrompt", () => {
  it.each([
    ["typed prompt", JSON.parse(prompt("build X")), true],
    ["subagent brief (no origin)", JSON.parse(prompt("Build X", undefined)), true],
    // a background task finishing must not reopen the gate for work already searched
    ["task notification", JSON.parse(prompt("<task-notification>…", { kind: "task-notification" })), false],
    ["tool result", JSON.parse(toolResult()), false],
    ["skill body", { type: "user", isMeta: true, message: { content: [{ type: "text", text: "skill" }] } }, false],
    ["compaction summary", { type: "user", isCompactSummary: true, message: { content: "summary" } }, false],
  ])("%s → %s", (_label, entry, expected) => {
    expect(isHumanPrompt(entry)).toBe(expected);
  });
});

describe("searchedSinceLastPrompt", () => {
  const newestFirst = (...lines: string[]) => [...lines].reverse();

  it("is true when a lookup follows the latest prompt", () => {
    expect(searchedSinceLastPrompt(newestFirst(prompt("a"), toolUse("Grep"), toolResult()))).toBe(true);
  });

  it("is false when the only lookup belongs to an earlier prompt", () => {
    expect(searchedSinceLastPrompt(newestFirst(prompt("a"), toolUse("Grep"), prompt("b"), toolUse("Read")))).toBe(false);
  });

  it("is null when the transcript holds no prompt and no lookup", () => {
    expect(searchedSinceLastPrompt(newestFirst(toolUse("Read"), toolResult(), "not json"))).toBeNull();
  });
});

describe("readLinesBackward", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codesift-lines-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns every line newest first across chunk boundaries without splitting multi-byte characters", () => {
    const path = join(dir, "t.jsonl");
    const lines = ["first", "zażółć gęślą jaźń", "x".repeat(25), "last"];
    writeFileSync(path, lines.join("\n") + "\n");
    expect([...readLinesBackward(path, 1_000_000, 7)]).toEqual([...lines].reverse());
  });

  it("drops the partial oldest line when the byte cap cuts the file", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "aaaaaaaaaa\nbbb\nccc\n");
    expect([...readLinesBackward(path, 9, 4)]).toEqual(["ccc", "bbb"]);
  });
});

describe("handlePrecheckWrite", () => {
  let dataDir: string;
  let repo: string;
  let exitCode: number | undefined;
  let stdout: string;

  const transcript = (...lines: string[]) => {
    const path = join(dataDir, "session.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  };
  const run = async (filePath: string, transcriptPath: string, extra: Record<string, unknown> = {}) => {
    process.env["HOOK_TOOL_INPUT"] = JSON.stringify({
      tool_name: "Write",
      transcript_path: transcriptPath,
      tool_input: { file_path: filePath, content: "export const x = 1;\n" },
      ...extra,
    });
    await handlePrecheckWrite();
  };
  const denied = () => stdout.includes('"permissionDecision":"deny"');

  beforeEach(() => {
    exitCode = undefined;
    stdout = "";
    hookEnv.serverRunning = true;
    dataDir = mkdtempSync(join(tmpdir(), "codesift-write-hook-"));
    repo = mkdtempSync(join(tmpdir(), "codesift-write-repo-"));
    const indexPath = join(dataDir, "repo.index.json");
    writeFileSync(indexPath, "{}");
    writeFileSync(join(dataDir, "registry.json"), JSON.stringify({
      updated_at: Date.now(),
      repos: { "local/repo": { name: "local/repo", root: repo, index_path: indexPath, symbol_count: 1, file_count: 1, updated_at: Date.now() } },
    }));
    process.env["CODESIFT_DATA_DIR"] = dataDir;
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code ?? 0;
      return undefined as never;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["HOOK_TOOL_INPUT"];
    delete process.env["CODESIFT_DATA_DIR"];
    delete process.env["CODESIFT_SEARCH_FIRST"];
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("denies a new source file when nothing was looked up since the prompt, naming the lookups", async () => {
    await run(join(repo, "src", "format-percent.ts"), transcript(prompt("add a percent formatter"), toolUse("Read")));
    expect(denied()).toBe(true);
    expect(stdout).toContain('search_symbols(query=\\"format-percent\\")');
    expect(exitCode).toBe(0);
  });

  it("suggests grep instead of CodeSift tools the caller does not have", async () => {
    hookEnv.serverRunning = false;
    await run(join(repo, "src", "format-percent.ts"), transcript(prompt("add a percent formatter")));
    expect(stdout).toContain("grep -rn");
    expect(stdout).not.toContain("semantic_search");
  });

  it("allows the file once a lookup happened after the prompt", async () => {
    await run(join(repo, "src", "format-percent.ts"), transcript(prompt("add it"), toolUse("mcp__codesift__search_symbols"), toolResult()));
    expect(denied()).toBe(false);
  });

  it.each([
    ["an existing file (an overwrite, not new code)", "existing.ts"],
    ["a test file", "src/format-percent.test.ts"],
    ["a type declaration", "src/types.d.ts"],
    ["a non-code file", "docs/notes.md"],
  ])("never gates %s", async (_label, rel) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "existing.ts"), "export {};\n");
    await run(join(repo, rel), transcript(prompt("go")));
    expect(denied()).toBe(false);
  });

  it("does not gate a file outside every indexed repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codesift-outside-"));
    await run(join(outside, "x.ts"), transcript(prompt("go")));
    expect(denied()).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("is off with CODESIFT_SEARCH_FIRST=0", async () => {
    process.env["CODESIFT_SEARCH_FIRST"] = "0";
    await run(join(repo, "src", "a.ts"), transcript(prompt("go")));
    expect(denied()).toBe(false);
  });

  it("judges a subagent by its own transcript, not the parent's", async () => {
    // The parent searched; the subagent did not. Reading the parent's transcript would let the subagent through.
    const parent = transcript(prompt("go"), toolUse("Grep"));
    const subDir = join(dataDir, "session", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-a1.jsonl"), prompt("Build the formatter", undefined) + "\n");
    await run(join(repo, "src", "a.ts"), parent, { agent_id: "a1" });
    expect(denied()).toBe(true);
  });

  it("allows when the subagent transcript cannot be found", async () => {
    await run(join(repo, "src", "a.ts"), transcript(prompt("go")), { agent_id: "missing" });
    expect(denied()).toBe(false);
  });
});
