/**
 * A lock that is a FILE naming its owner's pid — usable across processes, taken over from a dead
 * owner. Written for the embedding checkpoint (embedding-checkpoint.ts), where three review rounds
 * found the failure modes recorded below; shared with the machine-wide embedding gate.
 */
import { link, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

/** Only ESRCH proves a process is gone; EPERM and anything unexpected count as alive. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Locks this process holds. Its own pid in a lock file is otherwise indistinguishable from a leftover. */
const heldHere = new Set<string>();

/** A lock whose content cannot be read as a pid is presumed live this long, then stale. */
const UNREADABLE_LOCK_GRACE_MS = 60_000;

/**
 * Who a lock file names: a pid, or "live"/"stale" when it names nobody readable. Only a lock that
 * was CREATED before its content landed (the first version's `writeFile(wx)`) or that something else
 * wrote can be unreadable — this one links fully written files into place.
 */
async function lockHolder(path: string): Promise<{ pid: number } | "live" | "stale" | "gone"> {
  let text: string;
  try {
    text = (await readFile(path, "utf-8")).trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "live";
  }
  if (/^[1-9]\d{0,9}$/.test(text)) return { pid: Number(text) };
  let age: number;
  try {
    age = Date.now() - (await stat(path)).mtimeMs;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "live";
  }
  // A FAR-future mtime (clock change, another host) would otherwise read as fresh forever. A slightly
  // negative age is normal, not that: `mtimeMs` carries sub-millisecond precision and `Date.now()`
  // does not, so a lock read right after creation is often a fraction of a millisecond "ahead" —
  // treating that as stale took over a lock being created (seen as a flake in the full farm suite).
  return Math.abs(age) < UNREADABLE_LOCK_GRACE_MS ? "live" : "stale";
}

const holdsLock = (h: Awaited<ReturnType<typeof lockHolder>>): boolean =>
  h === "live" || (typeof h === "object" && h.pid !== process.pid && pidIsAlive(h.pid));

/**
 * Take `<partial>.lock`, or report the live pid that holds it (0: could not tell). A dead holder is
 * taken over.
 *
 * The lock is a fully written file LINKED into place, so no reader ever sees one without its pid —
 * `writeFile(wx)` creates the name first and writes after, and a reader in between saw an empty lock
 * and took it over from its live owner.
 *
 * Takeover is a RENAME, not an unlink. Two processes that both read the same dead pid would each
 * unlink and recreate, and the second unlink can remove the first one's fresh lock — two owners.
 * A rename moves exactly one file to a name only this process uses, so after it the mover reads what
 * it actually took: the dead owner's lock (proceed) or a live one's fresh lock (put it back, busy).
 * Both scratch names are `.tmp.<pid>` tails, which prune reclaims once that pid is gone.
 */
export async function acquireLock(lockPath: string): Promise<{ held: true } | { held: false; owner: number }> {
  if (heldHere.has(lockPath)) return { held: false, owner: process.pid };
  // Reserved BEFORE the first await. Marked only after link(), two concurrent opens in this process
  // both passed the check above; the second then read a lock naming our own pid, took it for a
  // leftover, took it over — and both believed they owned it. Reserved, a lock naming our pid that
  // this attempt meets can only be a leftover, and the scratch names below are this attempt's alone.
  heldHere.add(lockPath);
  const result = await acquireReserved(lockPath);
  if (!result.held) heldHere.delete(lockPath);
  return result;
}

async function acquireReserved(lockPath: string): Promise<{ held: true } | { held: false; owner: number }> {
  const fresh = `${lockPath}.tmp.${process.pid}.new`;
  const taken = `${lockPath}.tmp.${process.pid}.takeover`;
  const ownerOf = (h: Awaited<ReturnType<typeof lockHolder>>) => (typeof h === "object" ? h.pid : 0);
  try {
    await writeFile(fresh, String(process.pid));
  } catch {
    return { held: false, owner: 0 }; // cannot write here at all: no checkpoint, not a failed run
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(fresh, lockPath);
        return { held: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { held: false, owner: 0 };
      }
      const holder = await lockHolder(lockPath);
      if (holder === "gone") continue;
      if (holdsLock(holder)) return { held: false, owner: ownerOf(holder) };
      // A dead process's lock, one an earlier process with our recycled pid left behind (this
      // process holds nothing, per `heldHere`), or an unreadable one past its grace period.
      try {
        await rename(lockPath, taken);
      } catch {
        continue; // somebody else moved it first — race them for the create
      }
      const moved = await lockHolder(taken);
      if (holdsLock(moved)) {
        // Took a live owner's fresh lock. Hand it back; if a third process has created one since,
        // that one stands and this copy is dropped.
        try {
          await link(taken, lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            await rename(taken, lockPath).catch(() => undefined);
          }
        }
        await unlink(taken).catch(() => undefined);
        return { held: false, owner: ownerOf(moved) };
      }
      await unlink(taken).catch(() => undefined);
    }
    return { held: false, owner: 0 };
  } finally {
    await unlink(fresh).catch(() => undefined);
  }
}

/** Release a lock `acquireLock` granted. Leaves it if it now names another pid. */
export async function releaseLock(lockPath: string): Promise<void> {
  if (!heldHere.delete(lockPath)) return;
  // Held here, so only a lock that now names ANOTHER pid is not ours to remove. While this process
  // lived nobody could take it over, so that should not happen — but if it did, it stands.
  const holder = await lockHolder(lockPath);
  if (typeof holder === "object" && holder.pid !== process.pid) return;
  await unlink(lockPath).catch(() => undefined);
}
