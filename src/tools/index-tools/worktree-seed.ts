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
import { runGit } from "../git-exec.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { getRepo, registerRepo, getRepoName } from "../../storage/registry.js";
import { sqlitePathFor } from "../../storage/index-store.js";
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
/**
 * The best index to copy from — not necessarily the parent checkout's.
 *
 * The seed used to take the parent unconditionally, and that is wrong for how these worktrees are
 * actually made. Measured 2026-09-02 on tgm-survey-platform: the main checkout was sitting on
 * `chore/stryker-native-mutation-setup`, **5,324 files** away from `develop`. Every worktree cut
 * from develop therefore had to rewrite 5,044 files, blew the catch-up ceiling, and fell back to a
 * full index — 216 s median, and 9,490 s at the tail.
 *
 * The workload makes it worse than a single bad choice. Ten worktrees get created at once, all from
 * the same develop commit. The first pays a full index; the other nine are byte-identical to it and
 * still each paid their own, because the only donor ever considered was a checkout on an unrelated
 * branch.
 *
 * So: prefer a sibling already indexed AT THE SAME COMMIT — distance zero, nothing to catch up, and
 * free to detect since the registry already records `last_git_commit`. Falling back to the parent
 * keeps the previous behaviour when no sibling exists.
 *
 * Deliberately no git call in the selection path. Ranking candidates by real diff size would mean
 * one `git diff` per candidate, and this repository has 97 registered siblings — the search would
 * cost more than the copy it is choosing. An exact commit match is the case that matters and it is
 * free; anything else falls through to the parent and is decided by the ceiling as before.
 */
export async function pickSeedDonor(
  registryPath: string,
  parentName: string,
  parent: { root: string; index_path: string; last_git_commit?: string | undefined },
  worktreeHead: string | null,
): Promise<{ name: string; root: string; index_path: string; commit: string | null; sameCommit: boolean }> {
  const fallback = {
    name: parentName,
    root: parent.root,
    index_path: parent.index_path,
    commit: parent.last_git_commit ?? null,
    sameCommit: false,
  };
  if (!worktreeHead) return fallback;
  if (parent.last_git_commit === worktreeHead) return { ...fallback, sameCommit: true };

  const { listRepos } = await import("../../storage/registry.js");
  const all = await listRepos(registryPath).catch(() => []);
  for (const candidate of all) {
    if (candidate.name === parentName) continue;
    if (candidate.last_git_commit !== worktreeHead) continue;
    // Same repository, not merely the same commit id: a sibling worktree shares the parent's root
    // as a path ancestor, or is the parent itself. Without this a coincidentally equal sha in an
    // unrelated repo would seed the wrong tree — the exact failure this feature exists to avoid.
    if (!existsSync(sqlitePathFor(candidate.index_path))) continue;
    return {
      name: candidate.name,
      root: candidate.root,
      index_path: candidate.index_path,
      commit: candidate.last_git_commit ?? null,
      sameCommit: true,
    };
  }
  return fallback;
}

export async function seedWorktreeIndexFromParent(
  worktreeRoot: string,
  worktreeName: string,
  worktreeIndexPath: string,
): Promise<SeedResult> {
  const started = Date.now();

  // FIRST, and cheapest. A tree that is gone is reported as gone rather than as "not a linked
  // worktree": measured 2026-08-30, three worktrees of tgm-survey-platform were each copied for
  // **42 seconds** (15,422 files, 243,870 symbols) and the result thrown away, because the check
  // that would have refused them ran AFTER the copy. All three had been created by an agent and
  // deleted while indexing ran, and the message that came back sent a reader looking for a git
  // fault that did not exist. A vanished tree and a broken checkout need different answers.
  if (!existsSync(worktreeRoot)) {
    return { seeded: false, reason: `worktree is gone (${worktreeRoot})` };
  }

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

  // The last check before the expensive part. A seed is only worth copying if
  // `catchUpSeededWorktree` can then bring it to this tree's HEAD, and that needs a working
  // `git rev-parse` here. Asking afterwards is what made those 42-second copies pure waste.
  // It is also what picks the donor, so it has to happen before anything is copied.
  const worktreeHead = (await runGit(["rev-parse", "HEAD"], { cwd: worktreeRoot, timeout: 5_000 })
    .then((out) => out.trim())
    .catch(() => null));
  if (worktreeHead === null) {
    return { seeded: false, reason: "not a git checkout — nothing to catch the seed up to" };
  }

  const donor = await pickSeedDonor(config.registryPath, parentName, parent, worktreeHead);

  const parentDb = sqlitePathFor(donor.index_path);
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
      const oldPrefix = `${donor.name}:`;
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
      last_git_commit: donor.commit,
      indexed_at: Date.now(),
    } as never);

    return {
      seeded: true,
      parent_repo: donor.name,
      files,
      symbols,
      seeded_at_commit: donor.commit,
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
 *
 * ---------------------------------------------------------------------------
 * And then the same mistake was made here, one level up (2026-08-30)
 * ---------------------------------------------------------------------------
 *
 * A flat 3000 was chosen against the measurement above: parent 14,891 files, worktree 14,405,
 * eleven different. That holds only while the PARENT index is fresh. In practice it trails the
 * branch by a couple of days, so a worktree cut from `develop` differs from it by ~4,100 files —
 * and the seed was declined every single time. Measured over the live logs: `seeded from` 0,
 * `seed not usable` 28. The feature had never once run.
 *
 * ---------------------------------------------------------------------------
 * Third correction, and this one was a REGRESSION I shipped (2026-09-01)
 * ---------------------------------------------------------------------------
 *
 * The fix above raised the ceiling to 60% of the tree on the strength of this comparison:
 *
 *   full index, one tgm-survey-platform worktree   6,412 s / 15,422 files = 416 ms per file
 *   catch-up, per changed file (index_file p90)                             283 ms per file
 *
 * The second number was wrong, and wrong in the way telemetry medians usually are: `index_file`'s
 * distribution is dominated by calls that SHORT-CIRCUIT on an unchanged file (14 ms median). For a
 * file that actually has to be read, parsed and saved, the real cost is far higher. Measured from
 * the catch-ups the raised ceiling then allowed to run:
 *
 *   3,778 changed files   9,489 s (158 min)   2.5 s per file
 *     778 changed files   5,483 s ( 91 min)   7.0 s per file
 *     772 changed files   4,496 s ( 75 min)   5.8 s per file
 *     356 changed files     575 s ( 10 min)   1.6 s per file
 *
 * So the catch-up is 4-17x MORE expensive per file than the walk it replaces, not cheaper. It is
 * sequential — one stat, read, hash, parse and DB write per file — against a walk that parses eight
 * at a time and writes once. On the 3,778-file case the "optimisation" took 158 minutes where the
 * full index it replaced takes 107.
 *
 * Crossover, from those two per-file costs: catching up N files beats re-walking a tree of T when
 * N * ~4s < T * 0.416s, i.e. below roughly a TENTH of the tree. The ceiling is that tenth.
 *
 * The floor goes with it. 3000 was never a floor in any real sense — on a 1,055-file repository it
 * admitted the entire tree, which is how rs_admin came to spend 91 minutes catching up 778 of its
 * 1,055 files. A floor exists so a tiny repository is not forced into a walk for a handful of
 * changes; 100 does that and nothing more.
 *
 * The asymmetry is the reason to err low: refusing costs a predictable full index, while accepting
 * costs a catch-up with no ceiling on how long it runs.
 */
const MAX_CATCHUP_FILES_FLOOR = 100;
const MAX_CATCHUP_TREE_FRACTION = 0.1;

export function catchUpCeiling(seededFileCount: number | undefined): number {
  if (seededFileCount === undefined || seededFileCount <= 0) return MAX_CATCHUP_FILES_FLOOR;
  return Math.max(MAX_CATCHUP_FILES_FLOOR, Math.round(seededFileCount * MAX_CATCHUP_TREE_FRACTION));
}

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

/**
 * git, without stopping the shared daemon.
 *
 * `execFileSync` froze the whole process for as long as the child ran — up to 15 s per call, three
 * calls per catch-up — and one process answers every client on this machine. See git-exec.ts.
 */
async function git(args: string[], cwd: string): Promise<string | null> {
  return runGit(args, { cwd, timeout: 15_000 }).catch(() => null);
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
  /** Files the seed copied in. The ceiling is a fraction of this; omitting it falls back to the
   *  flat floor, which is what a caller that cannot know the size should get. */
  seededFileCount?: number,
): Promise<CatchUpResult> {
  const head = (await git(["rev-parse", "HEAD"], worktreeRoot))?.trim();
  if (!head) return { caught_up: false, reason: "not a git checkout" };
  if (!fromCommit) return { caught_up: false, reason: "parent index records no commit" };

  const changed = new Set<string>();
  const removed = new Set<string>();

  if (fromCommit !== head) {
    const diff = await git(["diff", "--name-status", `${fromCommit}..${head}`], worktreeRoot);
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
  const status = await git(["status", "--porcelain", "--untracked-files=all"], worktreeRoot);
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
  const ceiling = catchUpCeiling(seededFileCount);
  if (total > ceiling) {
    return { caught_up: false, reason: `${total} files differ (> ${ceiling})`, changed_total: total };
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
