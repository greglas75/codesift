/**
 * The binary vector file, `<hash>.embeddings.vec` (ADR-005 option C, ADR-006 stage 11 E2).
 *
 * A vector line in `.embeddings.ndjson` is ~16 KB of decimal text for 3 KB of float32: an rdesigner
 * worktree's file is 7.6 GB for 462,980 × 768 floats, 83 repos held 210 GB on 2026-10-12, and parsing
 * the text is what a cold load spends its time on. Same content here, 5.3× smaller, read without parsing:
 *
 *   magic      8 B   "CSVEC\0\0" + format version (1)
 *   header_len u32   then that many bytes of JSON: {"dims": D, "count": N}
 *   ids        N × (u32 byte length + UTF-8 bytes), in insertion order
 *   has_hash   N × u8   1 when the vector has a content hash (`h` in ndjson)
 *   hashes     N × u32
 *   padding    zeros up to a multiple of 64 bytes from the start of the file
 *   matrix     N × D float32
 *   trailer    u32 CRC-32 (IEEE, zlib's) of every byte before it, then "CEND"
 *
 * All integers and floats little-endian. One checksum for the whole file: a corrupt byte in the matrix
 * would otherwise be a silently wrong vector (ADR-005 measured it), so a mismatch rejects the file.
 * The Rust core reads the same layout (`crates/codesift-core/src/vectors.rs`); this module is the
 * TypeScript reader and the only writer.
 */
import { open, rename, unlink } from "node:fs/promises";
import { endianness } from "node:os";
import * as zlib from "node:zlib";

export const VECTOR_FILE_MAGIC = Buffer.from([0x43, 0x53, 0x56, 0x45, 0x43, 0x00, 0x00, 0x01]);
const TRAILER_TAG = Buffer.from("CEND", "latin1");
const ALIGN = 64;
const CHUNK_BYTES = 16 << 20;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib's CRC-32 (`zlib.crc32` from Node 20.15 / 22.2; a table otherwise — engines allow Node 20.0). */
export function crc32(data: Uint8Array, previous = 0): number {
  const native = (zlib as { crc32?: (d: Uint8Array, v?: number) => number }).crc32;
  if (typeof native === "function") return native(data, previous);
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Whether `embeddings` goes to disk as a vector file: unless `CODESIFT_VECTOR_FORMAT=ndjson` (the
 * rollback), and only when every vector has one width — a matrix cannot hold mixed ones, and those
 * keep the ndjson rather than fail the save.
 */
export function shouldWriteVectorFile(embeddings: ReadonlyMap<string, Float32Array>): boolean {
  if (process.env["CODESIFT_VECTOR_FORMAT"] === "ndjson") return false;
  let width = -1;
  for (const vec of embeddings.values()) {
    if (width === -1) width = vec.length;
    else if (vec.length !== width) return false;
  }
  // Zero-width vectors would make a matrix of nothing that the reader refuses; ndjson keeps them.
  return width !== 0;
}

/** Whether the file at `path` is a vector file (by its magic), as opposed to ndjson. False when unreadable. */
export async function isVectorFile(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    try {
      const head = Buffer.alloc(VECTOR_FILE_MAGIC.length);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      return bytesRead === head.length && head.equals(VECTOR_FILE_MAGIC);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export interface VectorFileEntry {
  id: string;
  vec: Float32Array;
  h: number | undefined;
}

/**
 * Write `entries` to `path` (temp file, then rename). Every vector must have the same width; a map of
 * mixed widths cannot be laid out as a matrix and is refused rather than truncated.
 */
export async function writeVectorFile(
  path: string,
  embeddings: ReadonlyMap<string, Float32Array>,
  hashes?: ReadonlyMap<string, number>,
): Promise<void> {
  let dims = 0;
  for (const vec of embeddings.values()) {
    dims = vec.length;
    break;
  }
  for (const vec of embeddings.values()) {
    if (vec.length !== dims) throw new Error(`vector file: mixed widths (${dims} and ${vec.length})`);
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fh = await open(tmp, "w");
  let crc = 0;
  let offset = 0;
  const write = async (buf: Uint8Array): Promise<void> => {
    crc = crc32(buf, crc);
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await fh.write(buf, done, buf.length - done);
      done += bytesWritten;
    }
    offset += buf.length;
  };
  try {
    const header = Buffer.from(JSON.stringify({ dims, count: embeddings.size }), "utf-8");
    const head = Buffer.alloc(12);
    VECTOR_FILE_MAGIC.copy(head, 0);
    head.writeUInt32LE(header.length, 8);
    await write(head);
    await write(header);

    const parts: Buffer[] = [];
    let pending = 0;
    const flush = async (): Promise<void> => {
      if (pending === 0) return;
      await write(Buffer.concat(parts, pending));
      parts.length = 0;
      pending = 0;
    };
    const push = async (buf: Buffer): Promise<void> => {
      parts.push(buf);
      pending += buf.length;
      if (pending >= CHUNK_BYTES) await flush();
    };
    for (const id of embeddings.keys()) {
      const bytes = Buffer.from(id, "utf-8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length, 0);
      await push(len);
      await push(bytes);
    }
    const flags = Buffer.alloc(embeddings.size);
    const values = Buffer.alloc(embeddings.size * 4);
    let i = 0;
    for (const id of embeddings.keys()) {
      const h = hashes?.get(id);
      if (h !== undefined && Number.isInteger(h) && h >= 0 && h <= 0xffffffff) {
        flags[i] = 1;
        values.writeUInt32LE(h, i * 4);
      }
      i++;
    }
    await push(flags);
    await push(values);
    await flush();
    const pad = (ALIGN - (offset % ALIGN)) % ALIGN;
    if (pad > 0) await write(Buffer.alloc(pad));

    const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / Math.max(1, dims * 4)));
    const chunk = Buffer.allocUnsafeSlow(perChunk * dims * 4);
    const view = new Float32Array(chunk.buffer, chunk.byteOffset, perChunk * dims);
    let filled = 0;
    const littleEndian = endianness() === "LE";
    for (const vec of embeddings.values()) {
      if (littleEndian) view.set(vec, filled * dims);
      else for (let k = 0; k < dims; k++) chunk.writeFloatLE(vec[k]!, (filled * dims + k) * 4);
      filled++;
      if (filled === perChunk) {
        await write(chunk);
        filled = 0;
      }
    }
    if (filled > 0) await write(chunk.subarray(0, filled * dims * 4));

    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(crc >>> 0, 0);
    TRAILER_TAG.copy(trailer, 4);
    let done = 0;
    while (done < trailer.length) {
      const { bytesWritten } = await fh.write(trailer, done, trailer.length - done);
      done += bytesWritten;
    }
    await fh.sync();
    await fh.close();
    await rename(tmp, path);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Whether `path` is a whole, intact vector file: its magic, its trailer, and the CRC of every byte
 * before the trailer — streamed, nothing materialised. What `prune` asks before deleting the ndjson
 * a `.vec` replaced, so a damaged `.vec` never costs the only copy of the vectors.
 */
export async function verifyVectorFile(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    try {
      const size = (await fh.stat()).size;
      if (size < VECTOR_FILE_MAGIC.length + 4 + 8) return false;
      const buf = Buffer.allocUnsafeSlow(Math.min(CHUNK_BYTES, size));
      let crc = 0;
      let pos = 0;
      const end = size - 8;
      while (pos < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
        if (bytesRead === 0) return false;
        if (pos === 0 && !buf.subarray(0, VECTOR_FILE_MAGIC.length).equals(VECTOR_FILE_MAGIC)) return false;
        crc = crc32(buf.subarray(0, bytesRead), crc);
        pos += bytesRead;
      }
      const trailer = Buffer.alloc(8);
      const { bytesRead } = await fh.read(trailer, 0, 8, end);
      return bytesRead === 8 && trailer.subarray(4).equals(TRAILER_TAG) && trailer.readUInt32LE(0) === crc >>> 0;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Why a file could not be read, for the one log line its caller prints. */
export class VectorFileError extends Error {
  constructor(message: string) {
    super(`vector file: ${message}`);
    this.name = "VectorFileError";
  }
}

export interface ReadVectorFileOptions {
  /** Resident bytes the caller may hold; above it nothing is returned (`overBudget: true`). */
  maxBytes?: number;
  rebase?: { from: string; to: string } | null;
}

export interface ReadVectorFileResult {
  embeddings: Map<string, Float32Array>;
  hashes: Map<string, number>;
  overBudget: boolean;
}

/**
 * Read a vector file into the loader's shapes. Throws `VectorFileError` on a foreign, truncated or
 * corrupt file — the whole file, since a checksum cannot say which vector is wrong.
 */
export async function readVectorFile(path: string, opts: ReadVectorFileOptions = {}): Promise<ReadVectorFileResult> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    let crc = 0;
    const take = async (n: number): Promise<Buffer> => {
      if (pos + n > size - 8) throw new VectorFileError("truncated");
      const buf = Buffer.allocUnsafeSlow(n);
      let got = 0;
      while (got < n) {
        const { bytesRead } = await fh.read(buf, got, n - got, pos + got);
        if (bytesRead === 0) throw new VectorFileError("truncated");
        got += bytesRead;
      }
      pos += n;
      crc = crc32(buf, crc);
      return buf;
    };

    const head = await take(12);
    if (!head.subarray(0, 8).equals(VECTOR_FILE_MAGIC)) throw new VectorFileError("not a vector file (magic)");
    const header = JSON.parse((await take(head.readUInt32LE(8))).toString("utf-8")) as { dims?: unknown; count?: unknown };
    const dims = header.dims;
    const count = header.count;
    // Bounded by the file before anything is allocated from them: a damaged header must be an error,
    // not an array of whatever length it claims.
    if (
      typeof dims !== "number" || typeof count !== "number" || !Number.isInteger(dims) || !Number.isInteger(count) ||
      dims < 0 || count < 0 || count > size || dims > size
    ) {
      throw new VectorFileError("bad header");
    }

    const ids: string[] = new Array(count);
    let idBytes = 0;
    // Ids are short; read them in slabs rather than one syscall each.
    let slab = Buffer.alloc(0);
    let at = 0;
    const need = async (n: number): Promise<void> => {
      if (slab.length - at >= n) return;
      const rest = slab.subarray(at);
      const more = await take(Math.min(Math.max(n - rest.length, CHUNK_BYTES), size - 8 - pos));
      slab = Buffer.concat([rest, more]);
      at = 0;
    };
    // `take` checksums what it reads, and the slab reads ahead past the id table; whatever is left
    // over is the start of what follows, handed on below instead of read twice.
    for (let i = 0; i < count; i++) {
      await need(4);
      const len = slab.readUInt32LE(at);
      at += 4;
      await need(len);
      ids[i] = slab.toString("utf-8", at, at + len);
      at += len;
      idBytes += ids[i]!.length;
    }
    const readAhead = async (n: number): Promise<Buffer> => {
      await need(n);
      const out = slab.subarray(at, at + n);
      at += n;
      return out;
    };
    const flags = await readAhead(count);
    const hashValues = await readAhead(count * 4);

    const resident = count * (dims * 4 + 48) + idBytes * 2;
    const embeddings = new Map<string, Float32Array>();
    const hashes = new Map<string, number>();
    if (resident > (opts.maxBytes ?? Number.POSITIVE_INFINITY)) {
      return { embeddings, hashes, overBudget: true };
    }

    const consumed = pos - (slab.length - at);
    const pad = (ALIGN - (consumed % ALIGN)) % ALIGN;
    const padding = await readAhead(pad);
    if (padding.some((b) => b !== 0)) throw new VectorFileError("bad padding");
    const matrixBytes = count * dims * 4;
    if (consumed + pad + matrixBytes + 8 !== size) throw new VectorFileError("size does not match the header");

    const littleEndian = endianness() === "LE";
    const rebase = opts.rebase ?? null;
    let index = 0;
    let carry: Buffer = slab.subarray(at);
    const rowBytes = dims * 4;
    const emit = (buf: Buffer): Buffer => {
      let off = 0;
      while (buf.length - off >= rowBytes && index < count) {
        const vec = new Float32Array(dims);
        if (littleEndian && (buf.byteOffset + off) % 4 === 0) {
          vec.set(new Float32Array(buf.buffer, buf.byteOffset + off, dims));
        } else {
          for (let k = 0; k < dims; k++) vec[k] = buf.readFloatLE(off + k * 4);
        }
        let id = ids[index]!;
        if (rebase && id.startsWith(rebase.from)) id = rebase.to + id.slice(rebase.from.length);
        // A Map's set: a repeated id keeps its first position and takes the last value.
        embeddings.set(id, vec);
        if (flags[index] === 1) hashes.set(id, hashValues.readUInt32LE(index * 4));
        index++;
        off += rowBytes;
      }
      return buf.subarray(off);
    };
    carry = emit(carry);
    const rowsPerRead = Math.max(1, Math.floor(CHUNK_BYTES / Math.max(1, rowBytes)));
    while (index < count && dims > 0) {
      const want = Math.min(rowsPerRead * rowBytes, size - 8 - pos);
      const more = await take(Math.max(want, rowBytes - carry.length));
      carry = emit(carry.length > 0 ? Buffer.concat([carry, more]) : more);
    }
    if (dims === 0 && count > 0) throw new VectorFileError("zero-width vectors");

    const trailer = Buffer.allocUnsafeSlow(8);
    const { bytesRead } = await fh.read(trailer, 0, 8, size - 8);
    if (bytesRead !== 8 || !trailer.subarray(4).equals(TRAILER_TAG)) throw new VectorFileError("missing trailer");
    if (trailer.readUInt32LE(0) !== crc >>> 0) throw new VectorFileError("checksum mismatch");
    return { embeddings, hashes, overBudget: false };
  } finally {
    await fh.close();
  }
}
