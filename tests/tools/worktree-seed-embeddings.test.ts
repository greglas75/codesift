// A seeded worktree gets its donor's vectors by CLONE, with ids rebased at load time.
//
// Measured 2026-10-09: 254 indexes of one ~450k-symbol repo, none with a usable vector file, and
// 1,021 failed embedding runs — every worktree either had no vectors (seeded) or re-embedded the whole
// repo (full index). A vector line is ~16 KB, so copying would cost ~7 GB per worktree; the clone costs
// nothing, and where the filesystem cannot clone the seed must decline rather than copy.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEmbeddings, contentHashesForPath } from "../../src/storage/embedding-store.js";
import { seedEmbeddingsFromDonor } from "../../src/tools/index-tools/worktree-seed-embeddings.js";

let dir: string;
const DONOR = "local/repo";
const TARGET = "local/repo@wt";
const donorIndex = () => join(dir, "donor.index.json");
const targetIndex = () => join(dir, "target.index.json");
const vectorsOf = (indexPath: string) => indexPath.replace(/\.index\.json$/, ".embeddings.ndjson");
const metaOf = (indexPath: string) => indexPath.replace(/\.index\.json$/, ".embeddings.meta.json");

function writeDonor(lines: Array<{ id: string; vec: number[]; h?: number }>, extraMeta: object = {}): void {
  writeFileSync(vectorsOf(donorIndex()), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(metaOf(donorIndex()), JSON.stringify({
    model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: lines.length, updated_at: 1, ...extraMeta,
  }));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-seed-vec-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadEmbeddings with id_rebase", () => {
  it("rewrites the recorded prefix and keeps each vector's content hash under the new id", async () => {
    // A path that CONTAINS the donor's name must not be rewritten mid-id: only the prefix moves.
    writeFileSync(vectorsOf(targetIndex()), [
      JSON.stringify({ id: `${DONOR}:src/a.ts:a:1`, vec: [1, 0], h: 7 }),
      JSON.stringify({ id: `${DONOR}:src/${DONOR}-x.ts:b:2`, vec: [0, 1], h: 8 }),
    ].join("\n") + "\n");
    writeFileSync(metaOf(targetIndex()), JSON.stringify({
      model: "m", provider: "ollama", dimensions: 2, symbol_count: 2, updated_at: 1,
      id_rebase: { from: `${DONOR}:`, to: `${TARGET}:` },
    }));

    const loaded = await loadEmbeddings(vectorsOf(targetIndex()));

    expect([...loaded.keys()].sort()).toEqual([`${TARGET}:src/a.ts:a:1`, `${TARGET}:src/${DONOR}-x.ts:b:2`]);
    // The hash is what stops the next embedding run from re-embedding the clone; it must follow the id.
    expect(contentHashesForPath(vectorsOf(targetIndex())).get(`${TARGET}:src/a.ts:a:1`)).toBe(7);
  });

  it("leaves ids alone when the file was written by an embedding run", async () => {
    // After a real run the file holds the target's own ids while a stale meta may still say rebase —
    // the rewrite must then match nothing, not double-prefix.
    writeFileSync(vectorsOf(targetIndex()), JSON.stringify({ id: `${TARGET}:src/a.ts:a:1`, vec: [1, 0] }) + "\n");
    writeFileSync(metaOf(targetIndex()), JSON.stringify({
      model: "m", provider: "ollama", dimensions: 2, symbol_count: 1, updated_at: 1,
      id_rebase: { from: `${DONOR}:`, to: `${TARGET}:` },
    }));

    const loaded = await loadEmbeddings(vectorsOf(targetIndex()));

    expect([...loaded.keys()]).toEqual([`${TARGET}:src/a.ts:a:1`]);
  });
});

describe("seedEmbeddingsFromDonor", () => {
  it("clones the vectors under this repo's ids, or declines without copying", async () => {
    writeDonor([{ id: `${DONOR}:src/a.ts:a:1`, vec: [1, 0], h: 7 }]);

    const result = await seedEmbeddingsFromDonor(donorIndex(), DONOR, targetIndex(), TARGET);

    if (result.seeded) {
      expect(result.vectors).toBe(1);
      const loaded = await loadEmbeddings(vectorsOf(targetIndex()));
      expect([...loaded.keys()]).toEqual([`${TARGET}:src/a.ts:a:1`]);
    } else {
      // A filesystem without copy-on-write (ext4 on the farm): declining is the contract — a byte
      // copy is the 7 GB write this exists to avoid.
      expect(result.reason).toMatch(/cannot clone/);
      expect(existsSync(vectorsOf(targetIndex()))).toBe(false);
    }
    expect(readFileSync(vectorsOf(donorIndex()), "utf-8")).toContain(`${DONOR}:src/a.ts`);
  });

  it("rebases a chain of seeds from the ids actually in the bytes", async () => {
    // The donor is itself a clone of `local/repo`, so its file still carries `local/repo:` ids.
    writeDonor([{ id: `${DONOR}:src/a.ts:a:1`, vec: [1, 0] }], {
      id_rebase: { from: `${DONOR}:`, to: "local/repo@first:" },
    });

    const result = await seedEmbeddingsFromDonor(donorIndex(), "local/repo@first", targetIndex(), TARGET);
    if (!result.seeded) return; // no copy-on-write here; covered by the case above

    const meta = JSON.parse(readFileSync(metaOf(targetIndex()), "utf-8"));
    expect(meta.id_rebase).toEqual({ from: `${DONOR}:`, to: `${TARGET}:` });
    expect([...(await loadEmbeddings(vectorsOf(targetIndex()))).keys()]).toEqual([`${TARGET}:src/a.ts:a:1`]);
  });

  // Bug: the donor's meta was written before the vector rename and left behind when the rename
  // failed, pairing the donor's count and id rebase with the target's old vectors. Only a
  // copy-on-write filesystem reaches the rename; elsewhere the clone declines first.
  it("keeps the target's meta when the vectors cannot be put in place", async () => {
    writeDonor([{ id: `${DONOR}:src/a.ts:a:1`, vec: [1, 0] }]);
    const previous = { model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: 5, updated_at: 1 };
    writeFileSync(metaOf(targetIndex()), JSON.stringify(previous));
    // A non-empty directory where the vector file goes: the rename over it fails.
    mkdirSync(vectorsOf(targetIndex()));
    writeFileSync(join(vectorsOf(targetIndex()), "occupied"), "");

    const result = await seedEmbeddingsFromDonor(donorIndex(), DONOR, targetIndex(), TARGET);

    expect(result.seeded).toBe(false);
    expect(JSON.parse(readFileSync(metaOf(targetIndex()), "utf-8"))).toEqual(previous);
  });

  it("declines a donor with no vectors", async () => {
    const result = await seedEmbeddingsFromDonor(donorIndex(), DONOR, targetIndex(), TARGET);
    expect(result).toEqual({ seeded: false, reason: "donor has no vectors" });
    expect(existsSync(metaOf(targetIndex()))).toBe(false);
  });
});
