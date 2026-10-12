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
import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { copyFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  getChunkEmbeddingPath,
  getChunkManifestPath,
  getChunkPath,
  loadChunkManifest,
  type ChunkIndexManifest,
} from "../../storage/chunk-store.js";
import {
  currentEmbeddingFile,
  embeddingFileExists,
  getEmbeddingMetaPath,
  getEmbeddingPath,
  loadEmbeddingMeta,
  saveEmbeddingMeta,
  unlinkIfPresent,
  vectorFilePathFor,
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
  if (!embeddingFileExists(getEmbeddingPath(indexPath))) return false;
  const meta = await loadEmbeddingMeta(getEmbeddingMetaPath(indexPath));
  return (meta?.symbol_count ?? 0) > 0;
}

export async function seedEmbeddingsFromDonor(
  donorIndexPath: string,
  donorName: string,
  targetIndexPath: string,
  targetName: string,
): Promise<EmbeddingSeedResult> {
  const donorVectors = currentEmbeddingFile(getEmbeddingPath(donorIndexPath));
  if (!donorVectors) return { seeded: false, reason: "donor has no vectors" };
  const donorMeta = await loadEmbeddingMeta(getEmbeddingMetaPath(donorIndexPath));
  if (!donorMeta || donorMeta.symbol_count <= 0) return { seeded: false, reason: "donor has no vectors" };

  // The clone keeps the donor's format (`.vec` or ndjson), and the target's file of the OTHER kind is
  // removed: `currentEmbeddingFile` prefers a `.vec`, so a stale one beside a cloned ndjson would be
  // read instead of it.
  const targetNdjson = getEmbeddingPath(targetIndexPath);
  const targetVec = vectorFilePathFor(targetNdjson);
  const donorIsVec = donorVectors.endsWith(".embeddings.vec");
  // Binary bytes under the ndjson name would read as no vectors while reporting a seed.
  if (donorIsVec && !targetVec) return { seeded: false, reason: "target cannot hold a vector file" };
  const targetVectors = donorIsVec && targetVec ? targetVec : targetNdjson;
  const otherKind = targetVectors === targetNdjson ? targetVec : targetNdjson;
  const tempVectors = `${targetVectors}.seeding.${process.pid}.${randomUUID()}`;
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
    // A stale `.vec` goes BEFORE the ndjson clone is published, and a failure to remove it fails the
    // seed: removed after, a crash or a failed unlink would leave it winning every read under the
    // donor's meta. A stale ndjson beside a cloned `.vec` is never read, so it can go after.
    if (otherKind && otherKind === targetVec) await unlinkIfPresent(otherKind);
    await rename(tempVectors, targetVectors);
    if (otherKind && otherKind !== targetVec) await unlink(otherKind).catch(() => undefined);
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

/**
 * Before an embedding run starts from nothing, clone the vectors of the indexed checkout NEAREST in
 * this tree's history that has them — so a full index of a worktree costs the files that differ,
 * not the repo.
 *
 * The seed (worktree-seed.ts) clones vectors only on its own path. A worktree that fell back to a
 * full index — or was indexed before any donor had vectors — embedded everything, and so did each of
 * its siblings, at the same time. Measured 2026-10-11: two rdesigner worktrees at the SAME develop
 * commit embedding the same 463k symbols side by side, halving each other's share of a model that
 * serves one request at a time.
 *
 * Only when this repo's own vector file holds no vectors. An EMPTY file left by a failed run counts as
 * none: measured 2026-10-12, a 0-byte file from 8 October sent a worktree into a from-scratch run of
 * 463k symbols while a sibling had all of them. A checkpoint does not block the clone — the run loads
 * both and the checkpoint's vectors win, so the clone only fills what the checkpoint lacks. The donor
 * must have a COMPLETE vector file (its meta counts the vectors); a donor still being embedded has
 * only a checkpoint, which is not cloned. What the clone gets wrong — files that differ from the
 * donor — the run's content hashes find and re-embed, and vectors from another model are refused by
 * the run's model check.
 */
export async function cloneVectorsFromNearestDonor(
  rootPath: string,
  repoName: string,
  indexPath: string,
): Promise<EmbeddingSeedResult & { donor?: string; distance?: number }> {
  if (await hasSymbolEmbeddings(indexPath)) return { seeded: false, reason: "has vectors of its own" };
  const best = await nearestDonor(rootPath, repoName, hasSymbolEmbeddings);
  if (best === null) return { seeded: false, reason: "no git history to place a donor in" };
  if (!best) return { seeded: false, reason: "no indexed checkout in this history has vectors" };

  const result = await seedEmbeddingsFromDonor(best.index_path, best.name, indexPath, repoName);
  return { ...result, donor: best.name, distance: best.distance };
}

/**
 * The registered checkout nearest in this tree's history for which `has(index_path)` holds.
 * `null` when the tree has no history to place one in, `undefined` when none qualifies.
 */
async function nearestDonor(
  rootPath: string,
  repoName: string,
  has: (indexPath: string) => Promise<boolean>,
): Promise<{ name: string; index_path: string; distance: number } | null | undefined> {
  const { headHistory } = await import("./worktree-seed.js");
  const { listRepos } = await import("../../storage/registry.js");
  const { loadConfig } = await import("../../config.js");
  const history = await headHistory(rootPath);
  if (history.size === 0) return null;

  let best: { name: string; index_path: string; distance: number } | undefined;
  for (const candidate of await listRepos(loadConfig().registryPath).catch(() => [])) {
    if (candidate.name === repoName || !candidate.last_git_commit) continue;
    const distance = history.get(candidate.last_git_commit);
    if (distance === undefined || (best && distance >= best.distance)) continue;
    if (!(await has(candidate.index_path))) continue;
    best = { name: candidate.name, index_path: candidate.index_path, distance };
  }
  return best;
}

/**
 * The published chunk manifest of `indexPath` when its vectors can be reused by content: written by
 * `model` (which also marks hashed lines) and pointing at a non-empty vector file that exists.
 */
export async function reusableChunkManifest(indexPath: string, model: string): Promise<ChunkIndexManifest | null> {
  const manifest = await loadChunkManifest(getChunkPath(indexPath)).catch(() => null);
  if (manifest?.model !== model) return null;
  try {
    return statSync(join(dirname(indexPath), manifest.embeddings)).size > 0 ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Chunk twin of `cloneVectorsFromNearestDonor`: before a chunk pass starts from nothing, clone the
 * published chunk generation of the nearest checkout that has one, so the pass embeds only what
 * differs.
 *
 * Measured 2026-10-12: no rdesigner checkout had ever finished a chunk pass — each worktree started
 * it from zero, behind its own symbol pass, and lost it on the next restart. The clone takes BOTH
 * files of the generation (chunk text and vectors), so a query on this checkout reads a consistent
 * pair at once; the ids keep the donor's prefix, recorded as `id_rebase` for the embedding run.
 */
export async function cloneChunksFromNearestDonor(
  rootPath: string,
  repoName: string,
  indexPath: string,
  model: string,
): Promise<EmbeddingSeedResult & { donor?: string; distance?: number }> {
  if (await reusableChunkManifest(indexPath, model)) return { seeded: false, reason: "has chunk vectors of its own" };
  const best = await nearestDonor(rootPath, repoName, async (p) => (await reusableChunkManifest(p, model)) !== null);
  if (best === null) return { seeded: false, reason: "no git history to place a donor in" };
  if (!best) return { seeded: false, reason: "no indexed checkout in this history has chunk vectors" };
  const donor = await reusableChunkManifest(best.index_path, model);
  if (!donor) return { seeded: false, reason: "donor chunk vectors vanished" };

  const donorDir = dirname(best.index_path);
  const generation = `${process.pid}.${randomUUID()}`;
  const chunks = `${getChunkPath(indexPath)}.generation.${generation}`;
  const vectors = `${getChunkEmbeddingPath(indexPath)}.generation.${generation}`;
  const manifestPath = getChunkManifestPath(getChunkPath(indexPath));
  const manifestTmp = `${manifestPath}.tmp.${generation}`;
  try {
    await cloneFile(join(donorDir, donor.chunks), chunks);
    await cloneFile(join(donorDir, donor.embeddings), vectors);
  } catch (err) {
    await Promise.all([unlink(chunks).catch(() => undefined), unlink(vectors).catch(() => undefined)]);
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    return { seeded: false, reason: `filesystem cannot clone the chunk files (${code}) — not copying them` };
  }
  try {
    const manifest: ChunkIndexManifest = {
      version: 1,
      chunks: basename(chunks),
      embeddings: basename(vectors),
      model,
      id_rebase: { from: donor.id_rebase?.from ?? `${best.name}:`, to: `${repoName}:` },
    };
    await writeFile(manifestTmp, `${JSON.stringify(manifest)}\n`, "utf8");
    await rename(manifestTmp, manifestPath);
  } catch (err) {
    await Promise.all([chunks, vectors, manifestTmp].map((p) => unlink(p).catch(() => undefined)));
    return { seeded: false, reason: `chunk seed failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { seeded: true, donor: best.name, distance: best.distance };
}
