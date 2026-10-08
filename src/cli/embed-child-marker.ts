/**
 * Shared markers for the out-of-process index and embedding runs.
 *
 * Kept in its own side-effect-free module on purpose: embed-child.ts and index-child.ts execute
 * their main() on import, so a parent pulling a constant from there would run the child's entry
 * point inside the parent process — and any error in that module would fail the parent outright.
 */
export const EMBED_CHILD_OK_MARKER = "__codesift_embed_ok__";

/** Prefix of the one stdout line carrying the index child's `{result, report}` as JSON. */
export const INDEX_CHILD_RESULT_MARKER = "__codesift_index_result__";

/** Prefix of the line carrying the message indexFolder threw in the child. */
export const INDEX_CHILD_ERROR_MARKER = "__codesift_index_error__";

/**
 * Find `marker` in a stream that may split it across chunks: `tail` carries the last
 * `marker.length - 1` characters of what came before.
 */
export function scanEmbeddingMarker(
  tail: string,
  chunk: string,
  marker: string,
): { sawMarker: boolean; tail: string } {
  const combined = tail + chunk;
  return {
    sawMarker: combined.includes(marker),
    tail: marker.length > 1 ? combined.slice(-(marker.length - 1)) : "",
  };
}
