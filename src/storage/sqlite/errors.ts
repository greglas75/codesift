/**
 * Operational failures of the index store, as distinct from "this repo has no index".
 *
 * Pure classification: no database handle, no filesystem, no dependency on any other module here.
 * That is deliberate — every other module in this backend rethrows through `rethrowOperational`,
 * so anything this file imported would become a dependency of the whole backend.
 */

/**
 * A storage fault, as distinct from "this repo has no index".
 *
 * Both used to arrive at callers as `null`, so a locked or corrupt database was indistinguishable
 * from an unindexed repo: tools reported "not indexed" (prompting a pointless full reindex over a
 * database that was merely busy) or returned empty results that read as an authoritative "no
 * matches". Empty-because-broken is the worst answer an index can give, because nothing about it
 * looks wrong.
 */
export class IndexStorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = "IndexStorageError";
  }
}

/**
 * Codes that mean "the store is there but unusable right now", never "there is nothing here".
 *
 * Deliberately a tight allowlist. Classifying too broadly would convert ordinary absence into a
 * thrown error on a hot path used by ~every tool, which is a worse failure than the one being
 * fixed — so anything unrecognised keeps the previous null-ish behaviour.
 */
const OPERATIONAL_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_READONLY",
  "SQLITE_PERM",
  "SQLITE_FULL",
  "EACCES",
  "EPERM",
  "EIO",
  "EBUSY",
  "ENOSPC",
  "EMFILE",
]);

/**
 * SQLite primary result codes, by number — the path that actually fires for `node:sqlite`.
 *
 * The driver sets `code = "ERR_SQLITE_ERROR"` on EVERY sqlite fault and puts the real result code
 * in `errcode` (numeric) with its text in `errstr`. So the string allowlist below never matched a
 * sqlite fault at all; only the four message regexes did, and only by accident of wording.
 * Measured on node v24.18.0:
 *
 *     not-a-database   code=ERR_SQLITE_ERROR  errcode=26  errstr=file is not a database
 *     readonly write   code=ERR_SQLITE_ERROR  errcode=8   errstr=attempt to write a readonly database
 *     disk full        code=ERR_SQLITE_ERROR  errcode=13  errstr=database or disk is full
 *
 * `SQLITE_FULL`, `SQLITE_READONLY` and `SQLITE_PERM` are listed in the allowlist as must-classify
 * and returned `null` for the entire life of that allowlist: a full disk reported as "this repo
 * has no index". Numbers are the only form the driver actually gives, so they are what we read.
 *
 * Masked with `& 0xff` because SQLite's extended codes are `primary | (sub << 8)` — 266 is
 * SQLITE_IOERR_READ, and 266 & 0xff is 10, SQLITE_IOERR. Reporting the primary code keeps the
 * vocabulary the allowlist speaks; the detail survives in the message.
 */
const SQLITE_RESULT_CODES = new Map<number, string>([
  [3, "SQLITE_PERM"],
  [5, "SQLITE_BUSY"],
  [6, "SQLITE_LOCKED"],
  [8, "SQLITE_READONLY"],
  [10, "SQLITE_IOERR"],
  [11, "SQLITE_CORRUPT"],
  [13, "SQLITE_FULL"],
  [14, "SQLITE_CANTOPEN"],
  [26, "SQLITE_NOTADB"],
]);

/**
 * Structural check, not `instanceof`.
 *
 * A duplicated module instance (bundler, worker/thread boundary, a test importing through a
 * different specifier) makes `instanceof` false for an object that is in every observable way
 * the right error — and the failure mode is silent: the fault falls into the "unexpected error"
 * branch and gets reported as an unindexed repo, which is the exact bug this file exists to
 * prevent.
 */
export function isIndexStorageError(err: unknown): err is IndexStorageError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "IndexStorageError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** The operational code for `err`, or null when it is not an operational failure. */
export function classifyStorageError(err: unknown): string | null {
  // Structural, not `instanceof`, for the reason spelled out on `isIndexStorageError`: a duplicated
  // module instance makes `instanceof` false for an object that is in every observable way the
  // right error, and the fault then falls through to "unexpected" — reported as an unindexed repo.
  if (isIndexStorageError(err)) return err.code;
  if (typeof err !== "object" || err === null) return null;

  // `errcode` first: it is the only field `node:sqlite` puts the real result code in.
  const errcode = (err as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") {
    const primary = SQLITE_RESULT_CODES.get(errcode & 0xff);
    if (primary !== undefined) return primary;
  }

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (OPERATIONAL_CODES.has(code)) return code;
    // Kept for error sources that DO name codes as strings — filesystem faults from `mkdir`, and
    // other sqlite bindings (better-sqlite3 sets `code: "SQLITE_IOERR_READ"`). `node:sqlite` is
    // not one of them; see SQLITE_RESULT_CODES.
    for (const known of OPERATIONAL_CODES) {
      if (known.startsWith("SQLITE_") && code.startsWith(`${known}_`)) return code;
    }
  }

  // Last resort, for a build or binding that carries the reason only in prose.
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    if (/database disk image is malformed|file is not a database/i.test(message)) {
      return "SQLITE_CORRUPT";
    }
    if (/database is locked|database table is locked/i.test(message)) return "SQLITE_BUSY";
    if (/unable to open database/i.test(message)) return "SQLITE_CANTOPEN";
    if (/disk I\/O error/i.test(message)) return "SQLITE_IOERR";
  }
  return null;
}

/** Rethrow operational faults as IndexStorageError; leave everything else untouched. */
export function rethrowOperational(err: unknown, path: string): never {
  const code = classifyStorageError(err);
  if (code === null) throw err;
  if (isIndexStorageError(err)) throw err; // already classified — do not re-wrap
  const detail = err instanceof Error ? err.message : String(err);
  throw new IndexStorageError(
    `index storage at ${path} is unreadable (${code}): ${detail}`,
    code,
    path,
    { cause: err },
  );
}
