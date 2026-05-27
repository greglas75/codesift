import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture spawn / spawnSync so auto-regen never launches a real process and the
// git-staleness probe is deterministic.
const mockSpawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
const mockSpawnSync = vi.fn(() => ({ status: 1, stdout: "" }));
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => mockSpawn(...a),
  spawnSync: (...a: unknown[]) => mockSpawnSync(...a),
}));

const mockIndexFile = vi.fn().mockResolvedValue({ indexed: 1 });
vi.mock("../../src/tools/index-tools.js", () => ({
  indexFile: (...args: unknown[]) => mockIndexFile(...args),
}));

import {
  handleSessionStart,
  handlePostindexFile,
  wikiOverviewMaxChars,
} from "../../src/cli/hooks.js";

const V2_MANIFEST = {
  schema_version: 2,
  git_commit: "unknown",
  generated_at: "2026-05-27T00:00:00.000Z",
  project: {
    name: "demo-app",
    stack: { language: "typescript", framework: "hono", test_runner: "vitest", package_manager: "npm" },
    entry_points: ["src/server.ts"],
    known_gotchas: [
      { gotcha: "indexes must stay in sync", severity: "high" },
      { gotcha: "low note", severity: "low" },
    ],
  },
  modules: [
    { slug: "search", name: "Search", description: "BM25F + semantic retrieval engine." },
    { slug: "tools", name: "Tools", description: "MCP tool handlers." },
  ],
};

function writeManifest(repoRoot: string, manifest: unknown): void {
  const wikiDir = join(repoRoot, ".codesift", "wiki");
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(join(wikiDir, "wiki-manifest.json"), JSON.stringify(manifest));
}

describe("wikiOverviewMaxChars (env var + NaN guard)", () => {
  afterEach(() => { delete process.env.CODESIFT_WIKI_OVERVIEW_MAX_CHARS; });

  it("defaults to 1800", () => {
    expect(wikiOverviewMaxChars()).toBe(1800);
  });
  it("honors a positive override", () => {
    process.env.CODESIFT_WIKI_OVERVIEW_MAX_CHARS = "500";
    expect(wikiOverviewMaxChars()).toBe(500);
  });
  it("falls back on NaN / non-positive", () => {
    process.env.CODESIFT_WIKI_OVERVIEW_MAX_CHARS = "nope";
    expect(wikiOverviewMaxChars()).toBe(1800);
    process.env.CODESIFT_WIKI_OVERVIEW_MAX_CHARS = "-5";
    expect(wikiOverviewMaxChars()).toBe(1800);
  });
});

describe("handleSessionStart — project overview injection", () => {
  let stdoutOutput: string;
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    stdoutOutput = "";
    tmpDir = mkdtempSync(join(tmpdir(), "hook-overview-"));
    // Isolate telemetry writes so logWikiEvent never touches the real ~/.codesift.
    dataDir = mkdtempSync(join(tmpdir(), "hook-overview-data-"));
    process.env.CODESIFT_DATA_DIR = dataDir;
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput += String(chunk);
      return true;
    });
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    delete process.env.HOOK_TOOL_INPUT;
    delete process.env.CODESIFT_WIKI_OVERVIEW;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
    delete process.env.CODESIFT_DATA_DIR;
    delete process.env.CODESIFT_WIKI_OVERVIEW;
  });

  function usageEvents(): Array<Record<string, unknown>> {
    try {
      return readFileSync(join(dataDir, "usage.jsonl"), "utf-8")
        .trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch { return []; }
  }

  function parsedContext(): string {
    const obj = JSON.parse(stdoutOutput) as { hookSpecificOutput?: { additionalContext?: string } };
    return obj.hookSpecificOutput?.additionalContext ?? "";
  }

  it("appends project + modules from a v2 manifest", async () => {
    writeManifest(tmpDir, V2_MANIFEST);
    await handleSessionStart();
    const ctx = parsedContext();
    expect(ctx).toContain("CodeSift MCP is available");
    expect(ctx).toContain("Project: demo-app");
    expect(ctx).toContain("typescript");
    expect(ctx).toContain("Search");
    expect(ctx).toContain("BM25F + semantic retrieval engine.");
    // high-severity gotcha surfaces; static prompt still present
    expect(ctx).toContain("indexes must stay in sync");
    expect(ctx).toContain("Entry points: src/server.ts");
    // telemetry: an injection event is logged to usage.jsonl
    const ev = usageEvents().find((e) => e.tool === "wiki_overview_injected");
    expect(ev).toBeDefined();
    expect((ev!.args_summary as Record<string, unknown>).modules).toBe(2);
  });

  it("logs NO telemetry when no overview is injected (v1 manifest)", async () => {
    writeManifest(tmpDir, { generated_at: "x", git_commit: "unknown" });
    await handleSessionStart();
    expect(usageEvents().some((e) => e.tool === "wiki_overview_injected")).toBe(false);
  });

  it("emits only the static prompt for a v1 manifest", async () => {
    writeManifest(tmpDir, { generated_at: "x", git_commit: "unknown" }); // no schema_version
    await handleSessionStart();
    const ctx = parsedContext();
    expect(ctx).toContain("CodeSift MCP is available");
    expect(ctx).not.toContain("Project: ");
  });

  it("skips overview when CODESIFT_WIKI_OVERVIEW=0", async () => {
    writeManifest(tmpDir, V2_MANIFEST);
    process.env.CODESIFT_WIKI_OVERVIEW = "0";
    await handleSessionStart();
    expect(parsedContext()).not.toContain("Project: demo-app");
  });

  it("emits only the static prompt when no manifest exists", async () => {
    await handleSessionStart();
    const ctx = parsedContext();
    expect(ctx).toContain("CodeSift MCP is available");
    expect(ctx).not.toContain("Project: ");
  });
});

describe("handlePostindexFile — auto wiki regeneration", () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    mockSpawn.mockClear();
    mockIndexFile.mockClear();
    tmpDir = mkdtempSync(join(tmpdir(), "hook-regen-"));
    dataDir = mkdtempSync(join(tmpdir(), "hook-regen-data-"));
    process.env.CODESIFT_DATA_DIR = dataDir;
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HOOK_TOOL_INPUT;
    delete process.env.CODESIFT_DATA_DIR;
    delete process.env.CODESIFT_WIKI_AUTO_REGEN;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  function fireEdit(): Promise<void> {
    const filePath = join(tmpDir, "src", "foo.ts");
    process.env.HOOK_TOOL_INPUT = JSON.stringify({ tool_input: { file_path: filePath } });
    return handlePostindexFile();
  }

  it("spawns wiki-generate when a wiki manifest exists", async () => {
    writeManifest(tmpDir, V2_MANIFEST);
    await fireEdit();
    expect(mockIndexFile).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledOnce();
    const args = mockSpawn.mock.calls[0] as unknown as [string, string[], { cwd: string; detached: boolean }];
    expect(args[1]).toContain("wiki-generate");
    expect(args[2].cwd).toBe(tmpDir);
    expect(args[2].detached).toBe(true);
    // telemetry: a wiki_auto_regen event is logged
    const events = readFileSync(join(dataDir, "usage.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.tool === "wiki_auto_regen")).toBe(true);
  });

  it("does NOT spawn when the repo has no wiki", async () => {
    await fireEdit();
    expect(mockIndexFile).toHaveBeenCalledOnce();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does NOT spawn when CODESIFT_WIKI_AUTO_REGEN=0", async () => {
    writeManifest(tmpDir, V2_MANIFEST);
    process.env.CODESIFT_WIKI_AUTO_REGEN = "0";
    await fireEdit();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("throttles repeated regenerations within the window", async () => {
    writeManifest(tmpDir, V2_MANIFEST);
    await fireEdit();
    // Second edit to a different file in the same repo, past the per-file
    // reindex debounce but inside the wiki-regen window.
    const other = join(tmpDir, "src", "bar.ts");
    process.env.HOOK_TOOL_INPUT = JSON.stringify({ tool_input: { file_path: other } });
    await handlePostindexFile();
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("structural gate: edit to a KNOWN file does NOT regen", async () => {
    // foo.ts (the file fireEdit touches) is already in the wiki's file map.
    writeManifest(tmpDir, { ...V2_MANIFEST, file_to_community: { "src/foo.ts": "search" } });
    await fireEdit();
    expect(mockIndexFile).toHaveBeenCalledOnce(); // still reindexes the file
    expect(mockSpawn).not.toHaveBeenCalled();     // but no wiki regen
  });

  it("structural gate: edit to a NEW file regenerates", async () => {
    // foo.ts is NOT in the map → structure changed → regen.
    writeManifest(tmpDir, { ...V2_MANIFEST, file_to_community: { "src/other.ts": "tools" } });
    await fireEdit();
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("size gate: skips regen for repos over the file cap", async () => {
    const bigMap: Record<string, string> = {};
    for (let i = 0; i < 12; i++) bigMap[`src/f${i}.ts`] = "m";
    writeManifest(tmpDir, { ...V2_MANIFEST, file_to_community: bigMap });
    process.env.CODESIFT_WIKI_AUTO_REGEN_MAX_FILES = "10"; // cap below 12
    await fireEdit();
    expect(mockSpawn).not.toHaveBeenCalled();
    delete process.env.CODESIFT_WIKI_AUTO_REGEN_MAX_FILES;
  });
});
