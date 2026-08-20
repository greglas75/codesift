// Every hook is gated on `isCurrentRepoIndexed()`, and it answered by looking for the registry
// entry's `index_path` on disk. But `index_path` is an IDENTIFIER, not a file that must exist: it
// always carries the canonical `.index.json` name and the SQLite path is DERIVED from it. A repo
// born on the SQLite backend never has the `.json` at all.
//
// Measured on this machine: of 581 registry entries the `.json` existed for SIX. The other 575 had
// their `.db` and nothing else — `local/codesift` among them. So precheck-read, precheck-bash and
// the session check exited 0 in silence on essentially every repo, which is exactly the
// "CodeSift never fires" a benchmark reported and blamed on the repos being unindexed. They were
// indexed. The check was looking for the wrong file.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isCurrentRepoIndexed } from "../../src/cli/hooks/shared.js";

let dataDir: string;
let repoRoot: string;
let prevData: string | undefined;
let prevCwd: string;

function writeRegistry(indexPath: string): void {
  writeFileSync(join(dataDir, "registry.json"), JSON.stringify({
    repos: { "local/t": { name: "local/t", root: repoRoot, index_path: indexPath } },
    updated_at: 1,
  }));
}

beforeEach(() => {
  prevCwd = process.cwd();
  prevData = process.env["CODESIFT_DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "cs-gate-data-"));
  // realpath, because `isCwdInsideRepo` compares raw strings and macOS resolves the temp dir
  // through /var -> /private/var. Without this the repo is not "inside itself" and every case
  // fails for a reason that has nothing to do with what is under test.
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "cs-gate-repo-")));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  process.chdir(repoRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevData === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevData;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("isCurrentRepoIndexed", () => {
  it("accepts a SQLite-backed repo, whose .json never exists", () => {
    // The regression: this is the shape of 575 of 581 real entries.
    const jsonPath = join(dataDir, "abc.index.json");
    writeFileSync(join(dataDir, "abc.index.db"), "");
    writeRegistry(jsonPath);
    expect(isCurrentRepoIndexed()).toBe(true);
  });

  it("still accepts a legacy JSON index", () => {
    const jsonPath = join(dataDir, "def.index.json");
    writeFileSync(jsonPath, "{}");
    writeRegistry(jsonPath);
    expect(isCurrentRepoIndexed()).toBe(true);
  });

  it("says no when NEITHER artifact exists", () => {
    // The check must still be able to answer "not indexed" — otherwise the hooks would fire on a
    // repo with no index and every redirect would send the agent at a tool that cannot answer.
    writeRegistry(join(dataDir, "ghi.index.json"));
    expect(isCurrentRepoIndexed()).toBe(false);
  });

  it("says no when the cwd belongs to no registered repo", () => {
    writeFileSync(join(dataDir, "jkl.index.db"), "");
    writeFileSync(join(dataDir, "registry.json"), JSON.stringify({
      repos: { "local/other": { name: "local/other", root: join(tmpdir(), "somewhere-else-entirely"), index_path: join(dataDir, "jkl.index.json") } },
      updated_at: 1,
    }));
    expect(isCurrentRepoIndexed()).toBe(false);
  });
});
