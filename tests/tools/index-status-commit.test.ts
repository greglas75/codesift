// Which commit the index describes, and whether the tree has moved since.
//
// `index_status` answered `indexed=true` plus a timestamp and nothing else. That cannot distinguish
// an index built minutes ago on a DIFFERENT commit from one built yesterday on this one. Measured
// on tgm-survey-platform 2026-09-06: the index sat at c58a7218ab8c while the tree was on 113242d54,
// and the tool reported `indexed=true` with a timestamp — so an agent asking exactly this question
// got no answer and fell back to reading files by hand.
//
// The SHA is not in the index database: `meta` carries created_at, extractor_version, repo, root,
// schema_version, updated_at and workspaces. 119 of 122 local repositories here have it only in the
// registry, which is why it has to be passed in rather than read off the summary.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexStatus } from "../../src/tools/status-tools.js";
import { indexFolder } from "../../src/tools/index-tools/folder-indexer.js";
import { resetConfigCache } from "../../src/config.js";

let dataDir: string;
let repo: string;
let prevData: string | undefined;
let repoName: string;

const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });

beforeEach(async () => {
  prevData = process.env["CODESIFT_DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "cs-status-data-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  resetConfigCache();

  repo = mkdtempSync(join(tmpdir(), "cs-status-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function a(): void {}\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "src/a.ts"]);
  git(["commit", "-q", "-m", "one"]);

  repoName = (await indexFolder(repo, { watch: false })).repo;
});

afterEach(() => {
  if (prevData === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevData;
  resetConfigCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("index_status commit reporting", () => {
  it("says the index matches HEAD right after indexing", async () => {
    const status = await indexStatus(repoName);
    expect(status.indexed).toBe(true);
    expect(status.commit?.head).toBe(git(["rev-parse", "HEAD"]).trim());
    expect(status.commit?.matches).toBe(true);
  }, 60_000);

  it("reports the drift, and how many files it covers, once the tree moves", async () => {
    const indexedAt = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "src", "b.ts"), "export function b(): void {}\n");
    git(["add", "src/b.ts"]);
    git(["commit", "-q", "-m", "two"]);

    const status = await indexStatus(repoName);

    expect(status.commit?.indexed).toBe(indexedAt);
    expect(status.commit?.head).toBe(git(["rev-parse", "HEAD"]).trim());
    expect(status.commit?.matches).toBe(false);
    // Two commits apart and one file apart call for different decisions, and an agent cannot work
    // that out from a pair of hashes.
    expect(status.commit?.files_changed).toBe(1);
  }, 60_000);

  it("never reports `matches` when a commit could not be established", async () => {
    // "Same commit" and "could not tell" must not render identically: an absent field read as
    // agreement is the failure this whole field exists to prevent.
    const status = await indexStatus(repoName);
    if (status.commit?.indexed === undefined || status.commit?.head === undefined) {
      expect(status.commit?.matches).toBeUndefined();
    } else {
      expect(typeof status.commit.matches).toBe("boolean");
    }
  }, 60_000);

  it("still answers when the directory is not a git checkout at all", async () => {
    // A status tool that throws because git is unavailable is worse than one that says less: it is
    // on the path of nearly every session — 876 calls in six hours in this machine's telemetry.
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const status = await indexStatus(repoName);
    expect(status.indexed).toBe(true);
    expect(status.commit?.matches).toBeUndefined();
  }, 60_000);
});
