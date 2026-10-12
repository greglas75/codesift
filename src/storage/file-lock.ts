/**
 * A lock that is a FILE naming its owner's pid — usable across processes, taken over from a dead
 * owner. Written for the embedding checkpoint (embedding-checkpoint.ts), where three review rounds
 * found the failure modes recorded below; shared with the machine-wide embedding gate.
 */
import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";

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
 * Takeover happens under a second lock, `<lock>.takeover`, and only its holder removes a stale lock.
 * Two processes that both read the same dead pid used to each remove and recreate it, and the second
 * removal could take the first one's fresh lock — two owners. The first fix renamed the lock aside
 * and put it back when it turned out live, but in the gap a third process could create one, so the
 * put-back failed and the live owner's lock was gone while it still believed it held it (found by a
 * cross-provider review, 2026-10-12). Under the takeover lock the holder re-reads the lock, and
 * nothing else removes a lock, so what it removes is the stale one it read.
 *
 * A takeover lock is cleared only when its holder is provably gone (a dead pid, or no readable pid
 * past the grace period), never by age: a live holder stalled for seconds on a loaded machine must
 * not lose it. Residual, accepted: two takers clearing one DEAD holder's takeover lock at once can
 * both proceed. That needs a process to die inside a few milliseconds of file operations while two
 * others contend. The scratch name `fresh` is a `.tmp.<pid>` tail, which prune reclaims once that
 * pid is gone; the takeover lock is removed by its holder.
 */
export async function acquireLock(lockPath: string): Promise<{ held: true } | { held: false; owner: number }> {
  if (heldHere.has(lockPath)) return { held: false, owner: process.pid };
  // Reserved BEFORE the first await. Marked only after link(), two concurrent opens in this process
  // both passed the check above; the second then read a lock naming our own pid, took it for a
  // leftover, took it over — and both believed they owned it. Reserved, a lock naming our pid that
  // this attempt meets can only be a leftover, and the scratch names below are this attempt's alone.
  heldHere.add(lockPath);
  let result: Awaited<ReturnType<typeof acquireReserved>> = { held: false, owner: 0 };
  try {
    result = await acquireReserved(lockPath);
  } finally {
    // A throw must not leave the reservation behind: every later open would read it as "held here".
    if (!result.held) heldHere.delete(lockPath);
  }
  return result;
}

/** Take `<lock>.takeover` by linking `fresh` (our pid) into place; clear a dead holder's first. */
async function takeTakeoverLock(takeover: string, fresh: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await link(fresh, takeover);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    const holder = await lockHolder(takeover);
    if (holder === "gone") continue;
    if (holdsLock(holder)) return false;
    await unlink(takeover).catch(() => undefined);
  }
  return false;
}

async function acquireReserved(lockPath: string): Promise<{ held: true } | { held: false; owner: number }> {
  const fresh = `${lockPath}.tmp.${process.pid}.new`;
  const takeover = `${lockPath}.takeover`;
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
      if (!(await takeTakeoverLock(takeover, fresh))) continue; // another process is taking it over
      try {
        const again = await lockHolder(lockPath);
        if (again !== "gone") {
          if (holdsLock(again)) return { held: false, owner: ownerOf(again) };
          await unlink(lockPath).catch(() => undefined);
        }
        try {
          await link(fresh, lockPath);
          return { held: true };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { held: false, owner: 0 };
          // Created by a plain link since the unlink: that process owns it now.
        }
      } finally {
        // Only ours to remove if it still names us — a taker that judged ours stale may have replaced it.
        const holderNow = await lockHolder(takeover);
        if (typeof holderNow === "object" && holderNow.pid === process.pid) await unlink(takeover).catch(() => undefined);
      }
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
