import { getIndexSummary } from "./index-tools.js";
import { loadConfig } from "../config.js";
import { resolveRegisteredRepoMeta } from "../storage/registry.js";
import { loadIndexOrStale } from "../storage/index-store.js";
import { isIndexStorageError } from "../storage/sqlite-index-store.js";
import { EXTRACTOR_VERSIONS } from "./index-shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexStatusResult {
  indexed: boolean;
  file_count?: number;
  symbol_count?: number;
  language_breakdown?: Record<string, number>;
  text_stub_languages?: string[];
  last_indexed?: string; // ISO date
  /** When the index file exists but its extractor_version drifted from the
   *  current bundled set. Distinct from "no index file at all" — agents need
   *  this signal to know that re-running index_folder will fix it, instead of
   *  assuming the repo was never indexed. */
  stale?: {
    reason: "extractor_version_mismatch";
    language: string;
    expected_version: string;
    actual_version: string;
    mismatch_detail?: string;
  };
  /** Set when this index was upgraded from the v1 SQLite schema, which silently dropped symbols
   *  whose non-unique `id` collided. `symbol_count` below is then a floor, not a count: the
   *  upgrade preserved every row still stored and could not recover the rest. Reported here
   *  because this is the tool whose job is to say whether the index can be trusted — without it
   *  the marker would exist in the database and inform nobody. Clears on a reindex that
   *  re-parses every file. */
  lossy_migration?: {
    reason: "v1_schema_dropped_colliding_symbols";
    hint: string;
  };
  /** When the index store exists but could not be read at all — locked, corrupt, permissions.
   *  Same principle as `stale`, one step further: an agent told "not indexed" will rebuild,
   *  which is wrong (and destructive) for a database that is merely busy. `indexed` stays
   *  false because nothing could be read, but this field is what says why. */
  unreadable?: {
    reason: "storage_error";
    /** SQLITE_* or errno code. SQLITE_BUSY is worth retrying; SQLITE_CORRUPT is not. */
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/**
 * One translation from a storage fault to the reported field.
 * Three copies of this literal drifted apart is exactly how the code and the type stop agreeing.
 */
function toUnreadable(fault: { code: string; message: string }): Pick<IndexStatusResult, "unreadable"> {
  return { unreadable: { reason: "storage_error", code: fault.code, message: fault.message } };
}

const TEXT_STUB_LANGUAGES = new Set([
  "kotlin", "swift", "dart", "scala", "groovy",
  "elixir", "lua", "zig", "nim", "gradle", "sbt",
]);

export async function indexStatus(repo: string): Promise<IndexStatusResult> {
  // Status check should NOT block on freshness — telemetry showed p99=43s
  // because ensureIndexFresh triggers git-diff + reindex of changed files.
  // Stale-but-fast metadata is the right tradeoff for a status call.
  // ADR-004 stage 2: this tool reports counts and file metadata and never touches
  // `index.symbols`, so it reads the narrow summary. On the measured 240k-symbol index that is
  // ~1.0 s and 349 MB of heap it no longer builds to answer a status question.
  let index: Awaited<ReturnType<typeof getIndexSummary>>;
  try {
    index = await getIndexSummary(repo, { skipFreshness: true });
  } catch (err) {
    // getIndexSummary throws on an unreadable store so that ordinary tools cannot render a storage
    // fault as an empty result. This tool is the exception: reporting index health IS its job,
    // so it describes the fault instead of propagating it — straight from the caught error, with
    // no second read. Re-probing would hit an already-struggling store again and could observe a
    // different outcome than the one being reported.
    if (isIndexStorageError(err)) {
      return {
        indexed: false,
        ...toUnreadable(err),
      };
    }
    throw err;
  }
  if (!index) {
    // getIndexSummary returns null both for "no index file" and for stale-version
    // mismatches. Disambiguate by reading the index path directly: if the file
    // exists but extractor_version drifted, surface a structured stale signal
    // instead of a generic "not indexed". Agents acting on "not indexed" will
    // run index_folder, but agents acting on "stale" can be told the same fix
    // applies AND that some data is still on disk — useful for reasoning about
    // partial coverage during the rebuild.
    const problem = await probeIndexProblem(repo);
    if (problem) return { indexed: false, ...problem };
    return { indexed: false };
  }

  const languageBreakdown: Record<string, number> = {};
  const stubLangs = new Set<string>();

  for (const file of index.files) {
    languageBreakdown[file.language] = (languageBreakdown[file.language] ?? 0) + 1;
    if (TEXT_STUB_LANGUAGES.has(file.language)) {
      stubLangs.add(file.language);
    }
  }

  const result: IndexStatusResult = {
    indexed: true,
    file_count: index.file_count,
    symbol_count: index.symbol_count,
    language_breakdown: languageBreakdown,
    last_indexed: new Date(index.updated_at).toISOString(),
  };
  if (stubLangs.size > 0) result.text_stub_languages = [...stubLangs].sort();
  if (index.lossy_migration === true) {
    result.lossy_migration = {
      reason: "v1_schema_dropped_colliding_symbols",
      hint:
        "symbol_count is a floor, not a count — the v1 schema discarded symbols sharing an id " +
        "(same file and line). Run index_folder to re-parse every file and restore them.",
    };
  }
  return result;
}

/** Probe the on-disk index and describe why it did not load: drifted extractor versions, or a
 *  storage fault. Returns null for the genuine "never indexed" case.
 *
 *  It reports `unreadable` as well as `stale` because this path is reachable with a fault: a
 *  store that read fine a moment ago (so `getCodeIndex` returned null rather than throwing) can
 *  be locked by the time this probe runs. Falling through to a bare `{indexed:false}` there
 *  would reintroduce exactly the misdiagnosis this change removes.
 *
 *  Uses `resolveRegisteredRepoMeta` so registry resolution stays aligned with `getCodeIndex`. */
async function probeIndexProblem(
  repo: string,
): Promise<Pick<IndexStatusResult, "stale"> | Pick<IndexStatusResult, "unreadable"> | null> {
  const config = loadConfig();
  let result: Awaited<ReturnType<typeof loadIndexOrStale>>;
  try {
    const resolved = await resolveRegisteredRepoMeta(config.registryPath, repo);
    if (!resolved) return null;
    result = await loadIndexOrStale(resolved.meta.index_path, { ...EXTRACTOR_VERSIONS });
  } catch (err) {
    if (isIndexStorageError(err)) {
      return toUnreadable(err);
    }
    // Anything else here (registry I/O, an unexpected TypeError) is a live fault. Returning
    // null would render it as {indexed:false} — an authoritative "nothing indexed" over a
    // problem nobody can see. Let it propagate.
    throw err;
  }
  if (result?.status === "unreadable") {
    return toUnreadable(result);
  }
  if (result?.status === "stale") {
    return {
      stale: {
        reason: "extractor_version_mismatch",
        language: result.language,
        expected_version: result.expected_version,
        actual_version: result.actual_version,
        ...(result.mismatch_detail ? { mismatch_detail: result.mismatch_detail } : {}),
      },
    };
  }
  return null;
}
