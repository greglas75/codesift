// Pure, no-I/O safetensors parser.
// Spec: 8-byte u64-LE header length | JSON header | binary payload
// Only F32 dtype is supported; shape must be [rows, cols].

import { isValidMeta } from "./safetensors-meta-guard.js";

const MAX_HEADER_BYTES = 100 * 1024 * 1024; // 100 MB sanity cap
const HEADER_PREFIX_BYTES = 8;

// FINDING-1: safetensors mandates little-endian byte order. Float32Array on a
// big-endian host would silently mis-read bytes. We detect endianness once at
// module load and fail fast on BE hosts. The false branch is untestable on LE
// hosts (reviewer-accepted pattern for platform guards).
export const HOST_IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export interface SafetensorEntry {
  name: string;
  shape: [number, number];
  data: Float32Array;
}

type RawHeader = Record<string, unknown>;

export function parseSafetensors(buffer: Uint8Array): SafetensorEntry[] {
  if (!HOST_IS_LE)
    throw new Error("safetensors: big-endian host architectures are not supported");

  if (buffer.byteLength < HEADER_PREFIX_BYTES)
    throw new Error("safetensors: buffer too small to contain header length field");

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const headerLenBig = view.getBigUint64(0, true);

  if (headerLenBig > BigInt(MAX_HEADER_BYTES))
    throw new Error(`safetensors: header length ${headerLenBig} exceeds sanity cap of ${MAX_HEADER_BYTES} bytes`);

  const headerLen = Number(headerLenBig);

  if (HEADER_PREFIX_BYTES + headerLen > buffer.byteLength)
    throw new Error(`safetensors: header length ${headerLen} exceeds file size (${buffer.byteLength} bytes)`);

  const headerText = new TextDecoder().decode(buffer.subarray(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLen));

  let raw: unknown;
  try {
    raw = JSON.parse(headerText);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`safetensors: malformed JSON header — parse error: ${msg}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("safetensors: header JSON must be a plain object");

  const payloadStart = HEADER_PREFIX_BYTES + headerLen;

  // First pass: validate all tensor meta and collect validated spans.
  type Span = { absStart: number; absEnd: number; key: string; rows: number; cols: number; elementCount: number };
  const spans: Span[] = [];

  for (const [key, value] of Object.entries(raw as RawHeader)) {
    if (key === "__metadata__") continue;

    const meta = isValidMeta(key, value);

    if (meta.dtype !== "F32")
      throw new Error(`safetensors: unsupported dtype "${meta.dtype}" for tensor "${key}" — only F32 is supported`);

    const [rows, cols] = meta.shape as [number, number];
    const [offsetStart, offsetEnd] = meta.data_offsets;

    // CRITICAL-1: guard rows*cols overflow
    const product = rows * cols;
    if (!Number.isSafeInteger(product))
      throw new Error(`safetensors: tensor "${key}" shape [${rows}, ${cols}] causes shape overflow`);

    // CRITICAL-1: alignment and span/shape consistency
    const byteSpan = offsetEnd - offsetStart;
    if (byteSpan % 4 !== 0)
      throw new Error(`safetensors: tensor "${key}" byte span ${byteSpan} is not aligned to 4 bytes`);
    const elementCount = byteSpan / 4;
    if (elementCount !== product)
      throw new Error(`safetensors: tensor "${key}" span/shape mismatch — span has ${elementCount} F32 elements but shape [${rows}, ${cols}] requires ${product}`);

    const absStart = payloadStart + offsetStart;
    const absEnd = payloadStart + offsetEnd;

    // FINDING-3: absEnd must be a safe integer (guards against offsetStart or
    // offsetEnd near MAX_SAFE_INTEGER causing arithmetic imprecision).
    if (!Number.isSafeInteger(absEnd))
      throw new Error(`safetensors: tensor "${key}" data_offsets produce an absEnd value (${absEnd}) that is not a safe integer`);

    if (absEnd > buffer.byteLength)
      throw new Error(`safetensors: data_offsets [${offsetStart}, ${offsetEnd}] for tensor "${key}" exceed buffer bounds`);

    spans.push({ absStart, absEnd, key, rows, cols, elementCount });
  }

  // FINDING-2: O(N log N) overlap check — sort by start, single linear scan.
  // Zero-length spans (absStart === absEnd) cannot overlap anything; exclude them.
  const nonEmpty = spans.filter((s) => s.absStart < s.absEnd);
  nonEmpty.sort((a, b) => a.absStart - b.absStart);
  for (let i = 1; i < nonEmpty.length; i++) {
    const prev = nonEmpty[i - 1]!;
    const curr = nonEmpty[i]!;
    if (curr.absStart < prev.absEnd)
      throw new Error(`safetensors: tensor "${curr.key}" byte range [${curr.absStart}, ${curr.absEnd}) overlapping with tensor "${prev.key}" [${prev.absStart}, ${prev.absEnd})`);
  }

  // Second pass (original order): build entries with zero-copy or fallback.
  const entries: SafetensorEntry[] = [];
  for (const { absStart, absEnd, key, rows, cols, elementCount } of spans) {
    const byteSpan = absEnd - absStart;
    // WARNING: zero-copy when aligned; slice-copy fallback for misaligned byteOffset
    const byteOffset = buffer.byteOffset + absStart;
    const data = byteOffset % 4 === 0
      ? new Float32Array(buffer.buffer, byteOffset, elementCount)
      : new Float32Array(buffer.buffer.slice(byteOffset, byteOffset + byteSpan));

    entries.push({ name: key, shape: [rows, cols], data });
  }

  return entries;
}

export function getTensor(parsed: SafetensorEntry[], name: string): SafetensorEntry {
  const entry = parsed.find((e) => e.name === name);
  if (!entry) throw new Error(`safetensors: tensor "${name}" not found in parsed entries`);
  return entry;
}
