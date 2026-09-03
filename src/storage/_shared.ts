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
  const prefix = `${basename(targetPath)}.tmp.`;
  let removed = 0;
  try {
    const cutoff = Date.now() - minAgeMs;
    for (const entry of await readdir(dir)) {
      if (!entry.startsWith(prefix)) continue;
      const full = join(dir, entry);
      try {
        const info = await stat(full);
        if (info.mtimeMs > cutoff) continue;
        await unlink(full);
        removed++;
      } catch { /* raced with another cleaner — fine */ }
    }
  } catch { /* unreadable dir — nothing to clean */ }
  return removed;
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
  return new RegExp(`^([0-9a-f]{8,})\\.(?:${suffixes.join("|")})(?:\\.tmp\\..*)?$`);
}
