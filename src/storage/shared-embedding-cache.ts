import { createHash } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Embeddings keyed by CONTENT, shared across every repository.
 *
 * A vector is a pure function of (model, dimensions, text). Nothing about it
 * belongs to a repository — yet embeddings were stored per repo, so the same
 * symbol text was sent to the model once per repo that contained it.
 *
 * That is not a marginal cost here. A linked worktree is a separate repo to
 * CodeSift, and its files are usually IDENTICAL to the checkout it came from:
 * `backlog-wave-1-integration` had 1,799 files and differed from main by zero.
 * With 40 worktrees registered, the same text was embedded up to 40 times.
 *
 * ---------------------------------------------------------------------------
 * v2: fixed-width binary records. Why the format changed (measured 2026-08-09)
 * ---------------------------------------------------------------------------
 *
 * v1 was ndjson, and it had three defects that together made it a wasted
 * optimization — it held **4.56%** of the symbol corpus (36,420 of 798,638
 * vectors) and had not grown since 2026-08-07 despite 35 live processes:
 *
 *  1. `appendSharedCache` accumulated the whole batch into ONE string
 *     (`payload += …`). At ~16,248 bytes per vector line that hits V8's hard
 *     `MAX_STRING_LENGTH` (536,870,888) at exactly **33,042 entries**, throwing
 *     `RangeError: Invalid string length` straight into a bare `catch {}`.
 *     7 of 37 symbol files exceed that ceiling and they hold **64%** of the
 *     corpus, so the repos that would benefit most were the only ones that
 *     silently wrote nothing.
 *  2. Every key was appended whether or not the file already had it: **11.3%**
 *     of lines were repeats.
 *  3. Text encoding. A 768-dim float32 vector is 3,072 bytes; as JSON decimals
 *     it took 16,248. A float32 round-trip of the stored values is bit-exact on
 *     1,300 sampled vectors, so this was pure waste, not precision.
 *
 * Fixing only (1) would have been worse than leaving it broken: the corpus at
 * v1's density projects to **12.1 GB**, against **2.28 GB** at fixed-width
 * float32. The V8 ceiling had been acting as an accidental circuit breaker.
 *
 * v2 record layout, little-endian throughout:
 *
 *     [16 B key][2 B dim][dim*4 B float32 vector]
 *
 * The key is `contentKey`'s 32 hex chars as raw bytes. `dim` is per record
 * rather than in a header because two models with different dimensions can
 * legitimately share this file; a header would force one file per model and a
 * mismatch would be indistinguishable from corruption.
 *
 * Append-only is retained deliberately: concurrent writers are the norm (one
 * process per agent window) and a single `appendFileSync` under `O_APPEND` is
 * the only write that is safe without a lock. Writes are now CHUNKED to a fixed
 * byte budget, on record boundaries, so no buffer approaches any engine limit
 * and a partially-written chunk can never split a record.
 *
 * The file remains DERIVED and safe to delete at any time. That is what makes
 * changing its format cheap: worst case the next index recomputes. There is no
 * v1 migration for the same reason — the old file is simply ignored, and
 * whoever wants the disk back deletes it.
 */

/** Bump when the record layout changes in a way that invalidates old entries. */
const CACHE_VERSION = 2;

/** Bytes of key stored per record — `contentKey` is 32 hex chars = 16 bytes. */
const KEY_BYTES = 16;

/**
 * Largest single `appendFileSync` payload.
 *
 * Bounded so no buffer can approach an engine limit as the corpus grows — the
 * v1 bug was exactly an unbounded accumulator. 8 MiB is ~2,700 vectors at 768
 * dims: few enough syscalls to be irrelevant, small enough that the ceiling is
 * three orders of magnitude away.
 */
const MAX_APPEND_BYTES = 8 * 1024 * 1024;

/** Sanity bound on a decoded dimension, so a corrupt byte cannot request a huge allocation. */
const MAX_DIM = 8192;

function cachePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, `shared-embeddings.v${CACHE_VERSION}.bin`);
}

/**
 * Key for a piece of text under a specific model.
 *
 * The model and dimensions are IN the key: vectors from different models are
 * not interchangeable, and serving one for the other would silently corrupt
 * every similarity score rather than fail. sha256 truncated to 128 bits —
 * collisions at that width are not a practical concern, and the shorter key
 * halves the file size.
 */
export function contentKey(model: string, dimensions: number, text: string): string {
  return createHash("sha256")
    .update(`${model}\0${dimensions}\0${text}`)
    .digest("hex")
    .slice(0, 32);
}

let memory: Map<string, Float32Array> | null = null;
let loadedFrom: string | null = null;
let warnedWriteFailure = false;

/**
 * Read the cache into memory once per process.
 *
 * Missing file, truncated tail, impossible dimension: all skipped. A cache that
 * cannot be read must degrade into "compute it again", never into an error — it
 * is an optimization, and a broken one has to stay invisible.
 *
 * A torn final record is the expected failure, not an exotic one: a writer
 * killed mid-append leaves one. Reading stops at the first record that does not
 * fit in the remaining bytes and keeps everything before it.
 */
export async function loadSharedCache(): Promise<Map<string, Float32Array>> {
  const path = cachePath();
  if (memory && loadedFrom === path) return memory;
  const map = new Map<string, Float32Array>();

  if (existsSync(path)) {
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      fd = openSync(path, "r");
      // Read in slabs rather than one buffer: the file is expected to outgrow
      // any single comfortable allocation, which is how v1 died.
      const SLAB = 4 * 1024 * 1024;
      let carry = Buffer.alloc(0);
      let offset = 0;

      while (offset < size) {
        const want = Math.min(SLAB, size - offset);
        const buf = Buffer.allocUnsafe(want);
        const got = readSync(fd, buf, 0, want, offset);
        if (got <= 0) break;
        offset += got;

        const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        let p = 0;
        for (;;) {
          if (p + KEY_BYTES + 2 > data.length) break;
          const dim = data.readUInt16LE(p + KEY_BYTES);
          if (dim === 0 || dim > MAX_DIM) {
            // Not a plausible record: the file is corrupt from here on. Keep
            // what was read and stop, rather than resyncing on a guess.
            p = data.length;
            offset = size;
            break;
          }
          const total = KEY_BYTES + 2 + dim * 4;
          if (p + total > data.length) break; // record spans the slab boundary
          const key = data.subarray(p, p + KEY_BYTES).toString("hex");
          const vec = new Float32Array(dim);
          for (let i = 0; i < dim; i++) vec[i] = data.readFloatLE(p + KEY_BYTES + 2 + i * 4);
          map.set(key, vec);
          p += total;
        }
        carry = p < data.length ? Buffer.from(data.subarray(p)) : Buffer.alloc(0);
      }
    } catch {
      // Unreadable — behave as if empty.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already gone */
        }
      }
    }
  }

  memory = map;
  loadedFrom = path;
  return map;
}

function encodeRecord(key: string, vec: Float32Array): Buffer | null {
  if (key.length !== KEY_BYTES * 2 || vec.length === 0 || vec.length > MAX_DIM) return null;
  const rec = Buffer.allocUnsafe(KEY_BYTES + 2 + vec.length * 4);
  rec.write(key, 0, KEY_BYTES, "hex");
  rec.writeUInt16LE(vec.length, KEY_BYTES);
  for (let i = 0; i < vec.length; i++) rec.writeFloatLE(vec[i] as number, KEY_BYTES + 2 + i * 4);
  return rec;
}

/**
 * Append new vectors. Both the file and the in-memory map are updated, so a
 * second repo indexed in the same process hits memory rather than disk.
 *
 * Entries already present are skipped: v1 appended unconditionally and 11.3% of
 * its lines were repeats of a key it already held. Dedup happens against the
 * in-memory map, so it is exact within a process and best-effort across them —
 * which is the same guarantee append-only gave before, at a fraction of the
 * bytes.
 */
export function appendSharedCache(entries: Array<{ key: string; vec: Float32Array }>): void {
  if (entries.length === 0) return;
  const path = cachePath();
  try {
    mkdirSync(join(path, ".."), { recursive: true });

    let batch: Buffer[] = [];
    let batchBytes = 0;
    const flush = (): void => {
      if (batch.length === 0) return;
      // One append per chunk, always ending on a record boundary, so a
      // concurrent writer can interleave BETWEEN records but never inside one.
      appendFileSync(path, Buffer.concat(batch));
      batch = [];
      batchBytes = 0;
    };

    for (const { key, vec } of entries) {
      if (memory?.has(key)) continue; // already stored — v1 wrote it again
      const rec = encodeRecord(key, vec);
      if (!rec) continue;
      if (memory) memory.set(key, vec);
      if (batchBytes + rec.length > MAX_APPEND_BYTES) flush();
      batch.push(rec);
      batchBytes += rec.length;
    }
    flush();
  } catch (err) {
    // A cache that cannot be written must not fail the indexing run — but v1's
    // silence is how a total write failure went unnoticed for days while the
    // cache held 4.56% of the corpus. Say it once per process.
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      console.error(
        `[codesift] shared embedding cache is not being written (${(err as Error).message}). ` +
          `Indexing continues; embeddings will be recomputed per repo.`,
      );
    }
  }
}

/** Test-only: forget the in-memory copy so a fresh path is picked up. */
export function _resetSharedCacheForTests(): void {
  memory = null;
  loadedFrom = null;
  warnedWriteFailure = false;
}
