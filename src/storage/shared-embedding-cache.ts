import { createHash } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
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
 *     [16 B key][2 B dim][4 B crc32 of the vector bytes][dim*4 B float32 vector]
 *
 * The checksum is not ceremony. Corruption injection against the first draft of this reader
 * (2026-08-09) measured what a record without one costs: two flipped bytes inside a vector were
 * served as a valid embedding — 1000 of 1000 records "read successfully", one of them silently
 * wrong — and 99.417% of a 3,090-byte record was payload that nothing verified. A wrong vector is
 * worse than a missing one: it produces a plausible similarity score instead of a cache miss.
 *
 * It also buys RESYNC. That same pass showed one implausible dim byte at record 10 cost 99% of the
 * file, because the reader stopped rather than guess. With a checksum the reader can skip exactly
 * one record and carry on, and be right about having skipped it.
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

/** key + dim + crc, before the vector payload. */
const HEADER_BYTES = KEY_BYTES + 2 + 4;

/**
 * CRC-32 of the vector bytes.
 *
 * Not cryptographic and not meant to be: the threat is a torn write or a flipped bit, not an
 * adversary. 4 bytes on a 3,090-byte record is 0.13% for the difference between "this vector is
 * wrong" and "this vector is wrong and nobody can tell".
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

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

/**
 * Ceiling on how much of the cache is held resident, in bytes of vector payload.
 *
 * This bound is not optional decoration. Until the writer was fixed, appends threw
 * `RangeError` above ~33k entries into a bare catch, so the file was accidentally frozen at 4.56%
 * of the corpus and nobody had to think about the read side. Fixing the writer — and adding chunk
 * texts to the same cache — let it grow for real, and `loadSharedCache` materialises EVERY record
 * into a `Map` that no budget governs: measured +1.17 GB RSS and a multi-second event-loop freeze
 * in a long-lived MCP server, on a machine that routinely runs 24–37 codesift processes at once.
 *
 * Stopping early is the correct degradation for this structure. The cache is a write-side
 * optimization whose only failure mode is a cache MISS, so a partially loaded one is still
 * completely correct — it just recomputes more. That is the same contract as an unreadable file.
 *
 * Default is deliberately modest and scales with the machine, matching the embedding/index budgets
 * (`CODESIFT_MAX_EMBEDDING_MEM_MB`, `CODESIFT_MAX_INDEX_CACHE_MB`). Override with
 * `CODESIFT_MAX_SHARED_CACHE_MB`; `0` disables the shared cache read entirely.
 */
function sharedCacheBudgetBytes(): number {
  const raw = process.env["CODESIFT_MAX_SHARED_CACHE_MB"];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1024 * 1024;
  }
  const totalGb = totalmem() / 1024 ** 3;
  const mb = totalGb <= 16 ? 64 : totalGb <= 32 ? 128 : 256;
  return mb * 1024 * 1024;
}

/**
 * Basename of the cache file this build reads and writes.
 *
 * Exported so `prune` can reclaim SUPERSEDED versions without hard-coding a name
 * that would drift on the next format bump: it deletes every `shared-embeddings.*`
 * that is not this one. A format bump otherwise strands the old file forever —
 * nothing opens it and nothing deletes it, because it has no hash prefix for the
 * artifact sweep to match (1.05 GB measured after the v1→v2 bump).
 */
export function currentSharedCacheFilename(): string {
  return `shared-embeddings.v${CACHE_VERSION}.bin`;
}

function cachePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, currentSharedCacheFilename());
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

  const budget = sharedCacheBudgetBytes();
  if (budget > 0 && existsSync(path)) {
    let handle: FileHandle | undefined;
    let corrupt = 0;
    let skippedTail = false;
    let resident = 0;
    let stoppedAtBudget = false;
    try {
      const size = statSync(path).size;
      // Async open/read: this runs inside the long-lived MCP server, where the
      // synchronous version blocked the event loop for seconds on a file that is
      // now hundreds of megabytes. Nothing here needs to be synchronous — the
      // function has always been async, it just was not using it.
      handle = await open(path, "r");
      // Read in slabs rather than one buffer: the file is expected to outgrow
      // any single comfortable allocation, which is how v1 died.
      const SLAB = 4 * 1024 * 1024;
      let carry = Buffer.alloc(0);
      let offset = 0;

      while (offset < size) {
        const want = Math.min(SLAB, size - offset);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead: got } = await handle.read(buf, 0, want, offset);
        if (got <= 0) break;
        offset += got;

        const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        let p = 0;
        for (;;) {
          if (p + HEADER_BYTES > data.length) break;
          const dim = data.readUInt16LE(p + KEY_BYTES);
          if (dim === 0 || dim > MAX_DIM) {
            // Cannot know where the next record starts, so this is where reading ends. Say how much
            // was kept: the first draft did this silently, and one bad byte at record 10 cost 99%
            // of the file with no way to notice.
            skippedTail = true;
            p = data.length;
            offset = size;
            break;
          }
          const total = HEADER_BYTES + dim * 4;
          if (p + total > data.length) break; // record spans the slab boundary

          const want = data.readUInt32LE(p + KEY_BYTES + 2);
          if (crc32(data, p + HEADER_BYTES, p + total) !== want) {
            // The length is intact, so the NEXT record's offset is still known: skip exactly this
            // one and keep going. Without the checksum this record would have been served as a
            // valid vector — a wrong embedding produces a plausible score, not a cache miss.
            corrupt++;
            p += total;
            continue;
          }

          if (resident + dim * 4 > budget) {
            // Stop, do not evict. Entries are equally valuable here — there is no recency to
            // exploit, since a key is looked up once per corpus pass — so the cheapest correct
            // policy is to keep the prefix already paid for and let the rest be recomputed.
            stoppedAtBudget = true;
            offset = size;
            break;
          }
          const key = data.subarray(p, p + KEY_BYTES).toString("hex");
          const vec = new Float32Array(dim);
          for (let i = 0; i < dim; i++) vec[i] = data.readFloatLE(p + HEADER_BYTES + i * 4);
          map.set(key, vec);
          resident += dim * 4;
          p += total;
        }
        carry = p < data.length ? Buffer.from(data.subarray(p)) : Buffer.alloc(0);
        if (carry.length > 0) skippedTail = true;
      }
    } catch {
      // Unreadable — behave as if empty.
    } finally {
      if (corrupt > 0 || skippedTail) {
        console.error(
          `[codesift] shared embedding cache: kept ${map.size} vectors, dropped ${corrupt} failing ` +
            `checksum${skippedTail ? " and stopped early at an unreadable record" : ""}. ` +
            `It is derived — delete ${path} to rebuild.`,
        );
      }
      if (stoppedAtBudget) {
        console.error(
          `[codesift] shared embedding cache: loaded ${map.size} vectors ` +
            `(${(resident / 1024 ** 2).toFixed(0)} MB), stopping at the ` +
            `${(budget / 1024 ** 2).toFixed(0)} MB budget. The rest will be recomputed rather than ` +
            `looked up. Raise CODESIFT_MAX_SHARED_CACHE_MB to trade memory for fewer model calls.`,
        );
      }
      if (handle !== undefined) {
        try {
          await handle.close();
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
  if (key.length !== KEY_BYTES * 2 || !/^[0-9a-f]+$/.test(key) ||
      vec.length === 0 || vec.length > MAX_DIM) return null;
  const rec = Buffer.allocUnsafe(HEADER_BYTES + vec.length * 4);
  rec.write(key, 0, KEY_BYTES, "hex");
  rec.writeUInt16LE(vec.length, KEY_BYTES);
  for (let i = 0; i < vec.length; i++) rec.writeFloatLE(vec[i] as number, HEADER_BYTES + i * 4);
  rec.writeUInt32LE(crc32(rec, HEADER_BYTES, rec.length), KEY_BYTES + 2);
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
    let batchEntries: Array<{ key: string; vec: Float32Array }> = [];
    const pendingKeys = new Set<string>();
    let batchBytes = 0;
    const flush = (): void => {
      if (batch.length === 0) return;
      // One append per chunk, always ending on a record boundary, so a
      // concurrent writer can interleave BETWEEN records but never inside one.
      appendFileSync(path, Buffer.concat(batch));
      if (memory) {
        for (const { key, vec } of batchEntries) memory.set(key, vec);
      }
      batch = [];
      batchEntries = [];
      pendingKeys.clear();
      batchBytes = 0;
    };

    for (const { key, vec } of entries) {
      const normalizedKey = key.toLowerCase();
      if (memory?.has(normalizedKey) || pendingKeys.has(normalizedKey)) continue;
      const rec = encodeRecord(normalizedKey, vec);
      if (!rec) continue;
      if (batchBytes + rec.length > MAX_APPEND_BYTES) flush();
      batch.push(rec);
      batchEntries.push({ key: normalizedKey, vec });
      pendingKeys.add(normalizedKey);
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
