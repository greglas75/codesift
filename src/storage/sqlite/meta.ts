import type { FileEntry, Workspace } from "../../types.js";

/**
 * The optional metadata both readers reconstruct, and the summary shape built on it.
 *
 * This is its own module rather than living beside `loadIndexSummarySqlite` because BOTH readers
 * need it — `index-io.ts` for the full index and `accessors.ts` for the summary. Putting it in
 * either one would make that reader a dependency of the other for no reason beyond where the code
 * happened to be written.
 */

/**
 * Everything about an index EXCEPT its symbols (ADR-004 stage 2).
 *
 * Deliberately not a `CodeIndex` with an empty `symbols` array. That shape would be a lie a caller
 * cannot detect: iterating it yields nothing and reads as "this repo has no symbols", which is the
 * empty-because-not-loaded answer this codebase treats as the worst one available. With no such
 * field at all, a consumer that needs symbols fails to compile instead of failing silently.
 *
 * `symbol_count` is counted in SQL rather than derived from an array, so it stays a real count.
 */
export interface IndexSummary {
  repo: string;
  root: string;
  files: FileEntry[];
  created_at: number;
  updated_at: number;
  symbol_count: number;
  file_count: number;
  extractor_version?: Record<string, string>;
  workspaces?: Workspace[];
  lossy_migration?: boolean;
}

/**
 * The three optional meta fields both readers reconstruct, parsed once.
 *
 * `loadIndexSqlite` and `loadIndexSummarySqlite` had the same JSON-parse-and-null-check block
 * duplicated verbatim. Two copies of a parser is two places for a schema addition to be applied
 * to only one, and the readers would then disagree about the same database — the class of
 * divergence this file has already been bitten by twice.
 */
export function readMetaExtras(
  meta: (key: string) => string | undefined,
): Pick<IndexSummary, "extractor_version" | "workspaces" | "lossy_migration"> {
  const out: Pick<IndexSummary, "extractor_version" | "workspaces" | "lossy_migration"> = {};

  const extractorRaw = meta("extractor_version");
  if (extractorRaw !== undefined) {
    const parsed = JSON.parse(extractorRaw) as Record<string, string> | null;
    if (parsed !== null) out.extractor_version = parsed;
  }

  const workspacesRaw = meta("workspaces");
  if (workspacesRaw !== undefined) {
    const parsed = JSON.parse(workspacesRaw) as Workspace[] | null;
    if (parsed !== null) out.workspaces = parsed;
  }

  // Presence IS the marker: the writer only ever stores "1" and clears by deleting the key.
  if (meta("lossy_v1_migration") !== undefined) out.lossy_migration = true;

  return out;
}
