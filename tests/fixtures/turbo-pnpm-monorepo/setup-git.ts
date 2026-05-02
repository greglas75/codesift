import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixture {
  /** Absolute path to a copy of the fixture with a real .git directory. */
  root: string;
  /** SHA of the initial commit (BASE). */
  baseSha: string;
  /** SHA after editing packages/shared/src/Button.tsx. */
  editSharedSha: string;
  /** SHA after editing only pnpm-lock.yaml. */
  lockfileSha: string;
  /** SHA after `git rm -r packages/cycle-a/`. */
  deleteCycleASha: string;
  cleanup(): void;
}

const FIXTURE_SRC = __dirname;

/** Create a temp copy of the fixture with a real `.git` directory and a
 *  4-commit history matching the AC3, AC13, and Task 10 deleted-workspace
 *  scenarios. Caller MUST invoke `cleanup()` to remove the temp dir. */
export function setupGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "codesift-monorepo-fixture-"));
  cpSync(FIXTURE_SRC, root, {
    recursive: true,
    filter: (s) =>
      !s.endsWith("setup-git.ts") &&
      !s.endsWith("fixture.spec.ts") &&
      !s.includes("/.git/") &&
      !s.endsWith("/.git"),
  });

  const run = (cmd: string): string =>
    execSync(cmd, { cwd: root, encoding: "utf-8" }).trim();

  run("git init -q -b main");
  run("git config user.email fixture@codesift.test");
  run("git config user.name fixture");
  run("git add .");
  run("git commit -q -m init");
  const baseSha = run("git rev-parse HEAD");

  // 1) edit shared/Button.tsx — transitive-affected scenario (AC3)
  const buttonPath = join(root, "packages/shared/src/Button.tsx");
  writeFileSync(
    buttonPath,
    readFileSync(buttonPath, "utf-8").replace("<button>", "<button data-test=\"button\">"),
  );
  run("git add packages/shared/src/Button.tsx");
  run("git commit -q -m \"edit shared/Button\"");
  const editSharedSha = run("git rev-parse HEAD");

  // 2) edit ONLY pnpm-lock.yaml — lockfile-only scenario (AC13)
  const lockPath = join(root, "pnpm-lock.yaml");
  writeFileSync(lockPath, readFileSync(lockPath, "utf-8") + "# bump\n");
  run("git add pnpm-lock.yaml");
  run("git commit -q -m \"bump lockfile\"");
  const lockfileSha = run("git rev-parse HEAD");

  // 3) delete packages/cycle-a/ — deleted-workspace scenario (Task 10)
  run("git rm -rq packages/cycle-a");
  run("git commit -q -m \"remove cycle-a\"");
  const deleteCycleASha = run("git rev-parse HEAD");

  return {
    root,
    baseSha,
    editSharedSha,
    lockfileSha,
    deleteCycleASha,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
