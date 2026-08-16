/**
 * Build a linked worktree's index by copying its parent checkout's index, instead of walking and
 * parsing the tree from scratch.
 *
 * A linked worktree is nearly the same content as the checkout it came from. Measured on
 * tgm-survey-platform: the parent index holds 14,891 files, one worktree holds 14,405, and they
 * differ by **eleven** — 0.08%. That repo has 16 worktrees. Parsing 14,405 files to discover 11
 * differences is the whole cost of indexing paid to learn almost nothing.
 *
 * The copy itself is cheap and the numbers are not close: `VACUUM INTO` moved 50,000 rows in 10 ms
 * and the id rewrite took 30 ms, against minutes for a full parse of a repo that size.
 *
 * ---------------------------------------------------------------------------
 * Two steps, and the second is why the first is safe
 * ---------------------------------------------------------------------------
 *
 * `seedWorktreeIndexFromParent` copies, and records the PARENT's commit — deliberately, because
 * that is the commit the copied content actually describes. Claiming the worktree's HEAD would make
 * every later diff start from a state the index does not match.
 *
 * `catchUpSeededWorktree` then walks that gap: committed divergence, uncommitted work, untracked
 * files and deletions, applied file by file.
 *
 * The first draft delegated the second step to `ensureIndexFresh`, which already diffs from
 * `last_git_commit` — appealingly, since it avoids a second differ. It was wrong, and measurably:
 * that function falls back to a FULL index above `MAX_DIFF_FILES` (50), a threshold weighed against
 * a cheap incremental pass, not against parsing 14,226 files. A worktree that differed by 65 files
 * therefore took ten minutes instead of milliseconds — the whole feature undone by a constant
 * borrowed from a different question. It also excludes deletions by design (`--diff-filter=ACMR`)
 * and never looks at untracked files, both of which matter far more here than in its own use.
 */
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { getRepo, registerRepo, getRepoName } from "../../storage/registry.js";
import { findWorkingTree, canonicalPath } from "../../utils/worktree.js";
import { loadConfig } from "../../config.js";

export interface SeedResult {
  seeded: boolean;
  /** Why the seed was declined. Present exactly when `seeded` is false. */
  reason?: string;
  parent_repo?: string;
  files?: number;
  symbols?: number;
  /** The commit the seeded content actually describes — the parent's, not the worktree's. */
  seeded_at_commit?: string | null;
  elapsed_ms?: number;
}

/** SQLite string literal. Double-quoting would make the path an IDENTIFIER and fail. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Seed `worktreeRoot`'s index from its parent checkout's, if that is possible and safe.
 *
 * Every refusal returns `{seeded: false, reason}` rather than throwing: the caller's fallback is a
 * full index, which is slower but always correct. A seed that is wrong is far worse than a seed
 * that did not happen — the failure mode would be an index that looks complete and describes
 * another tree, which is exactly the confusion this feature exists to end.
 */
export async function seedWorktreeIndexFromParent(
  worktreeRoot: string,
  worktreeName: string,
  worktreeIndexPath: string,
): Promise<SeedResult> {
  const started = Date.now();

  const tree = findWorkingTree(worktreeRoot);
  if (!tree?.linked || !tree.mainRoot) {
    return { seeded: false, reason: "not a linked worktree" };
  }
  if (!existsSync(tree.mainRoot)) {
    return { seeded: false, reason: `parent checkout is gone (${tree.mainRoot})` };
  }

  const config = loadConfig();
  const parentName = getRepoName(tree.mainRoot);
  const parent = await getRepo(config.registryPath, parentName);
  if (!parent) {
    return { seeded: false, reason: `parent ${parentName} is not indexed` };
  }
  // Compare CANONICAL paths. `findWorkingTree` resolves symlinks and the registry stores whatever
  // the caller passed, so on macOS a repo under /var (a symlink to /private/var) compares unequal to
  // itself and every such worktree would silently fall back to a full parse. Caught by a test whose
  // temp dirs live exactly there.
  if (canonicalPath(parent.root) !== canonicalPath(tree.mainRoot)) {
    // The registry entry under that name describes a different directory. Seeding from it would
    // copy an index of some other tree — the precise error this whole feature is meant to prevent.
    return {
      seeded: false,
      reason: `parent entry ${parentName} points at ${parent.root}, not ${tree.mainRoot}`,
    };
  }

  const { sqlitePathFor } = await import("../../storage/index-store.js");
  const parentDb = sqlitePathFor(parent.index_path);
  const targetDb = sqlitePathFor(worktreeIndexPath);
  if (!existsSync(parentDb)) {
    return { seeded: false, reason: "parent index is not in the SQLite backend" };
  }

  const { isSqliteAvailable } = await import("../../storage/sqlite/runtime.js");
  if (!(await isSqliteAvailable())) {
    return { seeded: false, reason: "node:sqlite unavailable (Node < 22.5)" };
  }

  // Write to a temp sibling and rename, so an interrupted seed never leaves a half-copied database
  // sitting at the path the registry is about to point at.
  const tempDb = `${targetDb}.seeding.${process.pid}`;
  try {
    if (existsSync(tempDb)) await unlink(tempDb);

    const { DatabaseSync } = await import("node:sqlite");

    // Read-only source: this runs while the daemon and other agents may hold the parent open.
    // VACUUM INTO takes a consistent snapshot and refuses to run inside a transaction, which is
    // what makes it safe to point at a database somebody else is writing.
    const source = new DatabaseSync(`file:${parentDb}?mode=ro`, { open: true });
    try {
      source.exec(`VACUUM INTO ${sqlLiteral(tempDb)}`);
    } finally {
      source.close();
    }

    const copy = new DatabaseSync(tempDb, { open: true });
    let files = 0;
    let symbols = 0;
    try {
      // A symbol id is `<repo>:<file>:<name>:<line>` (parser/symbol-utils.ts), so every id in the
      // copy names the PARENT repo. Rewriting the prefix by length is exact where a `replace()`
      // would not be: a file path may legitimately contain the parent's name as a substring.
      //
      // Safe as a bulk UPDATE because v2 dropped the PRIMARY KEY on `symbols.id` — ids are not
      // unique (TypeScript's type and value namespaces put two on one line), so there is no
      // conflict to resolve.
      const oldPrefix = `${parent.name}:`;
      const newPrefix = `${worktreeName}:`;
      copy.exec("BEGIN IMMEDIATE");
      copy.prepare("UPDATE symbols SET id = ? || substr(id, ?)").run(newPrefix, oldPrefix.length + 1);
      copy.prepare("INSERT INTO meta (key, value) VALUES ('repo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(worktreeName);
      copy.prepare("INSERT INTO meta (key, value) VALUES ('root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(worktreeRoot);
      copy.prepare("INSERT INTO meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(Date.now()));
      copy.exec("COMMIT");

      files = (copy.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number }).c;
      symbols = (copy.prepare("SELECT COUNT(*) AS c FROM symbols").get() as { c: number }).c;
    } catch (err) {
      try { copy.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      throw err;
    } finally {
      copy.close();
    }

    if (files === 0) {
      // An empty parent index is not worth seeding from, and would look like a successful index of
      // a repo with no files — indistinguishable from a walk that found nothing.
      await unlink(tempDb).catch(() => undefined);
      return { seeded: false, reason: "parent index is empty" };
    }

    await rename(tempDb, targetDb);

    // `last_git_commit` is the parent's, deliberately: it is the commit the copied content
    // describes. ensureIndexFresh diffs from here to the worktree's HEAD.
    await registerRepo(config.registryPath, {
      name: worktreeName,
      root: worktreeRoot,
      index_path: worktreeIndexPath,
      file_count: files,
      symbol_count: symbols,
      last_git_commit: parent.last_git_commit ?? null,
      indexed_at: Date.now(),
    } as never);

    return {
      seeded: true,
      parent_repo: parent.name,
      files,
      symbols,
      seeded_at_commit: parent.last_git_commit ?? null,
      elapsed_ms: Date.now() - started,
    };
  } catch (err: unknown) {
    await unlink(tempDb).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return { seeded: false, reason: `copy failed: ${message}` };
  }
}

/** Size of the parent index, for deciding whether a seed is even worth reporting. */
export function parentIndexBytes(parentDbPath: string): number {
  try {
    return statSync(parentDbPath).size;
  } catch {
    return 0;
  }
}

/**
 * Above this many differing files, re-parsing the whole tree is genuinely the better trade and the
 * caller should fall back.
 *
 * Deliberately far above `ensureIndexFresh`'s `MAX_DIFF_FILES` of 50, because the alternative is
 * different. There, 50 is weighed against a cheap incremental pass over an index that is already
 * correct. Here it is weighed against parsing 14,226 files from scratch — measured: delegating a
 * 65-file catch-up to that 50-file threshold turned a seed that took milliseconds into a ten-minute
 * full index, which is the entire feature undone by a constant borrowed from a different question.
 */
const MAX_CATCHUP_FILES = 3000;

export interface CatchUpResult {
  caught_up: boolean;
  reason?: string;
  updated?: number;
  /** Files the catch-up could not index — a crashing parser worker looks exactly like a binary
   *  file here, and only the caller can tell that a just-edited source file going missing matters. */
  failed?: string[];
  removed?: number;
  changed_total?: number;
  head?: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 15_000 });
  } catch {
    return null;
  }
}

/**
 * Bring a freshly seeded worktree index from the parent's commit to this tree's actual state.
 *
 * Covers three things a plain `git diff <a>..<b>` does not, each of which would otherwise leave the
 * index quietly describing the parent:
 *
 *  - **Deletions.** `--diff-filter=ACMR` excludes them by design, so a file removed on this branch
 *    would keep its parent's symbols forever — searchable, and gone from disk.
 *  - **Uncommitted work.** A worktree is usually mid-change; its HEAD is not what is on disk.
 *  - **Untracked files.** New files are the single most likely thing an agent wants to find in the
 *    tree it is working in, and they appear in no commit diff at all.
 */
export async function catchUpSeededWorktree(
  worktreeRoot: string,
  repoName: string,
  fromCommit: string | null,
): Promise<CatchUpResult> {
  const head = git(["rev-parse", "HEAD"], worktreeRoot)?.trim();
  if (!head) return { caught_up: false, reason: "not a git checkout" };
  if (!fromCommit) return { caught_up: false, reason: "parent index records no commit" };

  const changed = new Set<string>();
  const removed = new Set<string>();

  if (fromCommit !== head) {
    const diff = git(["diff", "--name-status", `${fromCommit}..${head}`], worktreeRoot);
    if (diff === null) {
      // The parent's commit is unreachable from here — a rebase, a squash, or a worktree on an
      // unrelated branch. Nothing can be diffed against it, so the seed cannot be trusted to be a
      // near-match and the caller must do the real work.
      return { caught_up: false, reason: `commit ${fromCommit.slice(0, 12)} unreachable from HEAD` };
    }
    for (const line of diff.split("\n")) {
      if (!line.trim()) continue;
      const [status, ...paths] = line.split("\t");
      const target = paths[paths.length - 1];
      if (!target || !status) continue;
      if (status.startsWith("D")) removed.add(target);
      else changed.add(target);
      // A rename is a delete plus an add; the old path must leave the index.
      if (status.startsWith("R") && paths.length > 1 && paths[0]) removed.add(paths[0]);
    }
  }

  // Working tree on top of HEAD: modified, staged, and untracked alike.
  const status = git(["status", "--porcelain", "--untracked-files=all"], worktreeRoot);
  if (status !== null) {
    for (const line of status.split("\n")) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (!path) continue;
      if (code.includes("D")) removed.add(path);
      else changed.add(path);
    }
  }

  for (const path of removed) changed.delete(path);

  const total = changed.size + removed.size;
  if (total > MAX_CATCHUP_FILES) {
    return { caught_up: false, reason: `${total} files differ (> ${MAX_CATCHUP_FILES})`, changed_total: total };
  }

  const { indexFile } = await import("./file-indexer.js");
  const { removeFileFromIndex } = await import("../../storage/index-store.js");
  const { getRepo: readRepo } = await import("../../storage/registry.js");
  const config = loadConfig();
  const meta = await readRepo(config.registryPath, repoName);

  let updated = 0;
  const failed: string[] = [];
  for (const rel of changed) {
    try {
      await indexFile(join(worktreeRoot, rel));
      updated++;
    } catch {
      // Usually benign — binary, filtered by the walker's rules, or deleted between the diff and
      // now. But a crashing parser worker lands here too, and THAT means a file the caller just
      // edited is missing from the index while the result still reports success. Swallowing both
      // identically is what made that indistinguishable, so the count travels back and the caller
      // decides what it means.
      failed.push(rel);
    }
  }

  let removedCount = 0;
  if (meta) {
    for (const rel of removed) {
      try {
        await removeFileFromIndex(meta.index_path, rel);
        removedCount++;
      } catch {
        // Not in the index to begin with.
      }
    }
  }

  const { updateRepoMeta } = await import("../../storage/registry.js");
  await updateRepoMeta(config.registryPath, repoName, {
    last_git_commit: head,
    updated_at: Date.now(),
  });

  return {
    caught_up: true, updated, removed: removedCount, changed_total: total, head,
    ...(failed.length > 0 ? { failed } : {}),
  };
}
