import path from "node:path";

/**
 * True when `candidate` is `root` itself or lies inside it, on any platform.
 *
 * `candidate.startsWith(root + "/")` hardcodes the POSIX separator: on win32 a registry root is
 * `C:\Project` and a file is `C:\Project\modules\x.php`, so the prefix `C:\Project/` never matches.
 * In `indexFile` that made every call on Windows fail with "checkout is not indexed" and left the
 * PostToolUse hook silently doing nothing (reported from a 0.17.0 install, still present in 0.20.0).
 * `path.relative` uses the platform's separator and, on win32, compares case-insensitively.
 *
 * `impl` exists so tests can exercise `path.win32` from a POSIX host.
 */
export function isPathWithin(
  root: string,
  candidate: string,
  impl: typeof path = path,
): boolean {
  const rel = impl.relative(root, candidate);
  if (rel === "") return true;
  // A different drive (`D:\x` against `C:\Project`) comes back absolute, not as `..`.
  if (impl.isAbsolute(rel)) return false;
  // `..foo` is a legitimate child name; only a whole `..` segment escapes.
  return rel !== ".." && !rel.startsWith(`..${impl.sep}`);
}
