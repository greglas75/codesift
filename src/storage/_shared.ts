import { writeFile, rename, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Delete abandoned `<target>.tmp.*` siblings left by an interrupted atomic write.
 *
 * Every writer here removes its own temp file when the write *throws*, but a
 * process that is killed mid-write (SIGKILL, the stdio-disconnect exit path, an
 * OOM, the machine sleeping) never runs that cleanup. Because the temp name
 * embeds a timestamp, nothing ever overwrites the orphan either, so they
 * accumulate forever: 100 files / 5.0 GB in `~/.codesift` as of 2026-07-30,
 * against 21.9 GB of live embeddings.
 *
 * Only files older than `minAgeMs` are removed, so a concurrent writer's
 * in-flight temp file is never touched. Best-effort throughout: cleanup must
 * never fail the write it is protecting.
 */
export async function cleanupOrphanTempFiles(
  targetPath: string,
  minAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const dir = dirname(targetPath);
  const base = basename(targetPath);
  // TWO shapes, not one. `atomicWriteFile` writes `<target>.tmp.<ts>`; `chunk-store` writes
  // `<target>.generation.<pid>.<uuid>`. Only the first was ever swept, so the second accumulated
  // untouched — measured 2026-09-05: 164 files, 19.6 GB, across 26 process ids of which 24 were
  // long dead. They are invisible to `prune` too until the pattern above learns the tail.
  const prefixes = [`${base}.tmp.`, `${base}.generation.`];
  let removed = 0;
  try {
    const cutoff = Date.now() - minAgeMs;
    for (const entry of await readdir(dir)) {
      if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
      // A generation file whose WRITER IS STILL RUNNING is an in-flight write, not an orphan. The
      // age guard alone would eventually delete one: a large embedding batch can outlive the hour,
      // and deleting it mid-write turns a slow save into a corrupt one.
      //
      // PIDS RECYCLE, so that protection has to expire. macOS wraps them at 99,999 and this machine
      // churns agent processes fast enough to get there in days — after which an unrelated live
      // process can pin a dead writer's temp file forever, which is the leak this function exists to
      // close. Past `PID_TRUST_WINDOW_MS` a name that still matches something running is far more
      // likely a reused number than a write that has been in flight for a day. The largest artifact
      // on this install is 1.7 GB; nothing legitimate is still flushing after 24 hours.
      const full = join(dir, entry);
      try {
        const info = await stat(full);
        if (info.mtimeMs > cutoff) continue;
        const age = Date.now() - info.mtimeMs;
        if (age < PID_TRUST_WINDOW_MS && writerPidIsAlive(entry)) continue;
        await unlink(full);
        removed++;
      } catch { /* raced with another cleaner — fine */ }
    }
  } catch { /* unreadable dir — nothing to clean */ }
  return removed;
}

/**
 * Largest number in a temp name that can plausibly be a process id.
 *
 * `.tmp.<n>` is ambiguous: `bm25-store` and `edge-cache` put a PID there, `embedding-store` puts
 * `Date.now()`. A timestamp read as a pid would be asked about — harmlessly, since `kill` answers
 * ESRCH for it — but bounding the range says which shape is meant instead of relying on that
 * accident. macOS caps pids at 99,999 and Linux's `pid_max` ceiling is 2^22.
 */
const MAX_PLAUSIBLE_PID = 4 * 1024 * 1024;

/**
 * How long a live pid in a temp name is trusted as an in-flight write.
 *
 * PIDS RECYCLE. macOS wraps them at 99,999 and this machine churns agent processes fast enough to
 * get there in days, after which an unrelated live process pins a dead writer's temp file forever —
 * the leak this function exists to close, reintroduced through its own safety guard. Past this
 * window a matching pid is far more likely a reused number than a write still in flight: the largest
 * artifact on this install is 1.7 GB, and nothing legitimate is still flushing after a day.
 */
export const PID_TRUST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when a `.generation.<pid>.<uuid>` or `.tmp.<pid>` name belongs to a process that still exists.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the id is addressable. EPERM means the
 * process exists and belongs to someone else — still alive, so still hands off. Anything else, and
 * any name without a parsable pid, is treated as dead: this runs beside an age guard, and the cost
 * of being wrong in that direction is one orphan surviving another hour.
 *
 * The `.tmp.<pid>` arm is what makes it SAFE to sweep on behalf of the stream writers
 * (`bm25-store`, `edge-cache`). Their temp file is the only shape here whose write can outlive the
 * age guard: the largest bm25 artifact on this machine is 1.7 GB, and a daemon whose event loop is
 * seconds late takes far longer than an hour to flush it. Without this, adding a sweep to those
 * writers would turn a slow save into a deleted one.
 */
export function writerPidIsAlive(entry: string): boolean {
  const match = /\.(?:generation|tmp)\.(\d+)(?:\.|$)/.exec(entry);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PLAUSIBLE_PID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Write content to a file atomically using a write-rename strategy.
 * 1. Ensures the parent directory exists (mkdir -p).
 * 2. Writes content to a temporary file adjacent to the target.
 * 3. Renames the temp file to the target path (atomic on most filesystems).
 * 4. On error, removes the temp file before re-throwing.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  // pid + random: Date.now() alone collides when two writers (parallel test
  // workers, concurrent MCP server instances) hit the same target in the same
  // millisecond — the loser's rename then fails with ENOENT.
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/**
 * Write a Buffer to a file atomically using the same write-tmp-then-rename
 * strategy as atomicWriteFile, but binary-safe (no utf-8 encoding).
 * 1. Ensures the parent directory exists (mkdir -p).
 * 2. Writes the buffer to a temporary file adjacent to the target.
 * 3. Renames the temp file to the target path (atomic on most filesystems).
 * 4. On error, removes the temp file before re-throwing.
 */
export async function atomicWriteBuffer(
  targetPath: string,
  buf: Buffer,
): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  try {
    await writeFile(tmpPath, buf);
    await rename(tmpPath, targetPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/**
 * Every per-repo artifact kind, keyed off the index path.
 *
 * `prune` decides what is garbage by matching `<hash>.<suffix>` against this list, so a
 * suffix missing here is a file nothing will ever reclaim. That drifted: the list predated
 * the chunk store and the SQLite backend, so it knew `embeddings.ndjson` but not
 * `chunks.ndjson`, `chunk-embeddings.ndjson`, `index.db` or `snapshot.json`. On this
 * machine that hid 2,206 files and 8.72 GB — prune reported 0.93 GB and called it done,
 * which reads as "nothing left to clean" rather than "I do not recognise most of this".
 *
 * Derived from the helpers that BUILD these names (getChunkPath, getChunkEmbeddingPath,
 * sqlitePathFor, …) rather than written out independently, and asserted against them in
 * tests, so adding an artifact kind without teaching prune about it fails the build.
 */
export const ARTIFACT_SUFFIXES = [
  "index.json",
  "index.db",
  "index.db-wal",
  "index.db-shm",
  "embeddings.ndjson",
  "embeddings.meta.json",
  "chunks.ndjson",
  "chunk-embeddings.ndjson",
  "bm25.json",
  "bm25.ndjson",
  "import-edges.ndjson",
  "graph.json",
  "snapshot.json",
] as const;

/**
 * Matches `<hash>.<known artifact suffix>`, with an optional `.tmp.<ts>` tail so the
 * abandoned halves of an interrupted atomic write are reclaimed too. Capture group 1 is the
 * hash, which is what identifies the owning repo.
 */
export function artifactPattern(): RegExp {
  const suffixes = ARTIFACT_SUFFIXES.map((s) => s.replace(/[.\\+*?[^\]$(){}=!<>|:#-]/g, "\\$&"));
  // The abandoned-write tails are BOTH shapes. `.tmp.<ts>` comes from `atomicWriteFile`;
  // `.generation.<pid>.<uuid>` comes from `chunk-store`, and prune could not see it — measured
  // 2026-09-05, 164 such files holding 19.6 GB that neither cleanup path could reach.
  return new RegExp(
    `^([0-9a-f]{8,})\\.(?:${suffixes.join("|")})(?:\\.tmp\\..*|\\.generation\\..*)?$`,
  );
}
