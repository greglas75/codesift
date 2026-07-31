import { statSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Which git working tree a directory actually belongs to.
 *
 * This exists because repo resolution used to answer with the wrong checkout,
 * silently. `resolveRepoFromCwd` picks the registered repo whose root is the
 * longest ancestor of the CWD — and a linked worktree at
 * `<repo>/.worktrees/<task>` has `<repo>` as an ancestor. So an agent working
 * inside a worktree got the MAIN checkout's index and no indication of it:
 * measured on ResearchShield, `result.service.ts` was served as 4042 lines
 * while the file in the agent's own tree was 1415 lines, already refactored.
 * Every answer looked valid.
 *
 * A linked worktree is recognisable without shelling out to git: its `.git` is
 * a FILE containing `gitdir: <path>/.git/worktrees/<name>`, where a normal
 * checkout has a `.git` DIRECTORY.
 */

/** Depth guard — a working tree root is never 64 levels above the CWD. */
const MAX_WALK_UP = 64;

/**
 * Canonical form of a path, symlinks resolved.
 *
 * Both sides of every comparison here go through this. On macOS `/tmp` is a
 * symlink to `/private/tmp`, so a repo checked out under a symlinked path
 * yields `/tmp/x` from the registry and `/private/tmp/x` from a resolved CWD —
 * and a plain string compare then reports two names for one directory, which
 * would make an indexed worktree fail to match itself.
 *
 * Falls back to the lexically resolved path when the target does not exist, so
 * this never throws on a stale registry entry.
 */
export function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export interface WorkingTree {
  /** Root of the working tree the path belongs to. */
  root: string;
  /** True when this is a linked worktree rather than the main checkout. */
  linked: boolean;
  /** For a linked worktree, the main checkout it belongs to (best effort). */
  mainRoot: string | null;
}

function readGitLink(dir: string): { linked: boolean; gitDir: string | null } | null {
  const dotGit = join(dir, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return { linked: false, gitDir: dotGit };
  if (!st.isFile()) return null;
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf-8"));
    const target = match?.[1]?.trim();
    if (!target) return null;
    const gitDir = isAbsolute(target) ? target : resolve(dir, target);
    // Submodules also use the `.git`-file form; only a linked worktree's gitdir
    // sits under `<main>/.git/worktrees/<name>`. Keeping these apart matters —
    // a submodule is a different repository and must not be reported as another
    // checkout of this one.
    // Split on BOTH separators. git writes the gitdir path with forward slashes
    // even on Windows, where `sep` is a backslash — splitting on `sep` alone
    // yields one segment there, so `linked` came out false for every worktree
    // and Windows users silently kept the old wrong-checkout behaviour.
    const linked = gitDir.split(/[\\/]/).includes("worktrees");
    return { linked, gitDir };
  } catch {
    return null;
  }
}

/**
 * The main checkout a linked worktree belongs to, derived from its gitdir:
 * `<main>/.git/worktrees/<name>` → `<main>`. Returns null if the shape does not
 * match (unusual layouts, `--separate-git-dir`).
 */
export function mainCheckoutFromGitDir(gitDir: string): string | null {
  // Separator-agnostic for the same reason as `readGitLink`: the gitdir path is
  // written with forward slashes even on Windows.
  const parts = gitDir.split(/[\\/]/);
  const i = parts.lastIndexOf("worktrees");
  if (i < 1 || parts[i - 1] !== ".git") return null;
  const mainRoot = parts.slice(0, i - 1).join(sep);
  return mainRoot.length > 0 ? mainRoot : null;
}

/**
 * Walk up from `startDir` to the working tree it belongs to.
 *
 * Returns null for a path outside any git checkout — callers must keep working
 * in that case, since plenty of indexed folders are not repositories.
 */
export function findWorkingTree(startDir: string): WorkingTree | null {
  let dir = canonicalPath(startDir);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const link = readGitLink(dir);
    if (link) {
      return {
        root: dir,
        linked: link.linked,
        mainRoot: link.linked && link.gitDir ? mainCheckoutFromGitDir(link.gitDir) : null,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * True when answering from `repoRoot` would describe a different set of files
 * than the ones under `cwd`.
 *
 * Deliberately narrow: only a genuinely different working tree counts. A
 * subdirectory of the same checkout (monorepo package, `src/`) is the same
 * files and must not warn.
 */
export function isDifferentWorkingTree(cwd: string, repoRoot: string): boolean {
  const tree = findWorkingTree(cwd);
  if (!tree) return false;
  const root = canonicalPath(repoRoot);
  if (tree.root === root) return false;
  // The repo root sits inside this working tree — same checkout, deeper root.
  if (root.startsWith(tree.root + sep)) return false;
  return true;
}

/**
 * The repository a working tree belongs to: a linked worktree reports its main
 * checkout, a normal checkout reports itself. Two trees of the same repository
 * share this value.
 */
function repositoryIdentity(dir: string): string | null {
  const tree = findWorkingTree(dir);
  if (!tree) return null;
  return canonicalPath(tree.mainRoot ?? tree.root);
}

/**
 * True only for the case worth warning about: the answer describes a DIFFERENT
 * checkout of the SAME repository as the caller's CWD.
 *
 * Keying on repository identity rather than path containment is what separates
 * the two situations that look alike from the outside. Querying another project
 * is also "a different working tree", but it is deliberate — warning there fires
 * on every cross_repo_search and trains the hint out of an agent's attention,
 * taking the real case with it. Two checkouts of the SAME repo are the dangerous
 * pair: the caller believes it is looking at its own files.
 *
 * Containment alone was not enough. `git worktree add ../feature` puts the
 * worktree BESIDE the main checkout, so an ancestor test missed it entirely
 * while the failure — being served another checkout's files — is identical.
 */
export function isAnswerFromWrongTree(cwd: string, repoRoot: string): boolean {
  if (!isDifferentWorkingTree(cwd, repoRoot)) return false;
  const here = repositoryIdentity(cwd);
  const there = repositoryIdentity(repoRoot);
  if (here === null || there === null) return false;
  return here === there;
}
