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

/**
 * Pseudo-refs the diff tools accept for `until` to diff against uncommitted
 * state. Git has no ref by these names, so they must be translated — never
 * passed through as `${since}..${until}`.
 */
export const DIFF_PSEUDO_REFS = { WORKING: "WORKING", STAGED: "STAGED" } as const;

/**
 * Build the argv for `git diff`, translating the pseudo-refs WORKING and STAGED
 * (uncommitted working tree / staging index) into the correct invocation.
 *
 *   until = "WORKING" → git diff [--name-only] <since>           (since → working tree)
 *   until = "STAGED"  → git diff [--name-only] --cached <since>  (since → index)
 *   otherwise         → git diff [--name-only] <since>..<until>  (ref → ref)
 *
 * Root cause of a class of failures (telemetry 2026-07: impact_analysis 35.7%
 * error rate, plus review_diff / changed_symbols / diff_outline): callers built
 * `${since}..${until}` unconditionally, so `HEAD..WORKING` hit git as an unknown
 * revision and the whole tool errored. `since` must be a real ref (validated);
 * a pseudo-ref as `since` is unsupported and rejected by validateGitRef.
 */
export function buildGitDiffArgs(
  since: string,
  until: string,
  nameOnly: boolean,
): string[] {
  validateGitRef(since);
  const base = nameOnly ? ["diff", "--name-only"] : ["diff"];
  if (until === DIFF_PSEUDO_REFS.WORKING) return [...base, since];
  if (until === DIFF_PSEUDO_REFS.STAGED) return [...base, "--cached", since];
  validateGitRef(until);
  return [...base, `${since}..${until}`];
}

/** Allows HTTPS, SSH, git://, and file:// protocols. */
export const GIT_URL_PATTERN = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|file:\/\/)[^\s]+$/;

export function validateGitUrl(url: string): void {
  if (!url || !GIT_URL_PATTERN.test(url)) {
    throw new Error(`Invalid git URL: ${url}`);
  }
}
