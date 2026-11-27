import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { closeAllIndexDbs, openIndexDb } from "../../src/storage/sqlite/connection.js";
import { resetIndexBackendForTesting, saveIndex } from "../../src/storage/index-store.js";
import type { CodeIndex } from "../../src/types.js";
import { HAS_NODE_SQLITE } from "../helpers/node-sqlite.js";

import {
  formatExistingCode,
  handlePrecheckWrite,
  isGatedNewFile,
  isHumanPrompt,
  isSearchToolUse,
  lookupNames,
  rankExistingFiles,
  rankExistingSymbols,
  readLinesBackward,
  relevantTerms,
  runInChild,
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

describe("isGatedNewFile", () => {
  it.each([
    ["a new POSIX source file", "/nonexistent-repo/src/a.ts", true],
    // Bug caught: the exclusion only knew `/`, so Windows paths into node_modules were gated.
    ["a Windows node_modules path", "C:\\nonexistent-repo\\node_modules\\pkg\\a.ts", false],
    ["a Windows dist path", "C:\\nonexistent-repo\\dist\\a.js", false],
  ])("%s → %s", (_label, path, expected) => {
    expect(isGatedNewFile(path)).toBe(expected);
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

  it("does not count a lookup that names none of the new file's words", () => {
    // Bug caught: any lookup unlocked the gate, and agents always search for something before writing
    const lines = newestFirst(prompt("a"), toolUse("Grep", { pattern: "useQuery" }));
    expect(searchedSinceLastPrompt(lines, ["format", "percent"])).toBe(false);
    expect(searchedSinceLastPrompt(lines)).toBe(true);
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

describe("relevantTerms", () => {
  it.each([
    ["kebab stem + folder", "/r/apps/reporting/format-percent.ts", ["format", "percent", "reporting"]],
    ["camelCase stem", "/r/src/lib/formatPercent.ts", ["format", "percent"]],
    // Bug caught: `HTTPClient` stayed one word, so a lookup for "client" never counted
    ["acronym stem", "/r/src/net/HTTPClient.ts", ["http", "client"]],
    // generic names say nothing about the code: any lookup counts for them
    ["generic stem and folder", "/r/src/utils/index.ts", []],
    ["Windows path", "C:\\r\\src\\quota\\quotaGuard.ts", ["quota", "guard"]],
    // Bug caught by the third review: non-ASCII letters split a word into fragments that became required terms
    ["non-ASCII stem", "/r/src/billing/płatności.ts", ["płatności", "billing"]],
  ])("%s → %j", (_label, path, expected) => {
    expect(relevantTerms(path)).toEqual(expected);
  });
});

describe("lookupNames", () => {
  it.each([
    ["a symbol query", "mcp__codesift__search_symbols", { query: "formatPercent" }, ["format", "percent"], true],
    ["a plural in a phrase", "mcp__codesift__semantic_search", { query: "percentages in reports" }, ["percent"], true],
    ["a kebab grep pattern", "Grep", { pattern: "format-percent" }, ["format", "percent"], true],
    ["a short form of a long word", "Grep", { pattern: "auth" }, ["authentication"], true],
    ["an unrelated query", "mcp__codesift__search_symbols", { query: "useQuery" }, ["format", "percent"], false],
    // Bugs caught by review: the whole serialized input was matched, so keys and paths unlocked the gate
    ["a term equal to a key name", "mcp__codesift__search_symbols", { query: "unrelatedSymbol" }, ["query", "cache"], false],
    ["the right folder, an unrelated pattern", "Grep", { pattern: "useQuery", path: "src/reporting" }, ["reporting"], false],
    ["a substring inside another word", "Grep", { pattern: "update" }, ["date"], false],
    ["find_clones over the folder", "mcp__codesift__find_clones", { file_pattern: "reporting" }, ["reporting"], true],
    // Bugs caught by the second review: regex escapes fused with the word, batch queries were objects
    ["a regex with word boundaries", "Grep", { pattern: "\\bpercent\\b" }, ["percent"], true],
    ["a batch of query objects", "mcp__codesift__codebase_retrieval", { queries: [{ type: "semantic", query: "percent formatter" }] }, ["percent"], true],
  ])("%s → %s", (_label, name, input, terms, expected) => {
    expect(lookupNames(name, input, terms)).toBe(expected);
  });
});

describe("rankExistingFiles", () => {
  const terms = { stem: ["format", "percent"], folder: ["utils"] };
  const rank = (paths: string[], t: { stem: string[]; folder: string[] } = terms, self = "apps/x/src/utils/format-percent.ts") => rankExistingFiles(paths, t, self);

  it.each([
    // a hint pointing at a test or a build copy sends the agent to the wrong file
    ["drops tests, declarations and build output",
      ["src/a/formatPercent.test.ts", "src/a/formatPercent.spec.tsx", "src/a/__tests__/formatPercent.ts", "src/formatPercent.d.ts",
        "node_modules/x/formatPercent.ts", "dist/formatPercent.js", "src/a/formatPercent.ts"],
      ["src/a/formatPercent.ts"]],
    // the file being created is not an "existing" duplicate of itself
    ["drops the file being created", ["apps/x/src/utils/format-percent.ts", "src/other/percent-format.ts"], ["src/other/percent-format.ts"]],
    // a folder word alone matches every file of a big folder: noise, not a duplicate
    ["needs a stem word, not only a folder word", ["src/utils/date.ts", "src/utils/format-percent.ts"], ["src/utils/format-percent.ts"]],
    // a lone `format` in `ranking-format.ts` is a coincidence for `format-percent.ts`
    ["a two-word stem needs both words", ["src/percent.ts", "src/percentFormatter.ts"], ["src/percentFormatter.ts"]],
    // same stem match: the file in the new file's own folder is likelier the duplicate
    ["a shared folder word breaks a tie between equal stem matches", ["src/lib/format-percent.ts", "src/utils/format-percent.ts"],
      ["src/utils/format-percent.ts", "src/lib/format-percent.ts"]],
    ["ignores non-code files", ["docs/percent.md", "data/percent.json"], []],
  ])("%s", (_label, paths, expected) => {
    expect(rank(paths)).toEqual(expected);
  });

  // `format-percent-label` must not list every `*-format.ts`: one matching word of three is a coincidence
  it("ranks more matching stem words first when the stem is long", () => {
    const stem = { stem: ["format", "percent", "label"], folder: [] };
    expect(rank(["src/a/format-label.ts", "src/format-percent-label.ts"], stem)).toEqual(["src/format-percent-label.ts", "src/a/format-label.ts"]);
  });

  it("a three-word stem needs two of its words", () => {
    const stem = { stem: ["format", "percent", "label"], folder: [] };
    expect(rank(["src/any-format.ts", "src/format-label.ts"], stem)).toEqual(["src/format-label.ts"]);
  });

  it("returns nothing when there is no word to match (it would list arbitrary files)", () => {
    expect(rank(["src/a.ts", "src/b.ts"], { stem: [], folder: [] })).toEqual([]);
  });

  it("falls back to folder words when the stem is all generic words, and shows at most 3", () => {
    const paths = ["a/percent/1.ts", "a/percent/2.ts", "a/percent/3.ts", "a/percent/4.ts"];
    expect(rank(paths, { stem: [], folder: ["percent"] })).toHaveLength(3);
  });
});

describe("rankExistingSymbols", () => {
  const sym = (name: string, kind = "function", file = "src/a.ts", start_line = 1) => ({ name, kind, file, start_line });
  const words = ["format", "percent"];

  it.each([
    // all stem words must be in the name: `formatDate` is not a duplicate of format-percent.ts
    ["requires every stem word, case-insensitively", [sym("formatDate"), sym("FORMAT_PERCENT_SIGN"), sym("percentFormatter")],
      ["percentFormatter", "FORMAT_PERCENT_SIGN"]],
    // the exact name is the likeliest duplicate, even when a shorter partial match exists
    ["puts the exact name first, then the shortest", [sym("formatPercentLabel"), sym("formatPercentage"), sym("formatPercent", "function", "src/b.ts")],
      ["formatPercent", "formatPercentage", "formatPercentLabel"]],
    ["keeps only code symbols, not variables or tests", [sym("formatPercentX", "variable"), sym("formatPercentY", "test_case"), sym("formatPercentZ", "class")],
      ["formatPercentZ"]],
    ["drops symbols living in test files", [sym("formatPercent", "function", "src/formatPercent.test.ts"), sym("formatPercent2", "function", "tests/a.ts")], []],
    ["lists the same name in two files twice, one name in one file once",
      [sym("formatPercent", "function", "a.ts"), sym("formatPercent", "function", "a.ts"), sym("formatPercent", "function", "b.ts")],
      ["formatPercent", "formatPercent"]],
  ])("%s", (_label, rows, expectedNames) => {
    expect(rankExistingSymbols(rows, words).map((r) => r.name)).toEqual(expectedNames);
  });

  it("matches upper-case stem words too (the contract is case-insensitive)", () => {
    expect(rankExistingSymbols([sym("formatPercent")], ["Format", "PERCENT"]).map((r) => r.name)).toEqual(["formatPercent"]);
  });

  it("returns nothing for an empty word list (it would match every symbol) and caps at 3", () => {
    expect(rankExistingSymbols([sym("a")], [])).toEqual([]);
    expect(rankExistingSymbols(["A", "B", "C", "D"].map((n) => sym(`formatPercent${n}`)), words)).toHaveLength(3);
  });
});

describe("formatExistingCode", () => {
  it.each([
    ["nothing found", { files: [], symbols: [] }],
    ["no lookup result", null],
  ])("is null for %s — an empty heading would be noise in the deny message", (_label, hits) => {
    expect(formatExistingCode(hits)).toBeNull();
  });

  it("lists files and symbols with kind and location", () => {
    expect(formatExistingCode({
      files: ["src/utils/formatPercent.ts"],
      symbols: [{ name: "formatPercent", kind: "function", file: "src/utils/formatPercent.ts", start_line: 12 }],
    })).toBe(
      "Existing code that may already do this:\n" +
      "  file   src/utils/formatPercent.ts\n" +
      "  symbol formatPercent (function) — src/utils/formatPercent.ts:12",
    );
  });
});

describe("runInChild", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codesift-child-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const module = (body: string) => {
    const path = join(dir, "m.mjs");
    writeFileSync(path, body);
    return pathToFileURL(path).href;
  };

  it("returns the export's result, passing the request through as JSON", async () => {
    const url = module("export const echo = async (r) => ({ got: r.n + 1 });");
    await expect(runInChild(url, "echo", { n: 41 }, 5000)).resolves.toEqual({ got: 42 });
  });

  // node:sqlite is synchronous: without killing the process a cold query overruns the hook's budget and nothing can stop it
  it("gives up on time with null when the call never returns, and kills it", async () => {
    const url = module("export const spin = async () => { while (true) {} };");
    const started = Date.now();
    await expect(runInChild(url, "spin", {}, 300)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it.each([
    ["an export that throws", "export const f = async () => { throw new Error('x'); };", "f"],
    ["an export that does not exist", "export const f = async () => 1;", "missing"],
    ["a module that fails to load", "export const f = ;", "f"],
  ])("answers null for %s — a broken lookup must mean no hints, never a failure", async (_label, body, name) => {
    await expect(runInChild(module(body), name, {}, 5000)).resolves.toBeNull();
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
    expect(denied()).toBe(true);
    expect(stdout).toContain("grep -rn");
    expect(stdout).not.toContain("semantic_search");
  });

  it("allows the file once a lookup naming it happened after the prompt", async () => {
    await run(join(repo, "src", "format-percent.ts"),
      transcript(prompt("add it"), toolUse("mcp__codesift__search_symbols", { query: "formatPercent" }), toolResult()));
    expect(denied()).toBe(false);
  });

  it("still denies when the only lookup since the prompt was about something else, naming the words it wants", async () => {
    await run(join(repo, "src", "format-percent.ts"),
      transcript(prompt("add it"), toolUse("Grep", { pattern: "useQuery" }), toolResult()));
    expect(denied()).toBe(true);
    expect(stdout).toContain('\\"format\\" or \\"percent\\"');
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
  describe("existing-code hints from the repo's SQLite index", () => {
    const itSqlite = HAS_NODE_SQLITE ? it : it.skip;
    const newFile = () => join(repo, "src", "format-percent.ts");
    const deniedMessage = async () => {
      await run(newFile(), transcript(prompt("add a percent formatter")));
      return stdout;
    };
    // Written by the storage layer's own writer, so a change to the schema or the path convention breaks these tests.
    const writeIndex = async (symbols: Array<[name: string, file: string, line: number, kind?: "function" | "variable"]>, files: string[] = []) => {
      process.env["CODESIFT_INDEX_BACKEND"] = "sqlite";
      resetIndexBackendForTesting();
      const paths = new Set([...files, ...symbols.map((x) => x[1])]);
      const index: CodeIndex = {
        repo: "local/repo", root: repo, created_at: 1, updated_at: 2,
        symbols: symbols.map(([name, file, line, kind]) => ({
          id: `local/repo:${file}:${name}:${line}`, repo: "local/repo", name, kind: kind ?? "function", file, start_line: line, end_line: line + 1,
        })),
        files: [...paths].map((path) => ({ path, language: "typescript", symbol_count: 0, last_modified: 1 })),
        symbol_count: symbols.length, file_count: paths.size,
      };
      await saveIndex(join(dataDir, "repo.index.json"), index);
    };
    afterEach(() => {
      closeAllIndexDbs();
      delete process.env["CODESIFT_INDEX_BACKEND"];
      resetIndexBackendForTesting();
    });

    itSqlite("shows the likely duplicate (file and symbol) in the deny message, without tests", async () => {
      await writeIndex(
        [["formatPercent", "src/utils/formatPercent.ts", 12], ["formatPercent", "src/utils/formatPercent.test.ts", 3], ["formatPercentBag", "src/x.ts", 1, "variable"]],
        ["src/unrelated.ts"],
      );
      const out = await deniedMessage();
      expect(denied()).toBe(true);
      expect(out).toContain("Existing code that may already do this:");
      expect(out).toContain("src/utils/formatPercent.ts");
      expect(out).toContain("formatPercent (function) — src/utils/formatPercent.ts:12");
      expect(out).not.toContain("formatPercent.test.ts");
      expect(out).not.toContain("formatPercentBag");
      expect(out).not.toContain("unrelated");
    });

    // The daemon or an indexer holds the index open, mid-transaction: the hook must still read the last committed state.
    itSqlite("reads an index another connection holds open with a write transaction pending", async () => {
      await writeIndex([["formatPercent", "src/utils/formatPercent.ts", 12]]);
      const writer = await openIndexDb(join(dataDir, "repo.index.db"));
      writer.exec("BEGIN IMMEDIATE");
      try {
        expect(await deniedMessage()).toContain("formatPercent (function)");
      } finally {
        writer.exec("ROLLBACK");
      }
    });

    itSqlite("sends no block when the index holds nothing similar", async () => {
      await writeIndex([], ["src/unrelated.ts"]);
      expect(await deniedMessage()).not.toContain("Existing code");
      expect(denied()).toBe(true);
    });

    // A missing or broken index must never turn the nudge into a crash, a hang or a different verdict.
    it.each([
      ["no database beside the registry entry", undefined],
      ["an unreadable database file", "this is not a sqlite file"],
    ])("falls back to the plain deny message with %s", async (_label, content) => {
      if (content !== undefined) writeFileSync(join(dataDir, "repo.index.db"), content);
      const out = await deniedMessage();
      expect(denied()).toBe(true);
      expect(out).not.toContain("Existing code");
      expect(out).toContain('search_symbols(query=\\"format-percent\\")');
      expect(exitCode).toBe(0);
    });
  });
});
