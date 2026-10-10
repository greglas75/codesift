// The checkpoint file's ownership and failure modes, below embedSymbols.
//
// Found by a cross-provider review of the first two versions: a lock taken over by two processes at
// once, a failed append followed by more appends (fusing a torn line with the next batch), and errors
// that failed the whole embedding run where they should only turn checkpointing off.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddingCheckpoint } from "../../src/storage/embedding-checkpoint.js";
import { loadEmbeddings } from "../../src/storage/embedding-store.js";

let dir: string;
const partial = () => join(dir, "abcdef012345.embeddings.partial.ndjson");
const vec = (id: string) => ({ id, vec: new Float32Array([1, 2]), h: 1 });
const isRoot = process.getuid?.() === 0;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-ckpt-")); });
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

async function openOwned(): Promise<EmbeddingCheckpoint> {
  const opened = await EmbeddingCheckpoint.open(partial(), "m");
  if ("busy" in opened) throw new Error(`expected to own the checkpoint, busy=${opened.busy}`);
  return opened;
}

describe("EmbeddingCheckpoint lock", () => {
  it("takes over a dead owner's lock and writes its own pid", async () => {
    writeFileSync(`${partial()}.lock`, "999999");
    const ckpt = await openOwned();
    expect(readFileSync(`${partial()}.lock`, "utf-8")).toBe(String(process.pid));
    await ckpt.release();
    expect(existsSync(`${partial()}.lock`)).toBe(false);
  });

  it("reports a live owner and leaves its lock exactly as it was", async () => {
    writeFileSync(`${partial()}.lock`, String(process.ppid));
    const opened = await EmbeddingCheckpoint.open(partial(), "m");
    expect(opened).toEqual({ busy: process.ppid });
    expect(readFileSync(`${partial()}.lock`, "utf-8")).toBe(String(process.ppid));
  });

  it("is not taken twice by one process", async () => {
    const first = await openOwned();
    expect(await EmbeddingCheckpoint.open(partial(), "m")).toEqual({ busy: process.pid });
    await first.release();
  });

  it("degrades to busy, not a throw, when the lock cannot be created at all", async () => {
    if (isRoot) return; // root writes through a read-only directory
    chmodSync(dir, 0o500);
    expect(await EmbeddingCheckpoint.open(partial(), "m")).toEqual({ busy: 0 });
  });
});

describe("EmbeddingCheckpoint append", () => {
  it("stops after a failed write, so a torn line is never followed by another batch", async () => {
    if (isRoot) return;
    const ckpt = await openOwned();
    await ckpt.decide();
    await ckpt.prepareForAppend();
    chmodSync(dir, 0o500); // the partial does not exist yet, so creating it fails
    await ckpt.append([vec("a")]);
    chmodSync(dir, 0o700);
    await ckpt.append([vec("b")]);

    expect(ckpt.progress.written).toBe(0);
    expect(ckpt.progress.error).not.toBeNull();
    expect(existsSync(partial())).toBe(false);
    await ckpt.release();
  });

  it("writes the header once, then lines the loader reads back", async () => {
    const ckpt = await openOwned();
    await ckpt.decide();
    await ckpt.prepareForAppend();
    await ckpt.append([vec("a")]);
    await ckpt.append([vec("b")]);
    await ckpt.release();

    const lines = readFileSync(partial(), "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toEqual({ model: "m" });
    expect(lines).toHaveLength(3);
    expect([...(await loadEmbeddings(partial())).keys()]).toEqual(["a", "b"]);
  });
});

describe("loadEmbeddings id_rebase guard", () => {
  it("ignores a rebase whose prefix is empty — it would rewrite every id", async () => {
    const vectors = join(dir, "abcdef012345.embeddings.ndjson");
    writeFileSync(vectors, JSON.stringify({ id: "local/r:a.ts:a:1", vec: [1, 2] }) + "\n");
    writeFileSync(join(dir, "abcdef012345.embeddings.meta.json"), JSON.stringify({
      model: "m", provider: "ollama", dimensions: 2, symbol_count: 1, updated_at: 1,
      id_rebase: { from: "", to: "local/r@wt:" },
    }));
    expect([...(await loadEmbeddings(vectors)).keys()]).toEqual(["local/r:a.ts:a:1"]);
  });
});
