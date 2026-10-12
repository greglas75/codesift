// The binary vector file (ADR-006 stage 11 E2): 5.3x smaller than the ndjson it replaces, read without
// parsing, checksummed — and the TypeScript reader must hand the loader exactly what the ndjson did.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHashesForPath, loadEmbeddings, saveEmbeddings } from "../../src/storage/embedding-store.js";
import { getNativeCore } from "../../src/native/index.js";

let dir: string;
let ndjson: string;
let vec: string;

const sample = () => new Map<string, Float32Array>([
  ["r:src/a.ts:a:1", new Float32Array([0.1, -2.5, 3.25])],
  ["r:src/ü.ts:b:2", new Float32Array([1e-30, 0, -0])],
  ["r:src/c.ts:c:3", new Float32Array([7, 8, 9])],
]);
const hashes = new Map([["r:src/a.ts:a:1", 7], ["r:src/c.ts:c:3", 0xffffffff]]);
const bits = (m: Map<string, Float32Array>) => [...m].map(([id, v]) => [id, Array.from(new Uint32Array(v.buffer, v.byteOffset, v.length))]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-vecfile-"));
  ndjson = join(dir, "h.embeddings.ndjson");
  vec = join(dir, "h.embeddings.vec");
  delete process.env["CODESIFT_VECTOR_FORMAT"];
});
afterEach(() => {
  delete process.env["CODESIFT_VECTOR_FORMAT"];
  rmSync(dir, { recursive: true, force: true });
});

describe("saveEmbeddings / loadEmbeddings over the vector file", () => {
  it("round-trips ids in order, every vector bit for bit, and the content hashes", async () => {
    writeFileSync(ndjson, "{}\n"); // the file it replaces
    await saveEmbeddings(ndjson, sample(), hashes);
    expect(existsSync(vec)).toBe(true);
    expect(existsSync(ndjson)).toBe(false);
    const back = await loadEmbeddings(ndjson);
    expect(bits(back)).toEqual(bits(sample()));
    expect([...contentHashesForPath(ndjson)]).toEqual([...hashes]);
  });

  // Bug it catches: a flipped matrix byte served as a valid but wrong vector.
  it("refuses a damaged file whole instead of serving a wrong vector", async () => {
    await saveEmbeddings(ndjson, sample(), hashes);
    const bytes = readFileSync(vec);
    bytes[bytes.length - 12] ^= 0x10;
    writeFileSync(vec, bytes);
    expect((await loadEmbeddings(ndjson)).size).toBe(0);
  });

  it("falls back to the ndjson beside a damaged .vec", async () => {
    await saveEmbeddings(ndjson, sample(), hashes);
    writeFileSync(vec, "damaged");
    writeFileSync(ndjson, JSON.stringify({ id: "r:old.ts:o:1", vec: [1, 2, 3] }) + "\n");
    expect([...(await loadEmbeddings(ndjson)).keys()]).toEqual(["r:old.ts:o:1"]);
  });

  it("loads nothing above the budget, judged from the header before reading the matrix", async () => {
    await saveEmbeddings(ndjson, sample(), hashes);
    expect((await loadEmbeddings(ndjson, 100)).size).toBe(0);
  });

  it.each([
    ["the rollback switch", { env: "ndjson", map: sample() }],
    ["vectors of mixed widths", { env: undefined, map: new Map([["a", new Float32Array(2)], ["b", new Float32Array(3)]]) }],
  ])("writes ndjson and removes a stale .vec for %s", async (_case, { env, map }) => {
    await saveEmbeddings(ndjson, sample(), hashes);
    if (env) process.env["CODESIFT_VECTOR_FORMAT"] = env;
    await saveEmbeddings(ndjson, map);
    expect(existsSync(vec)).toBe(false);
    expect((await loadEmbeddings(ndjson)).size).toBe(map.size);
  });
});

describe("a rollback save beside a .vec it cannot remove", () => {
  // Bug it catches: the ndjson was published first and the failed removal swallowed, so the old .vec
  // went on winning every read while the save reported success.
  it("fails the save and does not publish the ndjson", async () => {
    process.env["CODESIFT_VECTOR_FORMAT"] = "ndjson";
    mkdirSync(join(vec, "pinned"), { recursive: true }); // unlink of a directory fails (EISDIR / EPERM)
    await expect(saveEmbeddings(ndjson, sample())).rejects.toThrow();
    expect(existsSync(ndjson)).toBe(false);
  });
});

describe.skipIf(!getNativeCore("vectors"))("the native reader", () => {
  it("reads the TypeScript writer's file as the TypeScript reader does", async () => {
    await saveEmbeddings(ndjson, sample(), hashes);
    const native = await getNativeCore("vectors")!.loadVectors(vec, null, null);
    expect(native.count).toBe(3);
    await native.attachFilesAsync([...sample().keys()].join("\0"), ["src/a.ts", "src/ü.ts", "src/c.ts"].join("\0"));
    const hits = await native.searchAsync(new Float32Array([7, 8, 9]), 1, null, false);
    expect(hits[0]!.id).toBe("r:src/c.ts:c:3");
    native.release();
  });
});
