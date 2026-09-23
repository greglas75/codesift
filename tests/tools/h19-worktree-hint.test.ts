/**
 * H19 — the wrong-tree warning, and the two ways it was wrong in practice.
 *
 * Measured on one machine over 14 days: 2,721 firings, **2,678 (98.4%) on a repo the caller had
 * named with the `@<worktree>` suffix**, none on a path; and one 26-hour session collected 932
 * copies of it, all after that session's first `index_folder`. So the hint was mostly announcing
 * that a deliberate choice had been honoured, and announcing it again on every call.
 *
 * Built on a REAL git worktree, like tests/utils/worktree.test.ts, because the thing under test is
 * a belief about git's layout — a hand-written `.git` file would encode the same belief and pass
 * while the product stayed broken.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildResponseHint, resetSessionState } from "../../src/server-helpers.js";

/**
 * Assert on H19 specifically, not on `null`: other hints legitimately ride the same string (the
 * first version of this test asserted null and failed on H11's "0 matches" nudge, which is a
 * correct hint about the fixture's empty result, not the behaviour under test).
 */
function h19(tool: string, args: Record<string, unknown>, data: unknown = []): boolean {
  return (buildResponseHint(tool, args, data) ?? "").includes("H19");
}

let base: string;
let main: string;
let linked: string;
let prevDataDir: string | undefined;
let gitAvailable = true;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
    },
  });
}

beforeAll(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), "codesift-h19-")));
  main = join(base, "repo");
  await mkdir(join(main, "src"), { recursive: true });
  try {
    git(main, "init", "-q", "-b", "main");
    await writeFile(join(main, "src", "a.ts"), "export const a = 1;\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "init");
    linked = join(main, ".worktrees", "task-1");
    git(main, "worktree", "add", "-q", "-b", "task-1", linked);
  } catch {
    gitAvailable = false;
  }

  // Both trees indexed under their own names — the state that produced the 2,678 false alarms.
  await writeFile(
    join(base, "registry.json"),
    JSON.stringify({
      repos: {
        "local/repo": { name: "local/repo", root: main, symbol_count: 100, file_count: 10 },
        "local/repo@task-1": { name: "local/repo@task-1", root: linked, symbol_count: 100, file_count: 10 },
      },
      updated_at: Date.now(),
    }),
    "utf-8",
  );
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = base;
});

afterAll(async () => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  resetSessionState();
  vi.restoreAllMocks();
});

describe("H19 — an explicitly named worktree is not a surprise", () => {
  it("stays silent when the repo carries the @worktree suffix", () => {
    if (!gitAvailable) return;
    // CWD is the MAIN checkout, the call names the linked worktree by its own registry name.
    vi.spyOn(process, "cwd").mockReturnValue(main);
    expect(h19("search_text", { repo: "local/repo@task-1", query: "a" })).toBe(false);
  });

  it("still warns on a BARE name that resolves to the other checkout", () => {
    if (!gitAvailable) return;
    // The dangerous case, untouched: sitting in the worktree, answered from the parent. This is the
    // shape that served 4042 lines for a file that was 1415 in the caller's own tree.
    vi.spyOn(process, "cwd").mockReturnValue(linked);
    const hint = buildResponseHint("search_text", { repo: "local/repo", query: "a" }, []);
    expect(hint).toContain("H19");
    expect(hint).toContain("index_folder");
  });

  it("says nothing when the answer comes from the caller's own tree", () => {
    if (!gitAvailable) return;
    vi.spyOn(process, "cwd").mockReturnValue(linked);
    expect(h19("search_text", { repo: "local/repo@task-1", query: "a" })).toBe(false);
  });
});

describe("H19 — said once per repo, not once per call", () => {
  it("warns on the first call and is quiet on the next two", () => {
    if (!gitAvailable) return;
    vi.spyOn(process, "cwd").mockReturnValue(linked);
    expect(h19("search_text", { repo: "local/repo", query: "a" })).toBe(true);
    // 932 copies in one session is what this prevents.
    expect(h19("get_file_outline", { repo: "local/repo", file_path: "src/a.ts" })).toBe(false);
    expect(h19("search_text", { repo: "local/repo", query: "b" })).toBe(false);
  });

  it("warns again in a new session — the mute is per session, not permanent", () => {
    if (!gitAvailable) return;
    vi.spyOn(process, "cwd").mockReturnValue(linked);
    expect(h19("search_text", { repo: "local/repo", query: "a" })).toBe(true);
    // A fresh session must warn again — the memory is a per-session mute, not a permanent one.
    resetSessionState();
    expect(h19("search_text", { repo: "local/repo", query: "a" })).toBe(true);
  });
});
