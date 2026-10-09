import { join } from "node:path";
import { FRAMEWORK_SOURCE_SAMPLE, detectFrameworks, type Framework } from "../utils/framework-detect.js";
import { HONO_INSTANTIATION } from "./hono-entry-resolver.js";
import { findRepoSymbols, getIndexSummary, streamRepoSymbols } from "./index-tools.js";

/**
 * Framework detection for a repo by name, without materialising its index (ADR-004 stage 2).
 *
 * The Hono tools, nest_audit and the cross-repo resolver each loaded the whole index only to run
 * `detectFrameworks` (file list + the first 200 symbols' source) and, for Hono, to find the first
 * symbol containing `new Hono(`. The summary carries `getCodeIndex`'s null semantics (unknown or
 * stale → null) and runs the freshness check once; the reads after it skip it. Rows come back in
 * rowid order, which is the old array order, so the 200-symbol sample is the same sample.
 */
export interface RepoFrameworkScan {
  root: string;
  files: ReadonlyArray<{ path: string }>;
  frameworks: Set<Framework>;
}

export async function detectRepoFrameworks(repo: string): Promise<RepoFrameworkScan | null> {
  const summary = await getIndexSummary(repo);
  if (!summary) return null;
  const sample = await findRepoSymbols(
    repo,
    { withSource: true, limit: FRAMEWORK_SOURCE_SAMPLE },
    { skipFreshness: true },
  );
  return {
    root: summary.root,
    files: summary.files,
    frameworks: detectFrameworks({ files: summary.files, symbols: sample }),
  };
}

/**
 * `resolveHonoEntryFile` by repo name: the first symbol (index order) whose source instantiates
 * Hono, as an absolute path. Pages through the table and stops at the first hit instead of holding
 * every symbol's source to scan it.
 */
export async function resolveRepoHonoEntryFile(repo: string, root: string): Promise<string | null> {
  let found: string | null = null;
  await streamRepoSymbols(
    repo,
    // Every HONO_INSTANTIATION match contains the literal "Hono", so the store can skip the rest.
    { withSource: true, sourceContainsAny: ["Hono"] },
    (batch) => {
      const hit = batch.find((sym) => sym.source !== undefined && HONO_INSTANTIATION.test(sym.source));
      if (!hit) return true;
      found = join(root, hit.file);
      return false;
    },
    { skipFreshness: true },
  );
  return found;
}
