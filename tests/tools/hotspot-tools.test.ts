import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeHotspots } from "../../src/tools/hotspot-tools.js";
import type { CodeIndex } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock getCodeIndex — returns an index whose .root points at our temp git repo
// ---------------------------------------------------------------------------

let repoRoot = "";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: async (_repo: string): Promise<CodeIndex> => ({
    repo: "test",
    root: repoRoot,
    symbols: [],
    files: [
      { path: "src/a.ts", symbol_count: 10, language: "typescript" } as any,
      { path: "src/b.ts", symbol_count: 5, language: "typescript" } as any,
      { path: "src/c.ts", symbol_count: 8, language: "typescript" } as any,
    ],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 23,
    file_count: 3,
  }),
}));

// ---------------------------------------------------------------------------
// Build a fixture git repo: 12 commits mutating 3 files within the last 7 days
// ---------------------------------------------------------------------------

function gitRun(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } });
}

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "codesift-hotspot-test-"));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  gitRun(["init", "-q", "-b", "main"], repoRoot);
  gitRun(["config", "user.email", "t@t"], repoRoot);
  gitRun(["config", "user.name", "T"], repoRoot);

  // 12 commits across 3 files — all within last day, well inside default 90d window
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
  for (let i = 0; i < 12; i++) {
    const f = files[i % files.length]!;
    writeFileSync(join(repoRoot, f), `export const v${i} = ${i};\nconst extra${i} = "x".repeat(${i + 1});\n`);
    gitRun(["add", f], repoRoot);
    gitRun(["commit", "-q", "-m", `change ${i} on ${f}`], repoRoot);
  }
});

afterAll(() => {
  if (repoRoot && existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
});

describe("analyzeHotspots — empty-result regression (Pattern E)", () => {
  it("returns ≥3 hotspots on a 12-commit fixture repo modifying 3 indexed files", async () => {
    const result = await analyzeHotspots("test", { since_days: 90 });

    // Core regression: structure-audit-2026-04-30.md saw `analyze_hotspots` return
    // EMPTY on a 2,376-commit repo. Even on this tiny fixture the same code path
    // must surface real hotspots.
    expect(result.hotspots.length).toBeGreaterThanOrEqual(3);

    // Sanity: each hotspot has plausible numbers
    for (const h of result.hotspots) {
      expect(h.commits).toBeGreaterThan(0);
      expect(h.lines_changed).toBeGreaterThan(0);
      expect(h.hotspot_score).toBeGreaterThan(0);
    }
  });

  it("when no commits in window: returns empty WITH a diagnostic note in result", async () => {
    // since_days=0 means "last 0 days ago" — git interprets this as no time window
    // matching, returning effectively empty. The fix should surface this clearly
    // rather than silently returning empty hotspots.
    const result = await analyzeHotspots("test", { since_days: 0 });

    // Either empty hotspots are returned WITH a `note` field flagging the empty
    // result, OR the function falls back to --all and finds the same commits.
    // Both are acceptable; what's NOT acceptable is silently returning empty.
    if (result.hotspots.length === 0) {
      expect((result as any).note).toMatch(/empty|no commits|fallback/i);
    } else {
      // Fallback path found commits — that's also fine
      expect(result.hotspots.length).toBeGreaterThan(0);
    }
  });
});
