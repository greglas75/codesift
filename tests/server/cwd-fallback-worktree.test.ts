// `resolveRepoFromCwd` fell back to `local/${basename(cwd)}` without checking that a repo of that
// name describes THIS directory. Codex names each of its worktrees after the repo, so
// `~/.codex/worktrees/284e/tgm-survey-platform` produced `local/tgm-survey-platform` — a REAL and
// completely different checkout.
//
// Measured 2026-08-18: eight sessions working in such worktrees had scan_secrets, find_clones and
// nest_audit answering from the MAIN tree without a word, while every index_file in the same
// sessions failed 43/43 — that resolver matches by root prefix and correctly found nothing. Two
// resolvers, two answers, and the silent one was the wrong one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveRepoFromCwd, _resetRegistryCacheForTests } from "../../src/server-helpers/repo-resolution.js";

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });

let base: string;
let registryPath: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cs-cwdfb-"));
  registryPath = join(base, "registry.json");
  _resetRegistryCacheForTests();
});

afterEach(() => {
  _resetRegistryCacheForTests();
  rmSync(base, { recursive: true, force: true });
});

describe("resolveRepoFromCwd fallback", () => {
  it("does not hand a worktree the name of an unrelated repo that happens to match its basename", () => {
    // The real repo, registered.
    const real = join(base, "proj");
    mkdirSync(join(real, "src"), { recursive: true });
    writeFileSync(join(real, "src", "a.ts"), "export const a = 1;\n");
    git(["init", "-q", "-b", "main"], real);
    git(["config", "user.email", "t@t"], real);
    git(["config", "user.name", "t"], real);
    git(["add", "-A"], real);
    git(["commit", "-qm", "init"], real);

    // A worktree elsewhere, in a directory named the SAME as the repo — the Codex layout.
    const elsewhere = join(base, "agent-worktrees", "abcd");
    mkdirSync(elsewhere, { recursive: true });
    const wt = join(elsewhere, basename(real));
    git(["worktree", "add", "-q", "-b", "task", wt], real);

    writeFileSync(registryPath, JSON.stringify({
      repos: { "local/proj": { name: "local/proj", root: real, index_path: join(base, "x.index.json"), symbol_count: 5 } },
      updated_at: 1,
    }));

    const resolved = resolveRepoFromCwd(wt, registryPath);

    // The whole point: it must NOT claim to be the registered repo, whose files are different.
    expect(resolved).not.toBe("local/proj");
    // And it must be the name index_folder would register this tree under, so the advice the tools
    // then give ("run index_folder") produces exactly this name.
    expect(resolved).toContain("@");
  });

  it("still resolves the registered repo when the cwd really is inside it", () => {
    const real = join(base, "proj2");
    mkdirSync(join(real, "src"), { recursive: true });
    writeFileSync(join(real, "src", "a.ts"), "export const a = 1;\n");
    git(["init", "-q", "-b", "main"], real);

    writeFileSync(registryPath, JSON.stringify({
      repos: { "local/proj2": { name: "local/proj2", root: real, index_path: join(base, "y.index.json"), symbol_count: 5 } },
      updated_at: 1,
    }));

    expect(resolveRepoFromCwd(join(real, "src"), registryPath)).toBe("local/proj2");
  });
});
