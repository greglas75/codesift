/**
 * The partial file an embedding run appends each finished batch to (see `getPartialEmbeddingPath`),
 * owned by one writer at a time.
 *
 * The first version (7987c024) got four things wrong, all found by a cross-provider review:
 *
 *  - A header that could not be read was reported exactly like a header naming another model, and
 *    the caller deleted the file — so one failed read threw away hours of vectors. The states are
 *    now distinct, and only "another model" and "nothing worth keeping" delete anything.
 *  - Whether to write the header was decided by `existsSync`, so an empty file left by a crash
 *    between create and write never got one, and every later batch was appended headerless. It is
 *    now decided by the size of the handle being written.
 *  - Nothing serialised writers. The in-process path and the embed child derive the same path, and
 *    one could unlink the file the other was appending to. A lock file now names the owner; a run
 *    that finds a live owner neither resumes, checkpoints nor deletes.
 *  - A killed append leaves a torn last line, and appending after it fused the fragment with the
 *    next batch. The tail is cut back to the last complete line before the first append.
 *
 * Every failure here degrades to "no checkpoint this run", which is the behaviour before partial
 * files existed — never to losing vectors or blocking the run.
 */
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

export type PartialState =
  | { kind: "absent" }
  | { kind: "model"; model: string }
  /** No complete first line: a write died before its first newline, so at most one batch is lost. */
  | { kind: "torn" }
  /** A complete first line that is not a header. Not ours to judge — moved aside, never deleted. */
  | { kind: "foreign" }
  /** The file is there and could not be read. Left exactly as it is. */
  | { kind: "unreadable"; error: string };

/** A header line is ~40 bytes; past this without a newline the first line is not a header. */
const MAX_HEADER_BYTES = 64 * 1024;

export async function readPartialState(partialPath: string): Promise<PartialState> {
  let handle;
  try {
    handle = await open(partialPath, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", error: code ?? String(err) };
  }
  try {
    // Read until the first newline: a single read() may legally return fewer bytes than asked for.
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_HEADER_BYTES) {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      if (buf.subarray(0, bytesRead).includes(0x0a)) break;
    }
    const text = Buffer.concat(chunks).toString("utf-8");
    const newline = text.indexOf("\n");
    if (newline < 0) return total < MAX_HEADER_BYTES ? { kind: "torn" } : { kind: "foreign" };
    try {
      const header = JSON.parse(text.slice(0, newline)) as { model?: unknown; id?: unknown };
      return typeof header.model === "string" && header.id === undefined
        ? { kind: "model", model: header.model }
        : { kind: "foreign" };
    } catch {
      return { kind: "foreign" };
    }
  } catch (err) {
    return { kind: "unreadable", error: (err as NodeJS.ErrnoException).code ?? String(err) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Locks this process holds. Its own pid in a lock file is otherwise indistinguishable from a leftover. */
const heldHere = new Set<string>();

/** Take `<partial>.lock`, or report the live pid that holds it. A dead holder is taken over. */
async function acquireLock(lockPath: string): Promise<{ held: true } | { held: false; owner: number }> {
  if (heldHere.has(lockPath)) return { held: false, owner: process.pid };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      heldHere.add(lockPath);
      return { held: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number((await readFile(lockPath, "utf-8").catch(() => "")).trim());
      if (owner !== process.pid && pidIsAlive(owner)) return { held: false, owner };
      // A dead process's lock, or one an earlier process with our recycled pid left behind (this
      // process holds nothing, per `heldHere`).
      await unlink(lockPath).catch(() => undefined);
    }
  }
  return { held: false, owner: 0 };
}

export interface ResumeDecision {
  resume: boolean;
  /** Said once in the log when the decision changed or set aside a file. */
  note?: string;
}

/**
 * The checkpoint one embedding run writes. `open` returns null when another live process owns the
 * file; the caller then runs exactly as before checkpoints existed.
 */
export class EmbeddingCheckpoint {
  private written = 0;
  private headerPending = true;
  private firstError: string | null = null;
  private disabled = false;

  private constructor(readonly path: string, private readonly model: string, private readonly lockPath: string) {}

  static async open(partialPath: string, model: string): Promise<EmbeddingCheckpoint | { busy: number }> {
    const lockPath = `${partialPath}.lock`;
    const lock = await acquireLock(lockPath);
    if (!lock.held) return { busy: lock.owner };
    return new EmbeddingCheckpoint(partialPath, model, lockPath);
  }

  /**
   * Decide what to do with an existing partial file, under the lock. Deletes only what is provably
   * worthless: another model's vectors, or a first write that never completed a line.
   */
  async decide(): Promise<ResumeDecision> {
    const state = await readPartialState(this.path);
    switch (state.kind) {
      case "absent":
        return { resume: false };
      case "model":
        if (state.model === this.model) return { resume: true };
        await unlink(this.path).catch(() => undefined);
        return { resume: false, note: `discarded checkpoint from model "${state.model}"` };
      case "torn":
        await unlink(this.path).catch(() => undefined);
        return { resume: false };
      case "foreign": {
        // A `.tmp.<ts>` tail is what prune reclaims by age, so this is kept for a while, not forever.
        const aside = `${this.path}.tmp.${Date.now()}`;
        await rename(this.path, aside).catch(() => undefined);
        return { resume: false, note: `moved an unrecognised checkpoint aside to ${aside}` };
      }
      case "unreadable":
        // Cannot tell what it is, so it must not be appended to or deleted. No checkpoint this run.
        this.disabled = true;
        return { resume: false, note: `checkpoint unreadable (${state.error}) — left untouched, not checkpointing` };
    }
  }

  /** Cut a torn last line, so the next append starts on a line of its own. */
  async prepareForAppend(): Promise<void> {
    if (this.disabled) return;
    let handle;
    try {
      handle = await open(this.path, "r+");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // created on first append
      this.disabled = true;
      return;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      this.headerPending = false;
      // A torn line is at most one vector line (~16 KB); scan back far enough to find its start.
      const window = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(window);
      await handle.read(buf, 0, window, size - window);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === window - 1) return;
      if (lastNewline < 0) { this.disabled = true; return; } // no line end in 1 MB: not ours to edit
      await handle.truncate(size - window + lastNewline + 1);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Best effort: a batch that cannot be written costs a resume, never the run. */
  async append(entries: ReadonlyArray<{ id: string; vec: Float32Array; h: number | undefined }>): Promise<void> {
    if (this.disabled || entries.length === 0) return;
    let handle;
    try {
      handle = await open(this.path, "a");
      // The header is decided by what is IN the file, not by whether it exists: an empty file left by
      // a crash between create and write must still get one.
      if (this.headerPending && (await handle.stat()).size === 0) {
        await handle.write(JSON.stringify({ model: this.model }) + "\n");
      }
      this.headerPending = false;
      let text = "";
      for (const { id, vec, h } of entries) {
        text += JSON.stringify(h === undefined ? { id, vec: Array.from(vec) } : { id, vec: Array.from(vec), h }) + "\n";
      }
      await handle.write(text);
      this.written += entries.length;
    } catch (err) {
      if (this.firstError === null) this.firstError = err instanceof Error ? err.message : String(err);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Vectors this run actually persisted, and the first write error if checkpointing failed. */
  get progress(): { written: number; error: string | null } {
    return { written: this.written, error: this.firstError };
  }

  /** The run's vectors reached the main file: the checkpoint has nothing left to protect. */
  async discard(): Promise<void> {
    if (!this.disabled) await unlink(this.path).catch(() => undefined);
  }

  async release(): Promise<void> {
    if (!heldHere.delete(this.lockPath)) return;
    const owner = Number((await readFile(this.lockPath, "utf-8").catch(() => "")).trim());
    if (owner === process.pid) await unlink(this.lockPath).catch(() => undefined);
  }
}
