/**
 * The seed of a linked worktree as an overlay on a shared base, instead of a full copy of its donor.
 *
 * The overlay database (storage/sqlite/overlay.ts) holds only the files the worktree changed; the
 * rest is read from a base every overlay of that donor commit shares.
 *
 * Two donors, two seeds:
 *  - a donor that is itself an overlay: the new index copies its small delta and points at the SAME
 *    base — the donor's content exactly, as the full copy was, for a few MB;
 *  - a plain donor (a main checkout, or a worktree indexed before overlays): its database is
 *    snapshotted ONCE per donor and commit into a read-only base, and the new index starts empty.
 *
 * A base is immutable. That is what makes sharing it safe: the donor's later edits never reach the
 * worktrees built on it, so each overlay's content stays what its catch-up computed. The donor's
 * uncommitted files at snapshot time are recorded in the base (`base_dirty`) — content no commit
 * diff mentions, which every overlay on that base must revisit.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, readdir, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { loadSqliteCtor } from "../../storage/sqlite/runtime.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../../storage/sqlite/schema.js";
import {
  OVERLAY_BASE_KEY,
  OVERLAY_BASE_PREFIX_KEY,
  OVERLAY_MASK_TABLE_SQL,
  attachOverlay,
  countIndexRows,
  readOnlyUri,
} from "../../storage/sqlite/overlay.js";
import { parsePorcelainZ } from "./worktree-seed.js";
import { runGit } from "../git-exec.js";

/** File name of a base: `base-<16 hex>.db` beside the indexes. `prune` keeps it while an overlay points at it. */
export const BASE_FILE_PATTERN = /^base-[0-9a-f]{16}\.db$/;

const BASE_DIRTY_KEY = "base_dirty";
const BASE_COMMIT_KEY = "base_commit";

export interface BaseSnapshot {
  path: string;
  /** Id prefix of the base rows, `<name>:`. */
  prefix: string;
  commit: string | null;
  /** The donor's uncommitted and untracked paths when the base was taken. */
  dirty: string[];
}

export interface DonorRef {
  name: string;
  root: string;
  commit: string | null;
}

/** SQLite string literal. Double-quoting would make the path an IDENTIFIER and fail. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type Ctor = new (path: string, options?: { open?: boolean }) => DatabaseSyncType;

async function sqlite(): Promise<Ctor> {
  // `loadSqliteCtor`, never `node:sqlite`: with the native store on, the Rust copy of SQLite owns every
  // index database in the process, and a second copy on the same file is how one gets corrupted.
  const Ctor = await loadSqliteCtor();
  if (!Ctor) throw new Error("node:sqlite unavailable (Node < 22.5)");
  return Ctor as unknown as Ctor;
}

function meta(db: DatabaseSyncType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM main.meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(db: DatabaseSyncType, key: string, value: string): void {
  db.prepare("INSERT INTO main.meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/**
 * Rename an id prefix in `id` and in `parent`, which holds the parent symbol's id. By prefix length,
 * not replace(): a path may contain the old name.
 */
function renamePrefix(db: DatabaseSyncType, from: string, to: string, schema = ""): void {
  for (const column of ["id", "parent"]) {
    db.prepare(`UPDATE ${schema}symbols SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?`)
      .run(to, from.length + 1, from.length, from);
  }
}

/** The base an overlay database points at, or null for a plain index. */
export async function overlayBaseOf(dbPath: string): Promise<string | null> {
  const Db = await sqlite();
  const db = new Db(readOnlyUri(dbPath), { open: true });
  try {
    const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    return hasMeta ? (meta(db, OVERLAY_BASE_KEY) ?? null) : null;
  } finally {
    db.close();
  }
}

/**
 * The donor's uncommitted and untracked paths (both sides of a rename). Throws when git cannot say:
 * the list is baked into an immutable base, and an empty one would leave every overlay on it holding
 * the donor's edits as if they were this tree's content.
 */
async function dirtyPaths(root: string): Promise<string[]> {
  const out = await runGit(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, timeout: 15_000 });
  const paths = new Set<string>();
  for (const entry of parsePorcelainZ(out)) {
    paths.add(entry.path);
    if (entry.from) paths.add(entry.from);
  }
  return [...paths];
}

function readBase(path: string, db: DatabaseSyncType): BaseSnapshot {
  const prefix = meta(db, OVERLAY_BASE_PREFIX_KEY) ?? `${meta(db, "repo") ?? ""}:`;
  const dirty = JSON.parse(meta(db, BASE_DIRTY_KEY) ?? "[]") as unknown;
  return {
    path,
    prefix,
    commit: meta(db, BASE_COMMIT_KEY) ?? null,
    dirty: Array.isArray(dirty) ? dirty.filter((p): p is string => typeof p === "string") : [],
  };
}

/**
 * The base for a seed from `donorDb`: the donor's own base when it is an overlay, otherwise a
 * snapshot of the donor (taken once per donor database and commit, then reused).
 *
 * `familyName` is the main checkout's registry name. A snapshot's ids are rewritten to it, so the
 * shared rows are named after the repository rather than after a sibling worktree that may be gone
 * tomorrow.
 */
export async function baseForDonor(
  donorDb: string,
  donor: DonorRef,
  familyName: string,
  dataDir: string,
): Promise<{ base: BaseSnapshot; donorIsOverlay: boolean }> {
  const Db = await sqlite();
  const donorBase = await overlayBaseOf(donorDb);
  if (donorBase !== null) {
    if (!existsSync(donorBase)) throw new Error(`donor ${donor.name} is an overlay on a missing base`);
    const db = new Db(readOnlyUri(donorBase), { open: true });
    try {
      return { base: readBase(donorBase, db), donorIsOverlay: true };
    } finally {
      db.close();
    }
  }

  const key = createHash("sha1").update(`${familyName}\0${donor.commit ?? ""}\0${donorDb}`).digest("hex").slice(0, 16);
  const path = join(dataDir, `base-${key}.db`);
  if (existsSync(path)) {
    // A reused base is as new as its newest user: `prune` spares a base for an hour after this, which
    // covers the seed that is about to point an overlay at it.
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
    const db = new Db(readOnlyUri(path), { open: true });
    try {
      return { base: readBase(path, db), donorIsOverlay: false };
    } finally {
      db.close();
    }
  }

  const temp = `${path}.creating.${process.pid}.${randomBytes(4).toString("hex")}`;
  // Before AND after the copy: a file the donor started editing during the copy may be in the
  // snapshot, and must then be revisited like any other uncommitted file.
  const dirtyBefore = await dirtyPaths(donor.root);
  try {
    if (existsSync(temp)) await unlink(temp);
    // Read-only source and a consistent snapshot: the daemon and other agents may be writing it.
    const source = new Db(readOnlyUri(donorDb), { open: true });
    try {
      source.exec(`VACUUM INTO ${sqlLiteral(temp)}`);
    } finally {
      source.close();
    }
    const dirty = [...new Set([...dirtyBefore, ...(await dirtyPaths(donor.root))])];
    const prefix = `${familyName}:`;
    const copy = new Db(temp, { open: true });
    try {
      copy.exec("BEGIN IMMEDIATE");
      const from = `${donor.name}:`;
      if (from !== prefix) renamePrefix(copy, from, prefix);
      setMeta(copy, "repo", familyName);
      setMeta(copy, OVERLAY_BASE_PREFIX_KEY, prefix);
      setMeta(copy, BASE_COMMIT_KEY, donor.commit ?? "");
      setMeta(copy, BASE_DIRTY_KEY, JSON.stringify(dirty));
      setMeta(copy, "base_source", donorDb);
      copy.exec("COMMIT");
      // Never written again, and opened by many connections at once: no WAL to replay.
      copy.exec("PRAGMA journal_mode = DELETE");
    } catch (err) {
      try { copy.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      throw err;
    } finally {
      copy.close();
    }
    await chmod(temp, 0o444);
    // Another seed may have published the same base meanwhile: theirs stays, since overlays may
    // already read it. link() never replaces an existing file, where rename() would.
    await link(temp, path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    await unlink(temp);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
  const db = new Db(readOnlyUri(path), { open: true });
  try {
    return { base: readBase(path, db), donorIsOverlay: false };
  } finally {
    db.close();
  }
}

/**
 * Write the worktree's overlay database at `targetTemp` and return its file and symbol counts.
 *
 * From an overlay donor: a copy of the donor's database (its delta, mask and base reference), with
 * the delta's ids renamed from the donor to this worktree. From a plain donor: an empty index over
 * the base, carrying the base's meta (workspaces, extractor versions) under this worktree's name.
 */
export async function writeOverlayIndex(
  targetTemp: string,
  opts: {
    donorDb: string;
    donorName: string;
    donorIsOverlay: boolean;
    base: BaseSnapshot;
    worktreeName: string;
    worktreeRoot: string;
  },
): Promise<{ files: number; symbols: number; mtimes: Map<string, number> }> {
  const Db = await sqlite();
  if (existsSync(targetTemp)) await unlink(targetTemp);

  if (opts.donorIsOverlay) {
    const source = new Db(readOnlyUri(opts.donorDb), { open: true });
    try {
      source.exec(`VACUUM INTO ${sqlLiteral(targetTemp)}`);
    } finally {
      source.close();
    }
  }

  const db = new Db(targetTemp, { open: true });
  try {
    db.exec(SCHEMA_SQL);
    db.exec(OVERLAY_MASK_TABLE_SQL);
    db.exec("BEGIN IMMEDIATE");
    if (opts.donorIsOverlay) {
      renamePrefix(db, `${opts.donorName}:`, `${opts.worktreeName}:`, "main.");
    } else {
      db.exec(`ATTACH DATABASE ${sqlLiteral(opts.base.path)} AS seedbase`);
      // The base's own bookkeeping (its commit, dirty list, source) describes the base, not this index.
      db.exec("INSERT OR REPLACE INTO main.meta(key, value) SELECT key, value FROM seedbase.meta WHERE key NOT LIKE 'base\\_%' ESCAPE '\\'");
    }
    setMeta(db, "repo", opts.worktreeName);
    setMeta(db, "root", opts.worktreeRoot);
    setMeta(db, "updated_at", String(Date.now()));
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
    setMeta(db, OVERLAY_BASE_KEY, opts.base.path);
    setMeta(db, OVERLAY_BASE_PREFIX_KEY, opts.base.prefix);
    db.exec("COMMIT");
    if (!opts.donorIsOverlay) db.exec("DETACH DATABASE seedbase");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    db.close();
    throw err;
  }
  db.close();

  // Counted through the views, as every reader will see the index.
  const view = new Db(targetTemp, { open: true });
  try {
    attachOverlay(view, targetTemp);
    const mtimes = await observeWorktreeMtimes(view, opts.worktreeRoot);
    return { files: countIndexRows(view, "files"), symbols: countIndexRows(view, "symbols"), mtimes };
  } finally {
    view.close();
  }
}

/** Files stat'ed at once while observing mtimes. */
const STAT_BATCH = 256;

/**
 * This tree's own mtime of every file whose stored row (the donor's) says otherwise.
 *
 * The base carries the donor's mtimes, and a checkout gives every file a new one — so without
 * recording these every re-walk sees every file as modified and re-parses the whole tree, and
 * `index_file` re-parses any file it is handed instead of short-circuiting.
 *
 * Observed here, during the seed and BEFORE the catch-up; written by the catch-up AFTER it re-read
 * the files that differ from the donor (worktree-seed.ts), skipping those. Written any earlier, the
 * catch-up's own `index_file` would see a matching mtime and keep the donor's symbols for a file this
 * tree changed. Observed any later, an edit landing during the catch-up would be paired with the
 * donor's symbols; observed before it, such an edit leaves a newer mtime and the next walk re-reads it.
 */
async function observeWorktreeMtimes(db: DatabaseSyncType, root: string): Promise<Map<string, number>> {
  const rows = db.prepare("SELECT path, mtime_ms FROM files").all() as Array<{ path: string; mtime_ms: number | null }>;
  const observed = new Map<string, number>();
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const mtimes = await Promise.all(batch.map((r) => stat(join(root, r.path)).then((s) => Math.round(s.mtimeMs), () => null)));
    batch.forEach((row, j) => {
      const mtime = mtimes[j];
      if (mtime !== null && mtime !== undefined && mtime !== row.mtime_ms) observed.set(row.path, mtime);
    });
  }
  return observed;
}

/** The id prefix of an overlay's base rows, or null for a plain index (or no database). */
export async function overlayIdPrefixOf(dbPath: string): Promise<string | null> {
  if (!existsSync(dbPath)) return null;
  const Db = await sqlite();
  const db = new Db(readOnlyUri(dbPath), { open: true });
  try {
    const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!hasMeta || meta(db, OVERLAY_BASE_KEY) === undefined) return null;
    return meta(db, OVERLAY_BASE_PREFIX_KEY) ?? null;
  } finally {
    db.close();
  }
}

/**
 * Remove the index at `indexPath` when it is an overlay whose base no longer exists; returns whether
 * it did. Such a database holds only the worktree's changed files and cannot be opened (the store
 * refuses it rather than answer from the delta alone), so the only useful thing is a new seed.
 */
export async function discardOverlayWithoutBase(indexPath: string): Promise<boolean> {
  const { sqlitePathFor } = await import("../../storage/index-store.js");
  const dbPath = sqlitePathFor(indexPath);
  if (!existsSync(dbPath)) return false;
  const base = await overlayBaseOf(dbPath).catch(() => null);
  if (base === null || existsSync(base)) return false;
  await removeIndexDatabase(dbPath);
  return true;
}

/** Remove an index database and its WAL side files. */
export async function removeIndexDatabase(dbPath: string): Promise<void> {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    await unlink(path).catch(() => undefined);
  }
}

const BASE_MIN_AGE_MS = 60 * 60 * 1000;
const BASE_TEMP = /^base-[0-9a-f]{16}\.db\.creating\.\d+(\.[0-9a-f]{8})?$/;

/**
 * Remove the bases no overlay points at any more (and abandoned half-made ones), for `prune`.
 *
 * A base is kept while ANY index database names it, and for an hour after it was written — a seed
 * publishes its base before the overlay that points at it. If any index database cannot be read,
 * nothing is removed this run: the unreadable one may be the overlay that needs the base, and a
 * deleted base turns it into an index that refuses to open.
 */
export async function sweepUnreferencedBases(
  dataDir: string,
  dryRun: boolean,
  now: number = Date.now(),
): Promise<{ kept: number; removed: number; freed_bytes: number; skipped_reason?: string }> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  const referenced = new Set<string>();
  let unreadable = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{8,}\.index\.db$/.test(name)) continue;
    try {
      const base = await overlayBaseOf(join(dataDir, name));
      if (base !== null) referenced.add(base);
    } catch {
      unreadable++;
    }
  }
  let kept = 0, removed = 0, freed = 0;
  for (const name of names) {
    const isBase = BASE_FILE_PATTERN.test(name);
    if (!isBase && !BASE_TEMP.test(name)) continue;
    const path = join(dataDir, name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    const young = now - info.mtimeMs < BASE_MIN_AGE_MS;
    if (young || (isBase && referenced.has(path)) || unreadable > 0) {
      if (isBase) kept++;
      continue;
    }
    if (!dryRun) {
      try {
        await unlink(path);
      } catch {
        if (isBase) kept++;
        continue;
      }
      await unlink(`${path}-journal`).catch(() => undefined);
    }
    removed++;
    freed += info.size;
  }
  return {
    kept, removed, freed_bytes: freed,
    ...(unreadable > 0 ? { skipped_reason: `${unreadable} index database(s) could not be read` } : {}),
  };
}
