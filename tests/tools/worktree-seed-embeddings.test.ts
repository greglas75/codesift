// A seeded worktree gets its donor's vectors by CLONE, with ids rebased at load time.
//
// Measured 2026-10-09: 254 indexes of one ~450k-symbol repo, none with a usable vector file, and
// 1,021 failed embedding runs — every worktree either had no vectors (seeded) or re-embedded the whole
// repo (full index). A vector line is ~16 KB, so copying would cost ~7 GB per worktree; the clone costs
// nothing, and where the filesystem cannot clone the seed must decline rather than copy.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEmbeddings, contentHashesForPath, saveEmbeddings } from "../../src/storage/embedding-store.js";
import { cloneChunksFromNearestDonor, cloneVectorsFromNearestDonor, seedEmbeddingsFromDonor } from "../../src/tools/index-tools/worktree-seed-embeddings.js";
import { loadChunkManifest, loadChunkVectorsForReuse, saveChunkEmbeddings } from "../../src/storage/chunk-store.js";
import { isVectorFile } from "../../src/storage/vector-file.js";

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

  // Bug it catches: a donor with a .vec cloned as ndjson (or not at all), or a stale file of the
  // other kind left at the target and read instead of the clone (a .vec wins every read).
  it("clones a .vec donor as a .vec and removes the target's ndjson", async () => {
    await saveEmbeddings(vectorsOf(donorIndex()), new Map([[`${DONOR}:src/a.ts:a:1`, new Float32Array([1, 0])]]), new Map([[`${DONOR}:src/a.ts:a:1`, 7]]));
    writeFileSync(metaOf(donorIndex()), JSON.stringify({ model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: 1, updated_at: 1 }));
    const targetVec = vectorsOf(targetIndex()).replace(/\.ndjson$/, ".vec");
    writeFileSync(vectorsOf(targetIndex()), JSON.stringify({ id: `${TARGET}:stale:x:1`, vec: [0, 1] }) + "\n");

    const result = await seedEmbeddingsFromDonor(donorIndex(), DONOR, targetIndex(), TARGET);

    if (!result.seeded) {
      expect(result.reason).toMatch(/cannot clone/);
      expect(existsSync(targetVec)).toBe(false);
      return;
    }
    expect(existsSync(targetVec)).toBe(true);
    expect(existsSync(vectorsOf(targetIndex()))).toBe(false);
    expect([...(await loadEmbeddings(vectorsOf(targetIndex()))).keys()]).toEqual([`${TARGET}:src/a.ts:a:1`]);
    expect(contentHashesForPath(vectorsOf(targetIndex())).get(`${TARGET}:src/a.ts:a:1`)).toBe(7);
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

// A full index of a worktree used to embed the whole repo even with a sibling at the same commit
// holding complete vectors. Measured 2026-10-11: two rdesigner worktrees at one develop commit
// embedding the same 463k symbols side by side.
describe("cloneVectorsFromNearestDonor", () => {
  let repo: string;
  let prevDataDir: string | undefined;
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: repo, encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();

  beforeEach(async () => {
    repo = join(dir, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "one"]);
    prevDataDir = process.env["CODESIFT_DATA_DIR"];
    process.env["CODESIFT_DATA_DIR"] = dir;
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
  });
  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
    else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
    const { resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
  });

  function register(commit: string): void {
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      updated_at: 1,
      repos: { [DONOR]: { name: DONOR, root: join(dir, "elsewhere"), index_path: donorIndex(), last_git_commit: commit } },
    }));
  }

  it("clones the vectors of a checkout found in this tree's history", async () => {
    writeDonor([{ id: `${DONOR}:a.ts:a:1`, vec: [1, 0], h: 7 }]);
    register(git(["rev-parse", "HEAD"]));

    const result = await cloneVectorsFromNearestDonor(repo, TARGET, targetIndex());

    if (!result.seeded) {
      expect(result.reason).toMatch(/cannot clone/); // a filesystem without copy-on-write
      return;
    }
    expect(result).toMatchObject({ donor: DONOR, distance: 0, vectors: 1 });
    expect([...(await loadEmbeddings(vectorsOf(targetIndex()))).keys()]).toEqual([`${TARGET}:a.ts:a:1`]);
  });

  it("leaves a repo that has vectors of its own alone", async () => {
    writeDonor([{ id: `${DONOR}:a.ts:a:1`, vec: [1, 0] }]);
    register(git(["rev-parse", "HEAD"]));
    writeFileSync(vectorsOf(targetIndex()), JSON.stringify({ id: `${TARGET}:a.ts:a:1`, vec: [0, 1] }) + "\n");
    writeFileSync(metaOf(targetIndex()), JSON.stringify({
      model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: 1, updated_at: 1,
    }));

    const result = await cloneVectorsFromNearestDonor(repo, TARGET, targetIndex());

    expect(result).toEqual({ seeded: false, reason: "has vectors of its own" });
    expect(readFileSync(vectorsOf(targetIndex()), "utf-8")).toContain(`${TARGET}:a.ts`);
  });

  // Bug: a 0-byte vector file left by a failed run counted as "has vectors", so a worktree embedded
  // all 463k symbols from scratch beside a sibling holding every one of them.
  it("clones over an empty vector file left by a failed run, keeping the checkpoint", async () => {
    writeDonor([{ id: `${DONOR}:a.ts:a:1`, vec: [1, 0] }]);
    register(git(["rev-parse", "HEAD"]));
    writeFileSync(vectorsOf(targetIndex()), "");
    writeFileSync(metaOf(targetIndex()), JSON.stringify({
      model: "embeddinggemma", provider: "ollama", dimensions: 2, symbol_count: 0, updated_at: 1,
    }));
    const partial = join(dir, "target.embeddings.partial.ndjson");
    writeFileSync(partial, JSON.stringify({ model: "embeddinggemma" }) + "\n");

    const result = await cloneVectorsFromNearestDonor(repo, TARGET, targetIndex());

    if (!result.seeded) {
      expect(result.reason).toMatch(/cannot clone/); // a filesystem without copy-on-write
      return;
    }
    expect(result.vectors).toBe(1);
    expect(readFileSync(partial, "utf-8")).toBe(JSON.stringify({ model: "embeddinggemma" }) + "\n");
  });

  // Bug: the chunk pass had no clone, so every worktree embedded every chunk from scratch. A donor's
  // generation may be ndjson (older) or a vector file under the same name; both must clone and reuse.
  it.each(["ndjson", "vector file"])("clones a sibling's published chunk generation (%s), ids rebased for reuse", async (format) => {
    register(git(["rev-parse", "HEAD"]));
    writeFileSync(join(dir, "donor.chunks.ndjson.generation.g"), JSON.stringify({
      id: `${DONOR}:a.ts:1`, file: "a.ts", startLine: 1, endLine: 1, text: "a", tokenCount: 1,
    }) + "\n");
    const generation = join(dir, "donor.chunk-embeddings.ndjson.generation.g");
    if (format === "ndjson") {
      writeFileSync(generation, JSON.stringify({ id: `${DONOR}:a.ts:1`, vec: [1, 0], h: 5 }) + "\n");
    } else {
      await saveChunkEmbeddings(generation, new Map([[`${DONOR}:a.ts:1`, new Float32Array([1, 0])]]), new Map([[`${DONOR}:a.ts:1`, 5]]));
      expect(await isVectorFile(generation)).toBe(true);
    }
    writeFileSync(join(dir, "donor.chunk-index.json"), JSON.stringify({
      version: 1, chunks: "donor.chunks.ndjson.generation.g", embeddings: "donor.chunk-embeddings.ndjson.generation.g", model: "m",
    }));

    const result = await cloneChunksFromNearestDonor(repo, TARGET, targetIndex(), "m");

    if (!result.seeded) {
      expect(result.reason).toMatch(/cannot clone/); // a filesystem without copy-on-write
      return;
    }
    const manifest = await loadChunkManifest(join(dir, "target.chunks.ndjson"));
    const reused = await loadChunkVectorsForReuse(join(dir, "target.chunk-embeddings.ndjson"), manifest);
    expect([...reused.hashes]).toEqual([[`${TARGET}:a.ts:1`, 5]]);
  });

  it("ignores a checkout whose commit is not in this tree's history", async () => {
    writeDonor([{ id: `${DONOR}:a.ts:a:1`, vec: [1, 0] }]);
    register("f".repeat(40));

    const result = await cloneVectorsFromNearestDonor(repo, TARGET, targetIndex());

    expect(result).toEqual({ seeded: false, reason: "no indexed checkout in this history has vectors" });
  });
});
