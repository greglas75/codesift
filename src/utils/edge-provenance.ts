/**
 * Edge-provenance classifier — pure functions, no I/O.
 *
 * Classifies graph edges (call edges, import edges) as either directly
 * "EXTRACTED" from source (high confidence, unambiguous) or "INFERRED"
 * via heuristic resolution (lower confidence — overload/candidate
 * disambiguation, star imports, or best-effort layout resolution).
 * Consumers (call-hierarchy, import-graph formatters) use this to
 * annotate ambiguous edges instead of presenting them with the same
 * confidence as directly-resolved ones.
 */

export type EdgeProvenance = "EXTRACTED" | "INFERRED";

/**
 * Minimal structural shape needed to classify an import edge's
 * provenance. Deliberately not imported from import-graph.ts (no
 * cross-module coupling) — the real `ImportEdge` type is structurally
 * compatible and can be passed directly.
 */
export interface ImportEdgeLike {
  star_import?: boolean;
}

/**
 * How an import edge's target file was resolved. `"direct"` and
 * `"workspace-alias"` are unambiguous lookups; the src-layout / PSR-4
 * variants are best-effort heuristic guesses.
 */
export type ImportResolutionKind =
  | "direct"
  | "workspace-alias"
  | "python-src-layout"
  | "php-psr4";

const INFERRED_RESOLUTIONS: ReadonlySet<ImportResolutionKind> = new Set([
  "python-src-layout",
  "php-psr4",
]);

/**
 * Classifies a call edge by how many candidate targets were resolved
 * for it. Exactly one candidate means the call was unambiguously
 * matched to source (EXTRACTED). Two or more candidates means the
 * resolver had to disambiguate (e.g. overloads, dynamic dispatch),
 * so the edge is INFERRED. Zero or negative counts are treated as
 * the safe EXTRACTED default rather than throwing — there is no
 * ambiguity to flag when no candidates were even considered.
 */
export function classifyCallEdgeProvenance(candidateCount: number): EdgeProvenance {
  return candidateCount > 1 ? "INFERRED" : "EXTRACTED";
}

/**
 * Classifies an import edge. Star imports (`from x import *`) can't
 * be tied to a specific exported symbol, so they're always INFERRED.
 * Otherwise, the resolution strategy used to find the target file
 * determines confidence: src-layout and PSR-4 resolution are
 * heuristic guesses (INFERRED); direct and workspace-alias lookups
 * are unambiguous (EXTRACTED), as is the case with no resolution
 * hint at all (default: direct extraction).
 */
export function classifyImportEdgeProvenance(
  edge: ImportEdgeLike,
  resolution?: ImportResolutionKind
): EdgeProvenance {
  if (edge.star_import) return "INFERRED";
  if (resolution && INFERRED_RESOLUTIONS.has(resolution)) return "INFERRED";
  return "EXTRACTED";
}

/**
 * Renders a human-readable suffix for an edge's provenance. EXTRACTED
 * is the default, unannotated case (no visual noise for the common
 * path); INFERRED edges get a trailing ` [inferred]` tag so callers
 * can flag lower-confidence edges in formatted output.
 */
export function formatProvenanceTag(provenance?: EdgeProvenance): string {
  return provenance === "INFERRED" ? " [inferred]" : "";
}
