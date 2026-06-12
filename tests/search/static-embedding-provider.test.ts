import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseVocab, tokenize } from "../../src/search/model2vec-tokenize.js";

// ---------------------------------------------------------------------------
// Mock the HF hub downloader BEFORE importing the provider so vi.mock hoists.
// Every test points the mock at real on-disk fixture files in a tmpdir, so
// the provider exercises its real parse/tokenize/pool path with ZERO network.
// ---------------------------------------------------------------------------
vi.mock("../../src/utils/hf-hub-download.js", () => ({
  ensureModelFile: vi.fn(),
}));

import {
  StaticEmbeddingProvider,
  _resetStaticProviderForTesting,
  STATIC_FAILURE_COOLDOWN_MS,
  _failedStaticModels,
} from "../../src/search/static-embedding-provider.js";
import { ensureModelFile } from "../../src/utils/hf-hub-download.js";

const mockEnsureModelFile = vi.mocked(ensureModelFile);

const MODEL = "minishlab/potion-code-16M";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// Mirrors Task 1's safetensors test helper:
// [u64-LE header length] [JSON header bytes] [F32 payload bytes]
function buildSafetensors(headerJson: string, payload: Float32Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(headerJson);
  const buf = new Uint8Array(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(headerBytes.byteLength), true);
  buf.set(headerBytes, 8);
  buf.set(new Uint8Array(payload.buffer), 8 + headerBytes.byteLength);
  return buf;
}

// 3 rows × 4 cols. Row0 = hello, Row1 = world, Row2 = padding/[UNK].
// row0 = [1,0,0,0]  row1 = [0,2,0,0]  row2 = [0,0,0,0]
const FIXTURE_FLOATS = new Float32Array([
  1, 0, 0, 0, // row 0 — hello
  0, 2, 0, 0, // row 1 — world
  0, 0, 0, 0, // row 2 — [UNK]
]);

function fixtureSafetensorsBytes(): Uint8Array {
  const headerJson = JSON.stringify({
    embeddings: { dtype: "F32", shape: [3, 4], data_offsets: [0, 48] },
  });
  return buildSafetensors(headerJson, FIXTURE_FLOATS);
}

// Nested WordPiece-style tokenizer.json with a known vocab.
function fixtureTokenizerJson(): string {
  return JSON.stringify({
    model: {
      vocab: {
        "[UNK]": 2,
        hello: 0,
        world: 1,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Test harness — write fixtures to a tmpdir, point the mock at them.
// ---------------------------------------------------------------------------

let dir: string;
let safetensorsPath: string;
let tokenizerPath: string;

async function writeFixtures(tokenizerJson = fixtureTokenizerJson()): Promise<void> {
  safetensorsPath = join(dir, "model.safetensors");
  tokenizerPath = join(dir, "tokenizer.json");
  await writeFile(safetensorsPath, fixtureSafetensorsBytes());
  await writeFile(tokenizerPath, tokenizerJson);
}

// Default mock: resolve each filename to the matching fixture on disk.
function wireMockToFixtures(): void {
  mockEnsureModelFile.mockImplementation(async (_model, filename) => {
    if (filename === "model.safetensors") return safetensorsPath;
    if (filename === "tokenizer.json") return tokenizerPath;
    throw new Error(`unexpected filename ${filename}`);
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model2vec-mini-"));
  await writeFixtures();
  mockEnsureModelFile.mockReset();
  wireMockToFixtures();
  _resetStaticProviderForTesting();
});

afterEach(async () => {
  _resetStaticProviderForTesting();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Constructor + dimensions reconciliation
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — constructor & dimensions", () => {
  it("reports KNOWN_LOCAL_DIMS (256) before load, real matrix cols (4) after first embed", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    // Before any load: dimensions come from KNOWN_LOCAL_DIMS lookup.
    expect(provider.dimensions).toBe(256);
    expect(provider.model).toBe(MODEL);

    const out = await provider.embed(["hello"]);
    // After load: dimensions reflect the real loaded matrix (fixture cols = 4),
    // and the embed result length follows the matrix cols too.
    expect(out[0]).toHaveLength(4);
    expect(provider.dimensions).toBe(4);
  });

  it("throws on empty / blank model id", () => {
    expect(() => new StaticEmbeddingProvider("")).toThrow(/model/i);
    expect(() => new StaticEmbeddingProvider("   ")).toThrow(/model/i);
  });
});

// ---------------------------------------------------------------------------
// 2. embed — mean-pool + L2 normalize against HAND-COMPUTED values
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — embed math", () => {
  it("embed(['hello world']) = L2-normalized mean of rows 0 and 1", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["hello world"]);

    // HAND COMPUTED:
    //   row0(hello) = [1,0,0,0]   row1(world) = [0,2,0,0]
    //   mean        = [0.5, 1.0, 0, 0]
    //   ||mean||    = sqrt(0.25 + 1.0) = sqrt(1.25) = 1.1180339887...
    //   normalized  = [0.5/1.118034, 1.0/1.118034, 0, 0]
    //               = [0.4472135955, 0.8944271910, 0, 0]
    expect(vec).toHaveLength(4);
    expect(vec![0]).toBeCloseTo(0.4472135955, 6);
    expect(vec![1]).toBeCloseTo(0.8944271910, 6);
    expect(vec![2]).toBeCloseTo(0, 6);
    expect(vec![3]).toBeCloseTo(0, 6);

    // Sanity: unit length.
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Edge cases: empty string, unicode, OOV-only — zero vector, no NaN
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — edge cases", () => {
  it("embed(['']) → zero vector of matrix-col length, no NaN", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed([""]);
    expect(vec).toHaveLength(4);
    expect(vec!.every((x) => x === 0)).toBe(true);
    expect(vec!.some((x) => Number.isNaN(x))).toBe(false);
  });

  it("OOV-only input ('zzz') → zero vector, no NaN, no throw", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["zzz"]);
    expect(vec).toHaveLength(4);
    expect(vec!.every((x) => x === 0)).toBe(true);
    expect(vec!.some((x) => Number.isNaN(x))).toBe(false);
  });

  it("unicode input does not throw and yields no NaN", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["héllo 世界 🌍 hello"]);
    expect(vec).toHaveLength(4);
    expect(vec!.some((x) => Number.isNaN(x))).toBe(false);
    // "hello" still matches row0 → vector is non-zero & unit length.
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("empty texts array returns []", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    expect(await provider.embed([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1b. Flat vocab shape (no model wrapper): {"vocab":{"hello":0,"world":1}}
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — flat vocab tokenizer shape", () => {
  it("flat tokenizer.json shape produces same math as nested shape", async () => {
    const flatTokenizer = JSON.stringify({ vocab: { hello: 0, world: 1 } });
    await writeFixtures(flatTokenizer);
    wireMockToFixtures();

    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["hello world"]);

    // Same computation as the nested fixture — rows 0 & 1, same matrix.
    expect(vec).toHaveLength(4);
    expect(vec![0]).toBeCloseTo(0.4472135955, 6);
    expect(vec![1]).toBeCloseTo(0.8944271910, 6);
    expect(vec![2]).toBeCloseTo(0, 6);
    expect(vec![3]).toBeCloseTo(0, 6);
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// 2b. parseVocab error paths via provider.embed with bad tokenizer fixtures
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — parseVocab error paths", () => {
  it("tokenizer.json = {} → rejects with 'missing a usable vocab map'", async () => {
    await writeFixtures(JSON.stringify({}));
    wireMockToFixtures();
    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(
      /missing.*usable vocab|missing a usable vocab/i,
    );
  });

  it("tokenizer.json = {\"vocab\":[]} → rejects with 'missing a usable vocab map'", async () => {
    await writeFixtures(JSON.stringify({ vocab: [] }));
    wireMockToFixtures();
    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(
      /missing.*usable vocab|missing a usable vocab/i,
    );
  });

  it("tokenizer.json = {\"vocab\":{\"hello\":\"bad\"}} → rejects with 'vocab map is empty'", async () => {
    await writeFixtures(JSON.stringify({ vocab: { hello: "bad" } }));
    wireMockToFixtures();
    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(/vocab map is empty/i);
  });
});

// ---------------------------------------------------------------------------
// 4b. Row-index OOB skip: id >= rows is silently dropped
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — OOB row-index skip", () => {
  it("token with id === rows (out-of-bounds) is silently dropped; pooling uses only in-bounds rows", async () => {
    // Tokenizer maps "hello"→0 (in-bounds) and "oob"→3 (rows=3, so id 3 is OOB).
    const oobTokenizer = JSON.stringify({ vocab: { hello: 0, oob: 3 } });
    await writeFixtures(oobTokenizer);
    wireMockToFixtures();

    const provider = new StaticEmbeddingProvider(MODEL);
    // "hello oob": "oob" is dropped; only row0 [1,0,0,0] contributes.
    // mean = [1,0,0,0], norm = 1 → normalized = [1,0,0,0]
    const [vec] = await provider.embed(["hello oob"]);
    expect(vec).toHaveLength(4);
    expect(vec![0]).toBeCloseTo(1, 6);
    expect(vec![1]).toBeCloseTo(0, 6);
    expect(vec![2]).toBeCloseTo(0, 6);
    expect(vec![3]).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// 5b. Safetensors fallback: tensor named "weights" (not "embeddings") → succeeds
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — safetensors fallback tensor name", () => {
  it("tensor named 'weights' (not 'embeddings') is used as fallback → embed succeeds", async () => {
    // Build a safetensors file where the tensor key is "weights", not "embeddings".
    const headerJson = JSON.stringify({
      weights: { dtype: "F32", shape: [3, 4], data_offsets: [0, 48] },
    });
    const safetensorsBytes = buildSafetensors(headerJson, FIXTURE_FLOATS);
    safetensorsPath = join(dir, "model.safetensors");
    tokenizerPath = join(dir, "tokenizer.json");
    await writeFile(safetensorsPath, safetensorsBytes);
    await writeFile(tokenizerPath, fixtureTokenizerJson());
    wireMockToFixtures();

    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["hello world"]);
    // Same math — same underlying matrix.
    expect(vec).toHaveLength(4);
    expect(vec![0]).toBeCloseTo(0.4472135955, 6);
    expect(vec![1]).toBeCloseTo(0.8944271910, 6);
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// 5. Missing tokenizer file → descriptive error
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — load failures", () => {
  it("descriptive error when tokenizer.json download fails", async () => {
    mockEnsureModelFile.mockImplementation(async (_model, filename) => {
      if (filename === "model.safetensors") return safetensorsPath;
      throw new Error("404 tokenizer.json not found");
    });
    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(/tokenizer|static-embedding/i);
  });

  it("descriptive error when tokenizer.json is malformed JSON", async () => {
    await writeFile(tokenizerPath, "{not valid json");
    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(/tokenizer|static-embedding/i);
  });
});

// ---------------------------------------------------------------------------
// 6. mode parameter accepted and ignored
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — mode is ignored", () => {
  it("query mode === document mode (Model2Vec needs no prefixes)", async () => {
    const provider = new StaticEmbeddingProvider(MODEL);
    const asQuery = await provider.embed(["hello world"], "query");
    const asDoc = await provider.embed(["hello world"], "document");
    expect(asQuery).toEqual(asDoc);
  });
});

// ---------------------------------------------------------------------------
// 7. Module cache: same model does not re-call ensureModelFile; reset re-calls
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — module cache", () => {
  it("second provider for same model reuses cache (no extra ensureModelFile calls)", async () => {
    const p1 = new StaticEmbeddingProvider(MODEL);
    await p1.embed(["hello"]);
    const callsAfterFirst = mockEnsureModelFile.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // loaded both files at least once

    // Verify the mock was called with the correct model + filenames on first load.
    expect(mockEnsureModelFile).toHaveBeenCalledWith(MODEL, "model.safetensors", expect.any(String));
    expect(mockEnsureModelFile).toHaveBeenCalledWith(MODEL, "tokenizer.json", expect.any(String));

    const p2 = new StaticEmbeddingProvider(MODEL);
    await p2.embed(["world"]);
    // Cache hit → no additional downloads.
    expect(mockEnsureModelFile.mock.calls.length).toBe(callsAfterFirst);
  });

  it("_resetStaticProviderForTesting clears cache → re-calls ensureModelFile", async () => {
    const p1 = new StaticEmbeddingProvider(MODEL);
    await p1.embed(["hello"]);
    const callsAfterFirst = mockEnsureModelFile.mock.calls.length;

    _resetStaticProviderForTesting();

    const p2 = new StaticEmbeddingProvider(MODEL);
    await p2.embed(["world"]);
    expect(mockEnsureModelFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 8. failedModels guard: retry after failure throws fast without re-downloading
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — failed-model fast-fail guard", () => {
  it("immediate retry after a load failure throws without calling ensureModelFile again", async () => {
    mockEnsureModelFile.mockImplementation(async (_model, filename) => {
      if (filename === "model.safetensors") return safetensorsPath;
      throw new Error("boom: tokenizer fetch failed");
    });

    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(/static-embedding/i);
    const callsAfterFailure = mockEnsureModelFile.mock.calls.length;

    // Retry: should fast-fail via failedStaticModels guard, NOT re-download.
    await expect(provider.embed(["hello"])).rejects.toThrow(/previously failed to load/i);
    expect(mockEnsureModelFile.mock.calls.length).toBe(callsAfterFailure);
  });

  it("reset clears the failed-model guard so a fixed model can load", async () => {
    // First: make it fail.
    mockEnsureModelFile.mockImplementationOnce(async () => {
      throw new Error("transient failure");
    });
    const p1 = new StaticEmbeddingProvider(MODEL);
    await expect(p1.embed(["hello"])).rejects.toThrow();

    // Reset clears failedStaticModels; rewire mock to succeed.
    _resetStaticProviderForTesting();
    wireMockToFixtures();

    const p2 = new StaticEmbeddingProvider(MODEL);
    const [vec] = await p2.embed(["hello"]);
    expect(vec).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 9. Subword (max-munch) tokenization — the adversarial CRITICALs.
//
// Real Model2Vec / potion vocabs are SUBWORD vocabs. Naive whole-word lookup =
// catastrophic OOV. tokenize() must do greedy longest-match subword splitting,
// honor the WordPiece "##" continuation convention, split code identifiers
// (camelCase / snake_case / kebab-case), and keep punctuation as candidate
// tokens (matched when in vocab, not silently deleted).
//
// These tests exercise tokenize() DIRECTLY (returns matched row indices) — the
// piece selection is the unit under test, independent of the matrix math.
// ---------------------------------------------------------------------------

describe("model2vec tokenize — subword max-munch", () => {
  // Subword fixture: "fo" + WordPiece-continuation "##od" reconstruct "food".
  // rows arg is large so no id<rows drops interfere with piece-selection asserts.
  const SUBWORD_VOCAB = parseVocab({ vocab: { fo: 0, "##od": 1, bar: 2 } });

  it("'food' → greedy [fo, ##od] via WordPiece continuation (ids 0,1)", () => {
    // No whole-word "food" in vocab. Max-munch from pos 0:
    //   longest initial match = "fo" (id 0).
    //   remaining "od" at non-initial pos → try "##od" → match (id 1).
    // Result: [0, 1].
    expect(tokenize("food", SUBWORD_VOCAB, 3)).toEqual([0, 1]);
  });

  it("'bar' → whole-word fast path (id 2), not subword-split", () => {
    expect(tokenize("bar", SUBWORD_VOCAB, 3)).toEqual([2]);
  });

  it("'foodbar' → [fo, ##od, ...] then 'bar' continuation has no '##bar' → skip-char recovery", () => {
    // pos0 "fo"(0). pos2 non-initial "##od"(1). pos4 non-initial: "##bar"?
    // not in vocab, "##ba"? no, "##b"? no → skip one char, advance.
    // Eventually no further matches. Matched pieces so far: [0, 1].
    // (Demonstrates skip-one-char recovery does not abandon already-matched pieces.)
    expect(tokenize("foodbar", SUBWORD_VOCAB, 3)).toEqual([0, 1]);
  });

  it("fully-unmatched word contributes nothing (OOV semantics preserved)", () => {
    expect(tokenize("xyz", SUBWORD_VOCAB, 3)).toEqual([]);
  });

  it("camelCase 'fooBar' splits on case boundary → matches both pieces", () => {
    // Code-aware pre-split: fooBar → ["foo","bar"]. With foo/bar whole-words.
    const camelVocab = parseVocab({ vocab: { foo: 0, bar: 2 } });
    expect(tokenize("fooBar", camelVocab, 3)).toEqual([0, 2]);
  });

  it("snake_case 'foo_bar' and kebab 'foo-bar' split into foo + bar", () => {
    const v = parseVocab({ vocab: { foo: 0, bar: 2 } });
    expect(tokenize("foo_bar", v, 3)).toEqual([0, 2]);
    expect(tokenize("foo-bar", v, 3)).toEqual([0, 2]);
  });

  it("punctuation in vocab is matched as its own piece, not deleted", () => {
    // 'foo.bar' with '.' in vocab → 3 pieces foo, '.', bar (ids 0,1,2).
    const punctVocab = parseVocab({ vocab: { foo: 0, ".": 1, bar: 2 } });
    expect(tokenize("foo.bar", punctVocab, 3)).toEqual([0, 1, 2]);
  });

  it("punctuation NOT in vocab is dropped as OOV (no crash)", () => {
    const v = parseVocab({ vocab: { foo: 0, bar: 2 } });
    // '.' not in vocab → dropped; foo & bar still split out and matched.
    expect(tokenize("foo.bar", v, 3)).toEqual([0, 2]);
  });

  it("whole-word fast path still wins over subword decomposition", () => {
    // "fo" AND whole "food" both present → whole word preferred (single piece).
    const v = parseVocab({ vocab: { fo: 0, "##od": 1, food: 3 } });
    expect(tokenize("food", v, 4)).toEqual([3]);
  });

  it("whole-word id OOB falls through to greedy subword munch (not silently dropped)", () => {
    // vocab: food→5 (OOB, rows=3), fo→0, ##od→1.
    // Whole-word fast path finds food→5 but 5 >= rows → must NOT return [].
    // Must fall through to munch: fo(0) + ##od(1) → [0, 1].
    // Embed result: same as 'hello world' math → [0.4472135955, 0.8944271910, 0, 0]
    const v = parseVocab({ vocab: { food: 5, fo: 0, "##od": 1 } });
    expect(tokenize("food", v, 3)).toEqual([0, 1]);
  });

  it("id<rows guard still drops out-of-bounds subword pieces", () => {
    // "##od" id 1 is in-bounds only if rows>1. With rows=1, only id 0 survives.
    expect(tokenize("food", SUBWORD_VOCAB, 1)).toEqual([0]);
  });

  it("FIX-1: NFD café (e + U+0301) matches NFC vocab entry 'café'", () => {
    // NFC "café" is a single code point (é). NFD form uses e + U+0301 (combining acute).
    // tokenize() must normalize to NFC before splitting so the NFD input finds the vocab entry.
    const nfcCafe = "café"; // NFC: é as single code point
    const nfdCafe = "café"; // NFD: e + combining acute accent
    const v = parseVocab({ vocab: { [nfcCafe]: 0, world: 1 } });
    // Both NFC and NFD forms of café must map to id 0.
    expect(tokenize(nfcCafe, v, 2)).toEqual([0]);
    expect(tokenize(nfdCafe, v, 2)).toEqual([0]);
  });

  it("FIX-2: '-' in vocab is emitted as a candidate token → tokenize('a-b') returns [0,1,2]", () => {
    // kebab splitting must still happen (a and b are separate words) but the '-'
    // separator itself should also be emitted as a candidate and matched when in vocab.
    const v = parseVocab({ vocab: { a: 0, "-": 1, b: 2 } });
    expect(tokenize("a-b", v, 3)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 9b. Subword end-to-end through the provider — hand-computed pooled vector.
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — subword pooling end-to-end", () => {
  it("'food' pools rows 0 (fo) & 1 (##od) → L2-normalized mean", async () => {
    // Matrix rows: row0=[1,0,0,0], row1=[0,2,0,0]. tokenize('food')=[0,1].
    //   mean = [0.5, 1.0, 0, 0]
    //   ||mean|| = sqrt(0.25+1.0) = sqrt(1.25) = 1.1180339887
    //   normalized = [0.4472135955, 0.8944271910, 0, 0]
    const subwordTokenizer = JSON.stringify({ vocab: { fo: 0, "##od": 1 } });
    await writeFixtures(subwordTokenizer);
    wireMockToFixtures();

    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["food"]);
    expect(vec).toHaveLength(4);
    expect(vec![0]).toBeCloseTo(0.4472135955, 6);
    expect(vec![1]).toBeCloseTo(0.8944271910, 6);
    expect(vec![2]).toBeCloseTo(0, 6);
    expect(vec![3]).toBeCloseTo(0, 6);
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// 9c. Whole-word OOB falls through to subword munch (end-to-end through provider)
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — whole-word OOB falls through to subword munch", () => {
  it("'food' with food→OOB pools rows 0 (fo) & 1 (##od) → L2-normalized mean", async () => {
    // vocab: food→5 (OOB, matrix rows=3), fo→0, ##od→1.
    // Whole-word fast path must NOT return [] — must fall through to munch.
    // tokenize('food') → [0, 1]. Matrix: row0=[1,0,0,0], row1=[0,2,0,0].
    //   mean = [0.5, 1.0, 0, 0], ||mean|| = sqrt(1.25)
    //   normalized = [0.4472135955, 0.8944271910, 0, 0]
    const oobWholeWordTokenizer = JSON.stringify({ vocab: { food: 5, fo: 0, "##od": 1 } });
    await writeFixtures(oobWholeWordTokenizer);
    wireMockToFixtures();

    const provider = new StaticEmbeddingProvider(MODEL);
    const [vec] = await provider.embed(["food"]);
    expect(vec).toHaveLength(4);
    expect(vec![0]).toBeCloseTo(0.4472135955, 6);
    expect(vec![1]).toBeCloseTo(0.8944271910, 6);
    expect(vec![2]).toBeCloseTo(0, 6);
    expect(vec![3]).toBeCloseTo(0, 6);
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL-1: Cache stampede — concurrent first embeds must share ONE load
// promise, not trigger parallel duplicate downloads.
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — concurrent load (no stampede)", () => {
  it("two concurrent embed() calls on a fresh provider call ensureModelFile exactly twice total (model+tokenizer once each)", async () => {
    // Both providers race simultaneously — neither has a cached model yet.
    const p1 = new StaticEmbeddingProvider(MODEL);
    const p2 = new StaticEmbeddingProvider(MODEL);

    // Launch both embeds concurrently without awaiting either.
    const [res1, res2] = await Promise.all([p1.embed(["hello"]), p2.embed(["world"])]);

    // ensureModelFile must have been called exactly twice:
    // once for "model.safetensors" and once for "tokenizer.json".
    // If stampede is unfixed, it would be called 4 times (once per file per provider).
    expect(mockEnsureModelFile.mock.calls.length).toBe(2);
    expect(mockEnsureModelFile).toHaveBeenCalledWith(MODEL, "model.safetensors", expect.any(String));
    expect(mockEnsureModelFile).toHaveBeenCalledWith(MODEL, "tokenizer.json", expect.any(String));

    // Both embeds return correct identical vectors for their respective inputs.
    expect(res1[0]).toHaveLength(4);
    expect(res2[0]).toHaveLength(4);
    // hello → row 0 [1,0,0,0] → normalized [1,0,0,0]
    expect(res1[0]![0]).toBeCloseTo(1, 6);
    expect(res1[0]![1]).toBeCloseTo(0, 6);
    // world → row 1 [0,2,0,0] → normalized [0,1,0,0]
    expect(res2[0]![0]).toBeCloseTo(0, 6);
    expect(res2[0]![1]).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL-2: Cooldown-based retry — transient failure must not permanently
// brick the model. After STATIC_FAILURE_COOLDOWN_MS, a retry is allowed.
// ---------------------------------------------------------------------------

describe("StaticEmbeddingProvider — failure cooldown (no permanent brick)", () => {
  it("failure within cooldown fast-fails WITHOUT new ensureModelFile calls", async () => {
    mockEnsureModelFile.mockImplementation(async (_model, filename) => {
      if (filename === "model.safetensors") return safetensorsPath;
      throw new Error("boom: tokenizer fetch failed");
    });

    const provider = new StaticEmbeddingProvider(MODEL);
    await expect(provider.embed(["hello"])).rejects.toThrow(/static-embedding/i);
    const callsAfterFailure = mockEnsureModelFile.mock.calls.length;

    // Immediate retry: should fast-fail via cooldown guard, NOT re-download.
    await expect(provider.embed(["hello"])).rejects.toThrow(/previously failed to load/i);
    expect(mockEnsureModelFile.mock.calls.length).toBe(callsAfterFailure);
  });

  it("after cooldown expires, retry is allowed and can succeed", async () => {
    vi.useFakeTimers();
    try {
      // Trigger a failure.
      mockEnsureModelFile.mockImplementation(async (_model, filename) => {
        if (filename === "model.safetensors") return safetensorsPath;
        throw new Error("transient network failure");
      });

      const p1 = new StaticEmbeddingProvider(MODEL);
      await expect(p1.embed(["hello"])).rejects.toThrow(/static-embedding/i);
      const callsAfterFailure = mockEnsureModelFile.mock.calls.length;

      // Advance time past the cooldown.
      vi.setSystemTime(Date.now() + STATIC_FAILURE_COOLDOWN_MS + 1000);

      // Re-wire mock to succeed.
      wireMockToFixtures();

      // Now a new provider can load successfully.
      const p2 = new StaticEmbeddingProvider(MODEL);
      const [vec] = await p2.embed(["hello"]);
      expect(vec).toHaveLength(4);

      // ensureModelFile was called again after cooldown (retry happened).
      expect(mockEnsureModelFile.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    } finally {
      vi.useRealTimers();
    }
  });
});
