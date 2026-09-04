import type {FileEntry, Workspace} from "../../types.js";

/**
 * What the import graph actually reads from an index: paths, the root, and workspace aliases.
 *
 * Structural rather than `ImportGraphIndex` because NOTHING in this module touches `symbols` — verified
 * across all twelve files, zero references. Typing it as the whole index forced eight callers
 * (find_circular_deps, review_diff, check_boundaries, detect_communities, fan_in_fan_out,
 * assemble_context, workspace_graph, wiki-generate) to materialise 352,166 symbol objects to build
 * a graph of file paths.
 *
 * Both `ImportGraphIndex` and `IndexSummary` satisfy this, so the widening is what lets each caller pass
 * whichever it already has, without a cast and without this module knowing which one it got.
 */
export interface ImportGraphIndex {
  /** PHP namespace resolution is per-repository, so the name travels with the paths. */
  repo: string;
  root: string;
  files: FileEntry[];
  workspaces?: Workspace[] | undefined;
}

export interface ImportEdge {
  from: string;
  to: string;
  type_only?: boolean;
  star_import?: boolean;
  raw?: string;
}

export type ImportEdgeExtras = Pick<ImportEdge, "type_only" | "star_import" | "raw">;

export type AddImportEdge = (
  from: string,
  to: string,
  extras?: ImportEdgeExtras,
) => void;

export interface PythonImportContext {
  disabled: boolean;
  indexedFiles: Set<string>;
  srcLayout: string | null;
}
