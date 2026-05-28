/**
 * Regression: stale_index must reflect real index drift (git HEAD vs
 * last_git_commit), not "5 min elapsed since last write". The historical
 * time-based heuristic produced false positives in read-mostly sessions and
 * caused downstream agents (Codex) to distrust correct CodeSift results.
 *
 * See: src/tools/plan-turn-tools.ts isStaleIndex
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isStaleIndex, safeReadGitHead } from "../../src/tools/plan-turn-tools.js";
import type { CodeIndex } from "../../src/types.js";

function makeIndex(root: string, updatedAtMs: number): CodeIndex {
  return {
    repo: "test",
    root,
    symbols: [],
    files: [],
    created_at: updatedAtMs,
    updated_at: updatedAtMs,
    symbol_count: 0,
    file_count: 0,
  };
}

function initGitRepo(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "codesift-stale-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@e.st"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(join(root, "README"), "x");
  execFileSync("git", ["add", "README"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  return { root, sha };
}

describe("isStaleIndex", () => {
  let repos: string[] = [];
  beforeEach(() => {
    repos = [];
  });
  afterEach(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  it("real git HEAD matches last_git_commit → NOT stale, regardless of age", () => {
    // 6 minutes ago — would have tripped the old 5-min heuristic.
    const { root, sha } = initGitRepo();
    repos.push(root);
    const index = makeIndex(root, Date.now() - 6 * 60 * 1000);

    expect(isStaleIndex(index, sha)).toBe(false);
  });

  it("real git HEAD diverged from last_git_commit → STALE", () => {
    const { root } = initGitRepo();
    repos.push(root);
    // Make a second commit so the recorded SHA no longer matches HEAD.
    writeFileSync(join(root, "README"), "y");
    execFileSync("git", ["commit", "-aq", "-m", "second"], { cwd: root });
    const staleSha = "0".repeat(40);
    const index = makeIndex(root, Date.now());

    expect(isStaleIndex(index, staleSha)).toBe(true);
  });

  it("no git available → falls back to 24h time threshold (NOT 5 min)", () => {
    const root = mkdtempSync(join(tmpdir(), "codesift-stale-nogit-"));
    repos.push(root);
    // 6 minutes ago — would have tripped the old 5-min heuristic. With the
    // 24h fallback it is fresh.
    const fresh = makeIndex(root, Date.now() - 6 * 60 * 1000);
    expect(isStaleIndex(fresh, undefined)).toBe(false);

    // 25 hours ago — fallback threshold passed.
    const old = makeIndex(root, Date.now() - 25 * 60 * 60 * 1000);
    expect(isStaleIndex(old, undefined)).toBe(true);
  });

  it("safeReadGitHead returns null for non-git directory without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "codesift-stale-nogit2-"));
    repos.push(root);
    expect(safeReadGitHead(root)).toBeNull();
  });

  it("safeReadGitHead returns the live HEAD for a git checkout", () => {
    const { root, sha } = initGitRepo();
    repos.push(root);
    expect(safeReadGitHead(root)).toBe(sha);
  });
});
