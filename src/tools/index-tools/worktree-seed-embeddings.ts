/**
 * Give a seeded worktree its donor's symbol vectors instead of embedding the tree again.
 *
 * The index seed (worktree-seed.ts) never covered vectors, so every worktree that seeded had none,
 * and every one that fell back to a full index re-embedded the whole repo. Measured 2026-10-09 on
 * tgm-survey-platform: 254 indexes of ~450k symbols each, 5 with a vector file — all of them empty —
 * and 1,021 "Embedding failed" runs in the daemon log, each discarding hours of model calls. The
 * vectors are a pure function of the symbol text, and a worktree's text is the donor's to within a
 * few files, so they were being recomputed to learn nothing.
 *
 * Why a CLONE and not a copy. A vector line is ~16 KB of JSON, so one worktree of that repo carries
 * ~7 GB of vectors, and 38 worktrees were created on 2026-10-09 alone — copying would trade the GPU
 * storm for ~270 GB of disk a day. A copy-on-write clone (APFS `clonefile`, btrfs/XFS reflink) costs
 * no space until one side is rewritten. Where the filesystem cannot clone, this declines rather than
 * duplicating gigabytes: the worktree simply has no vectors, which is the state it had before.
 *
 * The clone keeps the donor's ids, so the meta records `id_rebase` and the loader rewrites the
 * prefix per line. Rewriting the file instead would be the 7 GB write this exists to avoid.
 *
 * Known limit, accepted: vectors of files the catch-up re-parsed describe the donor's version of
 * those files until the next embedding run for this worktree, whose per-symbol content hashes then
 * replace exactly those. Symbols that are new in the worktree have no vector until then. Semantic
 * search skips ids missing from the index, so neither returns a wrong symbol.
 */
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import {
  getEmbeddingMetaPath,
  getEmbeddingPath,
  loadEmbeddingMeta,
  saveEmbeddingMeta,
} from "../../storage/embedding-store.js";

export interface EmbeddingSeedResult {
  seeded: boolean;
  /** Why no vectors were seeded. Present exactly when `seeded` is false. */
  reason?: string;
  vectors?: number;
}

/**
 * Copy-on-write clone, or a throw. Never a byte copy.
 *
 * libuv implements `COPYFILE_FICLONE_FORCE` with the FICLONE ioctl, which is Linux-only: on macOS it
 * answers ENOSYS even on APFS, where cloning is native (measured on this machine's data dir). `cp -c`
 * calls clonefile(2) directly and fails rather than falling back — a 300 MB file cloned with it cost
 * 8 KB of free space.
 */
async function cloneFile(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
  } catch (err) {
    if (process.platform !== "darwin") throw err;
    await promisify(execFile)("cp", ["-c", source, target], { timeout: 30_000 });
  }
}

/** True when `indexPath` has a vector file with at least one vector, by its meta. */
export async function hasSymbolEmbeddings(indexPath: string): Promise<boolean> {
  if (!existsSync(getEmbeddingPath(indexPath))) return false;
  const meta = await loadEmbeddingMeta(getEmbeddingMetaPath(indexPath));
  return (meta?.symbol_count ?? 0) > 0;
}

export async function seedEmbeddingsFromDonor(
  donorIndexPath: string,
  donorName: string,
  targetIndexPath: string,
  targetName: string,
): Promise<EmbeddingSeedResult> {
  const donorVectors = getEmbeddingPath(donorIndexPath);
  if (!existsSync(donorVectors)) return { seeded: false, reason: "donor has no vectors" };
  const donorMeta = await loadEmbeddingMeta(getEmbeddingMetaPath(donorIndexPath));
  if (!donorMeta || donorMeta.symbol_count <= 0) return { seeded: false, reason: "donor has no vectors" };

  const targetVectors = getEmbeddingPath(targetIndexPath);
  const tempVectors = `${targetVectors}.seeding.${process.pid}`;
  try {
    await cloneFile(donorVectors, tempVectors);
  } catch (err) {
    await unlink(tempVectors).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    return { seeded: false, reason: `filesystem cannot clone the vector file (${code}) — not copying it` };
  }

  const targetMetaPath = getEmbeddingMetaPath(targetIndexPath);
  // What the target's meta was, so a failed rename can put it back — otherwise the donor's count and
  // id rebase stay attached to whatever vector file the target already had.
  const previousMeta = await loadEmbeddingMeta(targetMetaPath);
  let metaWritten = false;
  try {
    // A donor that is itself a seeded clone still carries ITS donor's ids; rebasing from those keeps
    // a chain of seeds pointing at the ids actually in the bytes.
    const from = donorMeta.id_rebase?.from ?? `${donorName}:`;
    // Meta first, then the vectors. A reader that sees the new meta with the old (or no) vector file
    // finds no id carrying `from` and rewrites nothing; the reverse order would expose the donor's
    // ids under this repo's name for a moment, matching nothing in its index.
    await saveEmbeddingMeta(targetMetaPath, {
      ...donorMeta,
      updated_at: Date.now(),
      id_rebase: { from, to: `${targetName}:` },
    });
    metaWritten = true;
    await rename(tempVectors, targetVectors);
    return { seeded: true, vectors: donorMeta.symbol_count };
  } catch (err) {
    await unlink(tempVectors).catch(() => undefined);
    let restore = "";
    if (metaWritten) {
      await (previousMeta ? saveEmbeddingMeta(targetMetaPath, previousMeta) : unlink(targetMetaPath)).catch(
        (restoreErr: unknown) => {
          restore = `; the target meta could not be restored (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)})`;
        },
      );
    }
    return { seeded: false, reason: `vector seed failed: ${err instanceof Error ? err.message : String(err)}${restore}` };
  }
}
