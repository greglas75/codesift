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
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { acquireLock, releaseLock } from "./file-lock.js";

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

/** Only ESRCH proves a process is gone; EPERM and anything unexpected count as alive. */
export interface ResumeDecision {
  resume: boolean;
  /** Said once in the log when the decision changed or set aside a file. */
  note?: string;
}

/**
 * The checkpoint one embedding run writes. `open` returns `{busy}` when another live process owns
 * the file (or the lock cannot be taken at all, `busy: 0`); the caller then runs exactly as before
 * checkpoints existed.
 */
export class EmbeddingCheckpoint {
  private written = 0;
  private firstError: string | null = null;
  /** No more appends this run. */
  private disabled = false;
  /** The file on disk is not one this run may delete: unreadable, or could not be set aside. */
  private foreign = false;

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
        return this.clear(`discarded checkpoint from model "${state.model}"`);
      case "torn":
        return this.clear();
      case "foreign": {
        // A `.tmp.<ts>` tail is what prune reclaims by age, so this is kept for a while, not forever.
        // Unique, so a second set-aside never overwrites the first; not a pid, so age alone decides.
        const aside = `${this.path}.tmp.${Date.now()}-${randomUUID()}`;
        try {
          await rename(this.path, aside);
          return { resume: false, note: `moved an unrecognised checkpoint aside to ${aside}` };
        } catch (err) {
          return this.cannotClear(err);
        }
      }
      case "unreadable":
        // Cannot tell what it is, so it must not be appended to or deleted. No checkpoint this run.
        this.disabled = true;
        this.foreign = true;
        return { resume: false, note: `checkpoint unreadable (${state.error}) — left untouched, not checkpointing` };
    }
  }

  /** Delete the file; if that fails it is still there, so nothing may be appended to it. */
  private async clear(note?: string): Promise<ResumeDecision> {
    try {
      await unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return this.cannotClear(err);
    }
    return note === undefined ? { resume: false } : { resume: false, note };
  }

  private cannotClear(err: unknown): ResumeDecision {
    this.disabled = true;
    this.foreign = true;
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    return { resume: false, note: `could not set the old checkpoint aside (${code}) — not checkpointing` };
  }

  /**
   * Cut a torn last line, so the next append starts on a line of its own. Never throws: anything
   * unexpected turns checkpointing off for this run instead of failing it.
   */
  async prepareForAppend(): Promise<void> {
    if (this.disabled) return;
    // Every early exit below leaves a file this run could not vouch for: no appends, no delete.
    const giveUp = (why: string) => {
      this.disabled = true;
      this.foreign = true;
      this.firstError ??= `checkpoint not prepared: ${why}`;
    };
    let handle;
    try {
      handle = await open(this.path, "r+");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") giveUp(code ?? String(err)); // ENOENT: created on first append
      return;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      // A torn line is at most one vector line (~16 KB); scan back far enough to find its start.
      const window = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(window);
      // Fill the window completely: a short read would leave zeros where the tail is, and the last
      // newline found would be an earlier one — truncating good lines.
      let filled = 0;
      while (filled < window) {
        const { bytesRead } = await handle.read(buf, filled, window - filled, size - window + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled < window) { giveUp(`read ${filled} of ${window} tail bytes`); return; }
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === window - 1) return;
      if (lastNewline < 0) { giveUp("no line end in the last 1 MB"); return; } // not ours to edit
      await handle.truncate(size - window + lastNewline + 1);
    } catch (err) {
      giveUp(err instanceof Error ? err.message : String(err));
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
      // The header is decided by what is IN the file, on every append, not by whether it existed or
      // by a one-shot flag: an empty file — left by a crash between create and write, or recreated
      // mid-run — must still get one.
      let text = (await handle.stat()).size === 0 ? JSON.stringify({ model: this.model }) + "\n" : "";
      for (const { id, vec, h } of entries) {
        text += JSON.stringify(h === undefined ? { id, vec: Array.from(vec) } : { id, vec: Array.from(vec), h }) + "\n";
      }
      // One call that writes it all: `write()` may write part of a buffer and report it, and a short
      // write counted as complete is a batch claimed and lost. Header and batch land together.
      await handle.appendFile(text);
      this.written += entries.length;
    } catch (err) {
      // Stop here: a failed write may have left a torn line, and appending after it would fuse the
      // fragment with the next batch. The next run cuts the tail before it appends.
      this.disabled = true;
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
    if (!this.foreign) await unlink(this.path).catch(() => undefined);
  }

  async release(): Promise<void> {
    await releaseLock(this.lockPath);
  }
}
