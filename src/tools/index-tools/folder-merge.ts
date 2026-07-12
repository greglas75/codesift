import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isExistingIndexStale } from "./snapshots.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../types.js";
import type { FileHashSnapshot } from "../../storage/hash-snapshot.js";
import type { IndexFolderResult } from "./types.js";

export interface FolderMergeContext {
  existing: CodeIndex | null;
  fileEntries: FileEntry[];
  symbols: CodeSymbol[];
  newSnapshotFiles: Record<string, string>;
  oldSnapshot: FileHashSnapshot | null;
  rootPath: string;
  repoName: string;
  startTime: number;
  maxFiles: number;
  hitFileLimit: boolean;
  includePaths: string[] | undefined;
}

export interface FolderMergeResult {
  mergedSymbols: CodeSymbol[];
  mergedEntries: FileEntry[];
  mergedSnapshotFiles: Record<string, string>;
}

export async function validateAndMergeFolderWalk(
  context: FolderMergeContext,
): Promise<FolderMergeResult | IndexFolderResult> {
  const {
    existing,
    fileEntries,
    symbols,
    newSnapshotFiles,
    oldSnapshot,
    rootPath,
    repoName,
    startTime,
    maxFiles,
    hitFileLimit,
    includePaths: scopePaths,
  } = context;

  const STALE_SAMPLE_LIMIT = 256;
  const STALE_MISSING_FRACTION = 0.5;

  // Sanity check: don't overwrite a complete index with a partial one
  // (WASM crash or walk failure can produce truncated results).
  //
  // IMPORTANT: skip the guard when the walk was explicitly narrowed — either
  // max_files was hit (truncated at cap) or include_paths scoped the walk to a
  // subdirectory. In both cases the small result count is EXPECTED and rejecting
  // it would be a false positive (the "1139 vs 9512" bug class). For unrestricted
  // walks the guard stays as-is, protecting against genuine silent truncations.
  //
  // CRITICAL (T7 correctness fix): skipping the guard is necessary but NOT
  // sufficient. A scoped/capped walk only SEES a narrow slice of the repo; if we
  // persisted that slice as the WHOLE index we would wipe every out-of-scope
  // file's symbols from index+snapshot (worse than the guard's old reject,
  // which at least preserved the prior index). So for scoped/capped walks with
  // an existing index we MERGE: keep out-of-scope existing entries verbatim and
  // overlay the walk's results. See the merge block below.
  //
  // "max_files hit" detection: files.length === effective maxFiles. This is the
  // only signal walkDirectory exposes (it sets limitReached internally but does
  // not surface it on the return value). A 1-in-a-million exact-count false
  // positive (repo has exactly maxFiles parseable files) is accepted — the
  // guard skip is conservative (allows write), not destructive.
  const DROP_THRESHOLD = 0.5; // Reject if new index has <50% of old file count
  const walkExplicitlyCapped = hitFileLimit;
  const walkExplicitlyScoped =
    scopePaths !== undefined && scopePaths.length > 0;
  // MIN_GUARD_FILES: the unrestricted guard only arms above this existing
  // file_count (`existing.file_count > 50` below). The scoped-granularity guard
  // mirrors that shape against the in-scope subset so a tiny scope can't be
  // rejected on noise. Single source of truth so both guards stay in lockstep.
  const MIN_GUARD_FILES = 50;
  if (walkExplicitlyCapped || walkExplicitlyScoped) {
    // ROUND-2 FIX (scoped-granularity guard): the unrestricted guard is skipped
    // for scoped/capped walks because a small *overall* result is expected. But
    // that skip was total — a scoped walk that aborts mid-enumeration (WASM
    // crash, transient FS error, an over-broad exclude) silently truncates the
    // IN-SCOPE slice, and the merge below treats every unwalked in-scope file as
    // a deletion → wipes it from index+snapshot. So for a purely SCOPED (uncapped)
    // walk we re-arm a guard against the IN-SCOPE subset: if the walk enumerated
    // far fewer in-scope files than the existing index held in that same scope,
    // AND those files are still on disk, the enumeration was truncated → reject
    // before any merge/save, leaving the old index+snapshot intact.
    //
    // Capped walks are intentionally EXEMPT: a cap means unseen ≠ deleted (the
    // merge preserves all unwalked files), so there is no truncation to detect —
    // nothing in-scope is dropped. A walk that is BOTH scoped and capped also
    // takes capped semantics (preserve everything unwalked), so the same
    // exemption applies — no in-scope file can be lost.
    if (walkExplicitlyScoped && !walkExplicitlyCapped && existing) {
      const includePaths = scopePaths!;
      const inScopeRel = (relPath: string): boolean =>
        includePaths.some((p) => relPath.startsWith(p)); // mirror walkDirectory
      const existingInScope = existing.files.filter((fe) => inScopeRel(fe.path));
      // All walked files are in scope by construction (walkDirectory honored
      // includePaths), so walkedInScope is simply the walk's file count.
      const walkedInScope = fileEntries.length;
      if (
        existingInScope.length > MIN_GUARD_FILES &&
        walkedInScope < existingInScope.length * DROP_THRESHOLD
      ) {
        // Auto-heal analog (in-scope): the shrink may be a genuine mass deletion
        // within the scope, not a truncated walk. Sample the existing in-scope
        // paths on disk (mirrors isExistingIndexStale, but restricted to the
        // scope) — if most are gone, accept the merge.
        const inScopePaths = existingInScope.map((fe) => fe.path);
        const stride = Math.max(1, Math.floor(inScopePaths.length / STALE_SAMPLE_LIMIT));
        const sampled: string[] = [];
        for (let i = 0; i < inScopePaths.length && sampled.length < STALE_SAMPLE_LIMIT; i += stride) {
          const p = inScopePaths[i];
          if (p) sampled.push(p);
        }
        let missing = 0;
        await Promise.all(sampled.map(async (relPath) => {
          try {
            await stat(join(rootPath, relPath));
          } catch {
            missing++;
          }
        }));
        const mostGone = missing >= sampled.length * STALE_MISSING_FRACTION;
        if (mostGone) {
          console.error(
            `[codesift] Scoped sanity auto-heal for ${repoName}: walked ` +
            `${walkedInScope} of ${existingInScope.length} in-scope files but ` +
            `most sampled in-scope paths no longer exist on disk. Accepting ` +
            `scoped merge (legit in-scope mass deletion).`,
          );
        } else {
          console.error(
            `[codesift] SCOPED SANITY CHECK FAILED for ${repoName}: scoped walk ` +
            `under-enumerated — walked ${walkedInScope} of ${existingInScope.length} ` +
            `in-scope files, which still exist on disk. Keeping old index.`,
          );
          return {
            repo: repoName,
            root: rootPath,
            file_count: existing.file_count,
            symbol_count: existing.symbol_count,
            duration_ms: Date.now() - startTime,
            status: "rejected_partial",
            reason: `scoped walk under-enumerated: walked ${walkedInScope} of ${existingInScope.length} in-scope files (still on disk) — kept old index, nothing was re-registered`,
            hint: "If the in-scope shrink is expected (deleted files, new excludes), run invalidate_cache then index_folder to rebuild from scratch.",
          };
        }
      }
    }
    const detail = walkExplicitlyCapped
      ? `max_files=${maxFiles} hit (${fileEntries.length} files returned)`
      : `include_paths=[${scopePaths!.join(", ")}]`;
    console.error(`[codesift] sanity guard skipped: walk explicitly capped/scoped (${detail})`);
  } else if (existing && fileEntries.length < existing.file_count * DROP_THRESHOLD && existing.file_count > MIN_GUARD_FILES) {
    // The shrink can also mean the OLD index is the bogus one: an earlier
    // walker may have swept since-deleted trees (.worktrees/, vendored dirs),
    // permanently inflating the baseline so every honest reindex looks
    // truncated and gets rejected forever. Disambiguate by sampling the old
    // index's paths: if most of them no longer exist on disk, the old index
    // is stale dead weight — accept the new result instead of keeping it.
    if (await isExistingIndexStale(existing, rootPath)) {
      console.error(
        `[codesift] Sanity check auto-heal for ${repoName}: old index has ` +
        `${existing.file_count} files but most sampled paths no longer exist ` +
        `on disk. Accepting new index (${fileEntries.length} files).`,
      );
    } else {
      console.error(
        `[codesift] SANITY CHECK FAILED for ${repoName}: ` +
        `new index has ${fileEntries.length} files vs ${existing.file_count} previously. ` +
        `Keeping old index. Use invalidate_cache + index_folder to force reindex.`,
      );
      return {
        repo: repoName,
        root: rootPath,
        file_count: existing.file_count,
        symbol_count: existing.symbol_count,
        duration_ms: Date.now() - startTime,
        status: "rejected_partial",
        reason: `new walk found ${fileEntries.length} files, <50% of the ${existing.file_count} previously indexed — kept old index, nothing was re-registered`,
        hint: "If the shrink is expected (deleted trees, new excludes), run invalidate_cache then index_folder to rebuild from scratch.",
      };
    }
  }

  // ── MERGE-persist for scoped/capped walks (T7 correctness fix) ────────────
  // A scoped (include_paths) or capped (max_files-hit) walk only enumerated a
  // slice of the repo. Persisting that slice verbatim would delete every
  // out-of-scope file's symbols from index+snapshot. When an existing index is
  // present we instead MERGE: preserve out-of-scope existing entries/symbols/
  // shas and overlay the walk's results.
  //
  //  - include_paths scoped (and NOT capped): "scope" = files whose relPath is
  //    under any include root (mirror walkDirectory's relPath.startsWith(p)
  //    test EXACTLY). Out-of-scope existing files are preserved verbatim;
  //    in-scope existing files NOT in the walk set W are dropped (genuine
  //    in-scope deletions — the walk fully enumerated the scope).
  //  - capped (max_files hit): scope is UNDEFINED — the cap means an unseen
  //    file is not necessarily deleted. Preserve ALL existing entries not in W,
  //    overlay W. (If a capped walk also passed include_paths, the cap makes the
  //    in-scope enumeration incomplete too, so we still only trust W and
  //    preserve everything else — capped semantics win.)
  //
  // First run (no existing index) with a scoped/capped walk → save what we have
  // (current behavior, documented): there is nothing to preserve.
  let mergedSymbols = symbols;
  let mergedEntries = fileEntries;
  let mergedSnapshotFiles = newSnapshotFiles;
  if ((walkExplicitlyCapped || walkExplicitlyScoped) && existing) {
    const walkedPaths = new Set(fileEntries.map((fe) => fe.path));
    // A capped walk has undefined scope (unseen ≠ deleted), so it preserves
    // everything not walked. A purely scoped (uncapped) walk additionally drops
    // in-scope-but-unwalked files, since the walk fully enumerated the scope.
    const includePaths = scopePaths;
    const inScope = (relPath: string): boolean => {
      if (walkExplicitlyCapped) return false; // cap → never treat as deletable
      if (!includePaths || includePaths.length === 0) return false;
      // Mirror walkDirectory's include-path filter exactly.
      return includePaths.some((p) => relPath.startsWith(p));
    };

    const preservedEntries: FileEntry[] = [];
    const preservedFilePaths = new Set<string>();
    for (const fe of existing.files) {
      if (walkedPaths.has(fe.path)) continue; // walk result wins for these
      if (inScope(fe.path)) continue; // in-scope + not walked = deleted-in-scope
      preservedEntries.push(fe);
      preservedFilePaths.add(fe.path);
    }
    const preservedSymbols = existing.symbols.filter((s) =>
      preservedFilePaths.has(s.file),
    );

    mergedEntries = [...preservedEntries, ...fileEntries];
    mergedSymbols = [...preservedSymbols, ...symbols];

    // Snapshot: preserve out-of-scope shas, overlay walked ones.
    mergedSnapshotFiles = {};
    if (oldSnapshot) {
      for (const relPath of preservedFilePaths) {
        const sha = oldSnapshot.files[relPath];
        if (sha !== undefined) mergedSnapshotFiles[relPath] = sha;
      }
    }
    Object.assign(mergedSnapshotFiles, newSnapshotFiles);
  }


  return { mergedSymbols, mergedEntries, mergedSnapshotFiles };
}
