/**
 * Git ref/URL validation utilities — shared across tools that invoke git.
 * Prevents command injection when refs/URLs are passed to execFileSync.
 */

/** Allows alphanumeric, `/`, `.`, `-`, `_`, `~`, `^`, `@`, `{`, `}`. */
export const GIT_REF_PATTERN = /^[a-zA-Z0-9_./\-~^@{}]+$/;

export function validateGitRef(ref: string): void {
  if (!ref || !GIT_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}"`);
  }
}

/** Allows HTTPS, SSH, git://, and file:// protocols. */
export const GIT_URL_PATTERN = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|file:\/\/)[^\s]+$/;

export function validateGitUrl(url: string): void {
  if (!url || !GIT_URL_PATTERN.test(url)) {
    throw new Error(`Invalid git URL: ${url}`);
  }
}
