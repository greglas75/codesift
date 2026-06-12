import { describe, it, expect, beforeEach } from "vitest";
import { parseSafetensors, getTensor } from "../../src/utils/safetensors-loader.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal valid safetensors buffer
// Format: [u64-LE header length] [JSON header bytes] [payload bytes]
// ---------------------------------------------------------------------------
function buildSafetensors(
  headerJson: string,
  payload: Float32Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(headerJson);
  const headerLen = BigInt(headerBytes.byteLength);

  const buf = new Uint8Array(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(buf.buffer);

  // u64-LE header length
  view.setBigUint64(0, headerLen, true);

  // JSON header
  buf.set(headerBytes, 8);

  // float32 payload (little-endian copy, safe regardless of alignment)
  const payloadU8 = new Uint8Array(payload.buffer);
  buf.set(payloadU8, 8 + headerBytes.byteLength);

  return buf;
}

describe("parseSafetensors + getTensor", () => {
  // Q19: fixtures rebuilt per test via beforeEach to avoid shared mutable typed arrays
  let FLOATS: Float32Array;
  let HEADER_JSON: string;
  let VALID_BUF: Uint8Array;

  beforeEach(() => {
    FLOATS = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]); // 2×4, 8 floats = 32 bytes
    HEADER_JSON = JSON.stringify({
      embeddings: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
    });
    VALID_BUF = buildSafetensors(HEADER_JSON, FLOATS);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("parses tensor shape and float values correctly", () => {
    const parsed = parseSafetensors(VALID_BUF);
    const entry = getTensor(parsed, "embeddings");
    expect(entry.shape).toEqual([2, 4]);
    expect(Array.from(entry.data)).toEqual(Array.from(FLOATS));
  });

  it("returns empty matrix for zero-row tensor [0,4] without throwing", () => {
    const emptyHeader = JSON.stringify({
      empty: { dtype: "F32", shape: [0, 4], data_offsets: [0, 0] },
    });
    const buf = buildSafetensors(emptyHeader, new Float32Array(0));
    const parsed = parseSafetensors(buf);
    const entry = getTensor(parsed, "empty");
    expect(entry.shape).toEqual([0, 4]);
    expect(entry.data.length).toBe(0);
  });

  // Q12: __metadata__ key must be skipped
  it("skips __metadata__ key and does not include it in results", () => {
    const headerWithMeta = JSON.stringify({
      __metadata__: { version: "1.0", author: "test" },
      embeddings: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerWithMeta, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const parsed = parseSafetensors(buf);
    expect(parsed.map((e) => e.name)).not.toContain("__metadata__");
    expect(parsed.map((e) => e.name)).toContain("embeddings");
    expect(parsed).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Error paths — buffer structure
  // -------------------------------------------------------------------------

  it("throws when buffer is smaller than HEADER_PREFIX_BYTES (8 bytes)", () => {
    expect(() => parseSafetensors(new Uint8Array(4))).toThrow(
      "safetensors: buffer too small to contain header length field",
    );
  });

  it("throws when header length field exceeds MAX_HEADER_BYTES cap", () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    // Set header length to 200 MB (> 100 MB cap)
    view.setBigUint64(0, BigInt(200 * 1024 * 1024), true);
    expect(() => parseSafetensors(buf)).toThrow(
      "safetensors: header length",
    );
    expect(() => parseSafetensors(buf)).toThrow(
      "exceeds sanity cap",
    );
  });

  it("throws when header length field exceeds actual file size", () => {
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    // Claim header is 1000 bytes but buffer is only 16 bytes
    view.setBigUint64(0, BigInt(1000), true);
    expect(() => parseSafetensors(buf)).toThrow(
      "safetensors: header length 1000 exceeds file size",
    );
  });

  it("throws a descriptive error on malformed JSON header", () => {
    const bad = buildSafetensors("{not valid json", new Float32Array(0));
    expect(() => parseSafetensors(bad)).toThrow("safetensors: malformed JSON header");
  });

  it("throws when header JSON is not a plain object (array)", () => {
    // Build buffer manually with array JSON
    const headerJson = "[1, 2, 3]";
    const buf = buildSafetensors(headerJson, new Float32Array(0));
    expect(() => parseSafetensors(buf)).toThrow("safetensors: header JSON must be a plain object");
  });

  it("throws when header JSON is not a plain object (string)", () => {
    const headerJson = '"just a string"';
    const buf = buildSafetensors(headerJson, new Float32Array(0));
    expect(() => parseSafetensors(buf)).toThrow("safetensors: header JSON must be a plain object");
  });

  it("throws on non-F32 dtype (e.g. I8)", () => {
    const badHeader = JSON.stringify({
      weights: { dtype: "I8", shape: [2, 4], data_offsets: [0, 8] },
    });
    const buf = buildSafetensors(badHeader, new Int8Array(8) as unknown as Float32Array);
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: unsupported dtype "I8" for tensor "weights"',
    );
  });

  // -------------------------------------------------------------------------
  // CQ3/CQ10 — tensor meta validation (new branches)
  // -------------------------------------------------------------------------

  it("throws when tensor meta value is null (not an object)", () => {
    const headerJson = JSON.stringify({ weights: null });
    const buf = buildSafetensors(headerJson, new Float32Array(0));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor meta for "weights" must be a non-null object',
    );
  });

  it("throws when tensor meta value is an array (not a plain object)", () => {
    const headerJson = JSON.stringify({ weights: [1, 2, 3] });
    const buf = buildSafetensors(headerJson, new Float32Array(0));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor meta for "weights" must be a non-null object',
    );
  });

  it("throws when tensor meta value is a string (not an object)", () => {
    const headerJson = JSON.stringify({ weights: "bad" });
    const buf = buildSafetensors(headerJson, new Float32Array(0));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor meta for "weights" must be a non-null object',
    );
  });

  it("throws when meta.dtype is missing (not a string)", () => {
    const headerJson = JSON.stringify({
      weights: { shape: [2, 4], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.dtype must be a string',
    );
  });

  it("throws when meta.shape is missing", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.shape must be a 2-element array of numbers',
    );
  });

  it("throws when meta.shape has wrong length (1 element)", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [4], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.shape must be a 2-element array of numbers',
    );
  });

  it("throws when meta.shape contains non-numbers", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, "4"], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.shape must be a 2-element array of numbers',
    );
  });

  it("throws when meta.data_offsets is missing", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, 4] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.data_offsets must be a 2-element array of numbers',
    );
  });

  it("throws when meta.data_offsets has wrong length", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, 4], data_offsets: [0] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.data_offsets must be a 2-element array of numbers',
    );
  });

  it("throws when offsetStart is negative", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, 4], data_offsets: [-1, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    // CRITICAL-2 fires first: -1 fails the isInteger && >= 0 check
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.data_offsets must be integers >= 0',
    );
  });

  it("throws when offsetEnd < offsetStart", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, 4], data_offsets: [16, 8] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" data_offsets[16, 8]: offsetEnd must be >= offsetStart',
    );
  });

  it("throws when data_offsets extend beyond buffer bounds", () => {
    // payload is 32 bytes (8 floats); claim 10000 bytes (multiple of 4, matches shape 2500 elements).
    // Shape [50,50] = 2500 elements = 10000 bytes. Span/shape would match, but buffer is only 32 bytes.
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [50, 50], data_offsets: [0, 10000] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: data_offsets [0, 10000] for tensor "weights" exceed buffer bounds',
    );
  });

  // -------------------------------------------------------------------------
  // getTensor error paths
  // -------------------------------------------------------------------------

  it("throws a descriptive error when getTensor name is not found", () => {
    const parsed = parseSafetensors(VALID_BUF);
    expect(() => getTensor(parsed, "nonexistent")).toThrow(
      'safetensors: tensor "nonexistent" not found in parsed entries',
    );
  });

  it("throws when getTensor is called on empty parsed array", () => {
    expect(() => getTensor([], "x")).toThrow(
      'safetensors: tensor "x" not found in parsed entries',
    );
  });

  // -------------------------------------------------------------------------
  // CRITICAL-1: shape vs byte-span validation
  // -------------------------------------------------------------------------

  it("CRITICAL-1: throws when byte span / 4 does not match rows*cols (span too small)", () => {
    // shape [2,4] = 8 elements = 32 bytes, but data_offsets says only 16 bytes
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, 4], data_offsets: [0, 16] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(4)); // 16 bytes payload
    expect(() => parseSafetensors(buf)).toThrow(
      "span/shape mismatch",
    );
  });

  it("CRITICAL-1: throws when byte span is not a multiple of 4 (unaligned)", () => {
    // shape [1,3] = 3 elements = 12 bytes; we give 11 bytes (odd span)
    // Use a shape that would need 11 bytes but provide a 3-byte span
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [1, 3], data_offsets: [0, 11] },
    });
    // payload must be big enough: 11 bytes
    const payload = new Uint8Array(12);
    const headerBytes = new TextEncoder().encode(headerJson);
    const total = 8 + headerBytes.byteLength + 11;
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, BigInt(headerBytes.byteLength), true);
    buf.set(headerBytes, 8);
    // payload bytes at end (11 bytes from the 12-byte array)
    buf.set(payload.subarray(0, 11), 8 + headerBytes.byteLength);
    expect(() => parseSafetensors(buf)).toThrow(
      "not aligned to 4 bytes",
    );
  });

  it("CRITICAL-1: passes when byte span exactly matches shape (2×4 = 32 bytes)", () => {
    // This is the standard valid case
    const parsed = parseSafetensors(VALID_BUF);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.shape).toEqual([2, 4]);
    expect(parsed[0]!.data).toHaveLength(8);
  });

  it("CRITICAL-1: throws when rows*cols would overflow Number.MAX_SAFE_INTEGER", () => {
    // Use values that multiply to > Number.MAX_SAFE_INTEGER
    // 2^27 * 2^27 = 2^54 > 2^53
    const big = 2 ** 27;
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [big, big], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      "shape overflow",
    );
  });

  // -------------------------------------------------------------------------
  // CRITICAL-2: NaN/Infinity/float rejection in meta-guard
  // -------------------------------------------------------------------------

  it("CRITICAL-2: throws when data_offsets contains Infinity (1e309 → JSON Infinity workaround)", () => {
    // JSON.parse can produce Infinity via direct construction of malicious header
    // We build the header text manually to inject Infinity-like values via a trick:
    // We use a forged header string that bypasses JSON.parse producing Infinity.
    // Since JSON spec doesn't allow Infinity, we test by constructing the meta object
    // with a number that isInteger but is absurdly large — but the real fix is
    // that non-integer floats like 0.5 are rejected.
    // For Infinity test: build header bytes directly with text containing a very large exponent
    // that JavaScript JSON.parse returns as Infinity.
    // JSON.parse("1e309") === Infinity in JS
    const headerText = '{"weights":{"dtype":"F32","shape":[2,4],"data_offsets":[1e309,1e309]}}';
    const headerBytes = new TextEncoder().encode(headerText);
    const total = 8 + headerBytes.byteLength;
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, BigInt(headerBytes.byteLength), true);
    buf.set(headerBytes, 8);
    expect(() => parseSafetensors(buf)).toThrow(
      "safetensors: tensor \"weights\" meta.data_offsets must be integers",
    );
  });

  it("CRITICAL-2: throws when shape contains a float (1.5)", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [1.5, 4], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.shape must be integers',
    );
  });

  it("CRITICAL-2: throws when data_offsets contains a float (0.5)", () => {
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [2, 4], data_offsets: [0.5, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      'safetensors: tensor "weights" meta.data_offsets must be integers',
    );
  });

  // -------------------------------------------------------------------------
  // WARNING: zero-copy path — values still correct
  // -------------------------------------------------------------------------

  it("WARNING zero-copy: aligned buffer produces correct float values", () => {
    // Standard aligned case: byteOffset of underlying buffer is 0
    const parsed = parseSafetensors(VALID_BUF);
    const entry = getTensor(parsed, "embeddings");
    expect(Array.from(entry.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("WARNING zero-copy: unaligned buffer (byteOffset % 4 !== 0) produces correct float values via fallback", () => {
    // Build a parent buffer with 1 extra byte prepended, then subarray(1) to misalign
    const headerBytes = new TextEncoder().encode(HEADER_JSON);
    const headerLen = headerBytes.byteLength;
    const payloadBytes = new Uint8Array(FLOATS.buffer);

    // parent = [padding(1)] + [u64-LE(8)] + [header(N)] + [payload(32)]
    const parent = new Uint8Array(1 + 8 + headerLen + 32);
    const dv = new DataView(parent.buffer);
    dv.setBigUint64(1, BigInt(headerLen), true); // write header len at offset 1
    parent.set(headerBytes, 1 + 8);
    parent.set(payloadBytes, 1 + 8 + headerLen);

    // subarray(1) gives byteOffset=1, which misaligns any Float32Array view
    const misaligned = parent.subarray(1);
    expect(misaligned.byteOffset).toBe(1);

    const parsed = parseSafetensors(misaligned);
    const entry = getTensor(parsed, "embeddings");
    expect(Array.from(entry.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // -------------------------------------------------------------------------
  // WARNING: overlapping tensor regions
  // -------------------------------------------------------------------------

  it("WARNING overlap: throws when two tensors share the same byte range", () => {
    // Both tensors claim [0, 32] — full overlap
    const headerJson = JSON.stringify({
      a: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
      b: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(8));
    expect(() => parseSafetensors(buf)).toThrow(
      "overlapping",
    );
  });

  it("WARNING overlap: throws when two tensors partially overlap", () => {
    // a=[0,32], b=[16,48] — partial overlap
    const payload = new Float32Array(12); // 48 bytes
    const headerJson = JSON.stringify({
      a: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
      b: { dtype: "F32", shape: [2, 4], data_offsets: [16, 48] },
    });
    const buf = buildSafetensors(headerJson, payload);
    expect(() => parseSafetensors(buf)).toThrow(
      "overlapping",
    );
  });

  it("WARNING overlap: adjacent (non-overlapping) tensors do not throw", () => {
    // a=[0,32], b=[32,64] — touching but not overlapping
    const payload = new Float32Array(16); // 64 bytes
    const headerJson = JSON.stringify({
      a: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
      b: { dtype: "F32", shape: [2, 4], data_offsets: [32, 64] },
    });
    const buf = buildSafetensors(headerJson, payload);
    expect(() => parseSafetensors(buf)).not.toThrow();
    const parsed = parseSafetensors(buf);
    expect(parsed).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // FINDING-1: LE host guard
  // -------------------------------------------------------------------------

  // Platform guard note: HOST_IS_LE is a module-level constant that throws on
  // big-endian hosts. On this (LE) host the guard never fires, so we cannot
  // unit-test the thrown branch — this is a reviewer-accepted pattern for
  // platform guards that are untestable on the current architecture.
  // What we CAN verify: parsing succeeds on this host (i.e. the guard did NOT
  // reject), and the exported HOST_IS_LE constant is true.
  it("FINDING-1: HOST_IS_LE is true on this little-endian host", async () => {
    const mod = await import("../../src/utils/safetensors-loader.js");
    expect((mod as Record<string, unknown>)["HOST_IS_LE"]).toBe(true);
  });

  it("FINDING-1: parsing succeeds on this little-endian host (guard did not fire)", () => {
    // If the LE guard incorrectly fired, parseSafetensors would throw.
    expect(() => parseSafetensors(VALID_BUF)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // FINDING-2: O(N log N) overlap check — out-of-order header entries
  // -------------------------------------------------------------------------

  it("FINDING-2: three tensors declared out-of-order in header but non-overlapping parse fine", () => {
    // Offsets: c=[64,96], a=[0,32], b=[32,64] — out of offset order in JSON
    // After sorting by start they are [0,32), [32,64), [64,96) — no overlap
    const payload = new Float32Array(24); // 96 bytes
    const headerJson = JSON.stringify({
      c: { dtype: "F32", shape: [2, 4], data_offsets: [64, 96] },
      a: { dtype: "F32", shape: [2, 4], data_offsets: [0, 32] },
      b: { dtype: "F32", shape: [2, 4], data_offsets: [32, 64] },
    });
    const buf = buildSafetensors(headerJson, payload);
    expect(() => parseSafetensors(buf)).not.toThrow();
    const parsed = parseSafetensors(buf);
    expect(parsed).toHaveLength(3);
    // Order preserved as returned (header iteration order)
    expect(parsed.map((e) => e.name)).toEqual(["c", "a", "b"]);
  });

  it("FINDING-2: zero-length spans (zero-row tensors) do not trigger false overlap", () => {
    // Two zero-row tensors both claim [0, 0) — zero-length spans must not overlap each other
    const headerJson = JSON.stringify({
      e1: { dtype: "F32", shape: [0, 4], data_offsets: [0, 0] },
      e2: { dtype: "F32", shape: [0, 4], data_offsets: [0, 0] },
    });
    const buf = buildSafetensors(headerJson, new Float32Array(0));
    expect(() => parseSafetensors(buf)).not.toThrow();
    const parsed = parseSafetensors(buf);
    expect(parsed).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // FINDING-3: isSafeInteger for data_offsets
  // -------------------------------------------------------------------------

  it("FINDING-3: throws when data_offsets contain unsafe integers (> MAX_SAFE_INTEGER)", () => {
    // Number.MAX_SAFE_INTEGER + 1 = 9007199254740992
    // These pass isInteger but fail isSafeInteger
    // Build header manually — JSON.stringify will round these to the same value
    // so we inject via headerText directly
    const unsafe = 9007199254740992; // 2^53 — exactly MAX_SAFE_INTEGER + 1
    const headerText = `{"weights":{"dtype":"F32","shape":[2,4],"data_offsets":[${unsafe},${unsafe + 4}]}}`;
    const headerBytes = new TextEncoder().encode(headerText);
    const total = 8 + headerBytes.byteLength;
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, BigInt(headerBytes.byteLength), true);
    buf.set(headerBytes, 8);
    expect(() => parseSafetensors(buf)).toThrow(
      "safetensors: tensor \"weights\" meta.data_offsets must be integers",
    );
  });
});
