import { existsSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { chmod, stat, writeFile } from "node:fs/promises";

/**
 * Writing a file that may embed a CodeSift daemon bearer token, restricted to
 * its owner — and failing loudly when that cannot be done.
 *
 * The shared-daemon feature exists for shared hosts, so a config left at the
 * default umask (commonly 0644) hands every other local account a credential
 * that grants read access to every repository that daemon has indexed.
 *
 * Two things make this harder than passing `mode` to writeFile:
 *
 *  - open(2) applies `mode` only when it CREATES the file. A config written by
 *    an older version keeps its 0644 until something chmods it, so the rewrite
 *    path needs an explicit chmod — and it has to happen BEFORE the new token is
 *    written, not after, or the secret sits on disk readable by everyone for the
 *    length of the write.
 *  - A failed chmod used to be swallowed whole (`.catch(() => {})`) under the
 *    comment "a filesystem without POSIX modes must not fail the setup". That
 *    comment describes one errno; the catch covered every errno, so "I could not
 *    restrict this file" was indistinguishable from success. Observed while
 *    installing the daemon on burst-i9: the systemd unit holding
 *    CODESIFT_HTTP_TOKEN was left at -rw-r--r--, readable by the CI user, and
 *    the install reported OK.
 *
 * So the rule is narrow rather than best-effort: tolerate the errnos that mean
 * this filesystem has no permission bits at all, and for anything else look at
 * what the mode actually IS. Already owner-only means the chmod was redundant
 * and its failure harmless; anything group- or world-accessible is a real
 * exposure of a real credential, and setup must say so instead of returning.
 */

/** Owner read/write only. */
export const OWNER_ONLY_MODE = 0o600;

/**
 * chmod(2) errnos that mean the filesystem does not implement permission bits
 * (FAT/exFAT mounts, some network and container filesystems). On such a
 * filesystem no mode is enforceable, so there is nothing to warn about.
 */
const NO_MODE_SUPPORT = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * Whether a chmod failure can be ignored.
 *
 * `mode` is the file's ACTUAL mode afterwards, or null when it could not be
 * read — an unreadable mode is treated as unsafe, since the alternative is
 * assuming the best about a credential file.
 */
export function chmodFailureIsTolerable(code: string, mode: number | null): boolean {
  if (NO_MODE_SUPPORT.has(code)) return true;
  return mode !== null && (mode & 0o077) === 0;
}

function exposureError(path: string, code: string, mode: number | null): Error {
  const actual = mode === null ? "unknown" : "0" + (mode & 0o777).toString(8);
  return new Error(
    `Could not restrict ${path} to its owner (chmod: ${code}; mode is ${actual}). `
    + "This file can carry a CodeSift daemon token, which grants read access to every "
    + "repository that daemon has indexed, so leaving it readable by other accounts on "
    + `this machine is not something setup can report as success. Run \`chmod 600 ${path}\` `
    + "(or fix its ownership) and try again.",
  );
}

function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "unknown";
}

/** Restrict an existing path; no-op when it does not exist yet. */
async function restrict(path: string): Promise<void> {
  if (!existsSync(path)) return;
  try {
    await chmod(path, OWNER_ONLY_MODE);
  } catch (err) {
    let mode: number | null = null;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch {
      // Unreadable mode — handled as unsafe below.
    }
    const code = errnoOf(err);
    if (!chmodFailureIsTolerable(code, mode)) throw exposureError(path, code, mode);
  }
}

function restrictSync(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, OWNER_ONLY_MODE);
  } catch (err) {
    let mode: number | null = null;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      // Unreadable mode — handled as unsafe below.
    }
    const code = errnoOf(err);
    if (!chmodFailureIsTolerable(code, mode)) throw exposureError(path, code, mode);
  }
}

/**
 * Write `content` to `path` so that only its owner can read it.
 *
 * Throws rather than writing a token to a file it could not secure. The
 * pre-write restrict is what keeps that promise for a file that already exists:
 * by the time the new content lands, the mode is already correct or we never
 * got here.
 */
export async function writeOwnerOnlyFile(path: string, content: string): Promise<void> {
  await restrict(path);
  await writeFile(path, content, { encoding: "utf-8", mode: OWNER_ONLY_MODE });
  await restrict(path);
}

/** Synchronous twin, for install paths that are sync end to end. */
export function writeOwnerOnlyFileSync(path: string, content: string): void {
  restrictSync(path);
  writeFileSync(path, content, { encoding: "utf-8", mode: OWNER_ONLY_MODE });
  restrictSync(path);
}
