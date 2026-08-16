import { isAbsolute } from "node:path";
import { canonicalPath } from "../utils/worktree.js";

/**
 * Refuse to answer a GIT question about a different working tree than the caller named.
 *
 * `resolveExplicitRepoInput` maps an absolute path to any registered repo that is an ANCESTOR of
 * it, longest root winning. For an unregistered linked worktree that is the parent checkout — so
 * the git-diff family ran `git` in the parent and answered confidently about files the caller had
 * never touched. Measured on a real worktree: `diff_outline("<worktree>", "HEAD~1", "HEAD")`
 * returned the PARENT's diff, listing a file committed on main, while the worktree's own commit
 * did not appear. It did not fail — it answered, and the answer looked plausible.
 *
 * Telemetry, post-fix window, path-as-repo vs name-as-repo: diff_outline 11.3% vs 2.4%,
 * impact_analysis 11.3% vs 5.8%, review_diff 11.3% vs 3.1%, changed_symbols 10.1% vs 3.9% — four
 * tools within 1.2 points of each other, which is the signature of one shared resolver rather than
 * four bugs. Those were the cases where git errored outright; the silent ones never showed up as
 * errors at all.
 *
 * Only fires when the caller passed a PATH. A registry name carries no claim about which directory
 * the caller is in, so there is nothing to contradict — and H19 already covers the read tools,
 * where a parent's answer is at least a usable approximation. For a git range it is not: the refs
 * belong to a different tree.
 */
export function assertGitTreeMatches(repo: string, indexRoot: string): void {
  if (!isAbsolute(repo)) return;
  if (canonicalPath(repo) === canonicalPath(indexRoot)) return;
  throw new Error(
    `"${repo}" is not indexed — it resolved to "${indexRoot}", a DIFFERENT working tree, `
    + "so any git range would describe that tree's commits and not yours. "
    + `Index this one first: index_folder(path="${repo}").`,
  );
}
