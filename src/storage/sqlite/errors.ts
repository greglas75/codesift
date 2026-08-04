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
  if (err instanceof IndexStorageError) return err.code;
  if (typeof err !== "object" || err === null) return null;

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (OPERATIONAL_CODES.has(code)) return code;
    // node:sqlite surfaces extended result codes (SQLITE_IOERR_READ, SQLITE_BUSY_SNAPSHOT...).
    for (const known of OPERATIONAL_CODES) {
      if (known.startsWith("SQLITE_") && code.startsWith(`${known}_`)) return code;
    }
  }

  // Some node:sqlite builds only carry the reason in the message.
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
  if (err instanceof IndexStorageError) throw err;
  const detail = err instanceof Error ? err.message : String(err);
  throw new IndexStorageError(
    `index storage at ${path} is unreadable (${code}): ${detail}`,
    code,
    path,
    { cause: err },
  );
}
