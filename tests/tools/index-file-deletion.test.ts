// Agents are told to call `index_file` after editing, and deleting or renaming a file IS editing.
// Unguarded, `stat` escaped as a raw `ENOENT: no such file or directory, stat '<abs>'` — a
// Node-level string naming neither the repo nor the next step, and one of three indistinguishable
// ~3ms failures behind index_file's 8.8% error rate across five external installs.
//
// The deeper half: the index KEPT the deleted file's symbols. `handleFileDelete` lives in the
// watcher only, and the CLI hook (`codesift postindex-file`) is a fresh process with no watcher —
// so the path agents are told to use had no deletion branch at all.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { indexFolder } from "../../src/tools/index-tools/folder-indexer.js";
import { indexFile } from "../../src/tools/index-tools/file-indexer.js";
import { resetConfigCache } from "../../src/config.js";

let dataDir: string;
let repo: string;
let prevData: string | undefined;

beforeEach(() => {
  prevData = process.env["CODESIFT_DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "cs-del-data-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  resetConfigCache();

  repo = mkdtempSync(join(tmpdir(), "cs-del-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "keep.ts"), "export function keeper(): void {}\n");
  writeFileSync(join(repo, "src", "doomed.ts"), "export function doomed(): void {}\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
});

afterEach(() => {
  if (prevData === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevData;
  resetConfigCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("index_file on a deleted file", () => {
  it("prunes it from the index instead of throwing a raw ENOENT", async () => {
    await indexFolder(repo, { watch: false });
    unlinkSync(join(repo, "src", "doomed.ts"));

    const result = await indexFile(join(repo, "src", "doomed.ts"));

    expect(result.removed).toBe(true);
    expect(result.file).toBe("src/doomed.ts");
    expect(result.symbol_count).toBe(0);
  }, 60_000);

  it("actually removes the symbols, so stale ones cannot outlive the file", async () => {
    // The point of the whole change: a caller that gets `removed: true` and still finds the symbol
    // is worse off than one that got an error, because now it believes the index is correct.
    const { getCodeIndex } = await import("../../src/tools/index-tools/registry.js");
    const first = await indexFolder(repo, { watch: false });
    unlinkSync(join(repo, "src", "doomed.ts"));
    await indexFile(join(repo, "src", "doomed.ts"));

    const index = await getCodeIndex(first.repo);
    expect(index?.symbols.some((s) => s.name === "doomed")).toBe(false);
    // The surviving file is untouched — pruning one path must not disturb the rest.
    expect(index?.symbols.some((s) => s.name === "keeper")).toBe(true);
  }, 60_000);

  it("reports nothing-to-do, not a failure, for a path in no git checkout", async () => {
    // This assertion used to expect a rejection, and the change is deliberate. The PostToolUse hook
    // calls index_file after EVERY agent edit — scratchpads, notes under ~/.claude, anything in
    // /tmp — and none of those belong in a repository. Calling that a tool failure produced 147
    // errors in 801 calls (18.4%) and taught agents to distrust a tool that was working.
    //
    // It stays distinct from a deleted file, which is what this suite is about: `removed` means a
    // known file went away, `outside_indexed_repos` means there was never anything to track.
    const result = await indexFile(join(tmpdir(), "nowhere-at-all-xyz.ts"));
    expect(result.outside_indexed_repos).toBe(true);
    expect(result.removed).toBeUndefined();
  }, 60_000);
});
