// The checkpoint file's ownership and failure modes, below embedSymbols.
//
// Found by a cross-provider review of the first two versions: a lock taken over by two processes at
// once, a failed append followed by more appends (fusing a torn line with the next batch), and errors
// that failed the whole embedding run where they should only turn checkpointing off.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddingCheckpoint } from "../../src/storage/embedding-checkpoint.js";
import { batchEmbed, contentHashesFor, loadEmbeddings } from "../../src/storage/embedding-store.js";

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

  it("treats a lock with no readable pid as live while it is fresh — it may be mid-creation", async () => {
    // The first version created the name before writing the pid; a reader in between saw an empty
    // lock, called its owner dead, and took it over from a live process.
    writeFileSync(`${partial()}.lock`, "");
    expect(await EmbeddingCheckpoint.open(partial(), "m")).toEqual({ busy: 0 });
    expect(readFileSync(`${partial()}.lock`, "utf-8")).toBe("");
  });

  it("takes over a lock with no readable pid once it is past its grace period", async () => {
    writeFileSync(`${partial()}.lock`, "12abc");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${partial()}.lock`, old, old);
    const ckpt = await openOwned();
    expect(readFileSync(`${partial()}.lock`, "utf-8")).toBe(String(process.pid));
    await ckpt.release();
  });

  it("leaves no scratch files behind after taking a lock", async () => {
    writeFileSync(`${partial()}.lock`, "999999");
    const ckpt = await openOwned();
    await ckpt.release();
    expect(readdirSync(dir)).toEqual([]);
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

  it("writes the header again when the file is emptied mid-run", async () => {
    const ckpt = await openOwned();
    await ckpt.decide();
    await ckpt.prepareForAppend();
    await ckpt.append([vec("a")]);
    truncateSync(partial(), 0);
    await ckpt.append([vec("b")]);
    await ckpt.release();

    const lines = readFileSync(partial(), "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toEqual({ model: "m" });
    expect(lines).toHaveLength(2);
  });
});

describe("batchEmbed content hashes", () => {
  it("does not record a new hash for a symbol whose new vector was never computed", async () => {
    // The hash map outlives a failed run in this process. Recording the new hash beside the OLD
    // vector made the next run read that stale vector as current and keep it.
    const key = `ckpt-hash-${Date.now()}`;
    const ok = async (texts: string[]) => texts.map(() => [1, 2]);
    const first = await batchEmbed(new Map([["a", "v1"]]), new Map(), ok, 8, key);
    const before = contentHashesFor(key).get("a");

    await expect(batchEmbed(new Map([["a", "v2"]]), first, async () => {
      throw new Error("provider down");
    }, 8, key)).rejects.toThrow("provider down");
    expect(contentHashesFor(key).get("a")).toBe(before);

    let calls = 0;
    await batchEmbed(new Map([["a", "v2"]]), first, async (texts) => { calls++; return ok(texts); }, 8, key);
    expect(calls).toBe(1);
    expect(contentHashesFor(key).get("a")).not.toBe(before);
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
