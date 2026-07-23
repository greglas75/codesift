/**
 * Shared success marker for the out-of-process embedding run.
 *
 * Kept in its own side-effect-free module on purpose: embed-child.ts executes
 * its main() on import, so the parent pulling the constant from there would run
 * the child's entry point inside the parent process — and any error in that
 * module would fail the parent's `codesift index` outright.
 */
export const EMBED_CHILD_OK_MARKER = "__codesift_embed_ok__";
