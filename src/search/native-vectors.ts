/**
 * Symbol vectors in Rust memory for semantic search (ADR-006 stage 11,
 * `docs/specs/2026-10-12-native-vectors-plan.md`).
 *
 * The TypeScript path parses a repo's `.embeddings.ndjson` with `JSON.parse` per line on the daemon's
 * one thread and holds the vectors as `Float32Array`s. Measured 2026-10-12 on an rdesigner worktree
 * (462,980 × 768, 7.6 GB file): **51.8 s** to load and **691 ms** per query; the native set loads it in
 * **8.1 s** off the main thread and answers in **35 ms**, with the same ids and the same score bits
 * (`scripts/native-vectors-parity.ts`, 0 diffs there and on this repo).
 *
 * A set is keyed by the vector file's path, mtime and size, so an embedding run that rewrites the file
 * is picked up by the next query, and nothing else reloads it — `index_file` never embeds. What an
 * index edit DOES change is which ids still exist and in which file, so that half is re-attached
 * whenever the repo's embedding caches are invalidated (`markNativeVectorFilesStale`).
 *
 * Every failure here returns null, which the caller reads as "use the TypeScript path".
 */
import { stat } from "node:fs/promises";
import { vectorCacheBudgetBytes } from "../config.js";
import { getNativeCore, type NativeVectorHit, type NativeVectorsHandle } from "../native/index.js";
import { entriesOverBudget } from "../utils/cache-budget.js";

interface Entry {
  key: string;
  set: Promise<NativeVectorsHandle>;
  built?: NativeVectorsHandle;
  /** Bumped by `markNativeVectorFilesStale`; files are attached for `attachedFor`. */
  filesWanted: number;
  /** `filesWanted` and the source's `filesVersion` the attached files describe. */
  attachedFor?: string;
  attaching?: Promise<void> | undefined;
  /** Set by `retire`: a count of 0 then means "released under this call", not "an empty file". */
  retired?: boolean;
}

/** Repo name → its set. Insertion order is use order (oldest first). */
const sets = new Map<string, Entry>();
let staleCounter = 0;

function retire(entry: Entry): void {
  entry.retired = true;
  // A search in flight holds the read lock; release waits for it, then later calls answer empty.
  // Never a rejection: one left unhandled would end the daemon (a poisoned lock throws here).
  entry.set.then(
    (s) => {
      try {
        s.release();
      } catch { /* the set is unusable either way; its memory goes with the handle */ }
    },
    () => undefined,
  );
}

function footprintOf(entry: Entry): number | undefined {
  try {
    return entry.built?.footprintBytes();
  } catch {
    return undefined;
  }
}

/** The symbol ids of the index and their files, as `attachFiles` takes them. */
export type ListFiles = () => Promise<{ ids: string[]; files: string[] }>;

/** Which vectors: a repo's symbols (`set` = the repo name) or its chunks (`<repo>:chunks`). */
export interface NativeVectorSource {
  /** The cache key: the repo name for symbol vectors, `chunkSetKey(repo)` for chunk vectors. */
  set: string;
  vectorPath: string;
  rebase: { from: string; to: string } | null;
  listFiles: ListFiles;
  /**
   * Moves when ANOTHER process changed the index (SQLite `data_version`): a CLI hook's `index_file`
   * never reaches `markNativeVectorFilesStale` in the daemon. Absent = in-process invalidation only.
   */
  filesVersion?: () => Promise<number>;
}

export interface NativeVectorQuery extends NativeVectorSource {
  query: Float32Array;
  topK: number;
  contains: string | undefined;
  excludeTests: boolean;
}

/** The key of a repo's chunk vectors (`chunkCacheKey` in index-tools/state.ts spells the same). */
export function chunkSetKey(repo: string): string {
  return `${repo}:chunks`;
}

/**
 * Run `use` on the source's set, loaded (or reused), within budget and with its files attached — or
 * null when the native set cannot answer (no core, no file, no vectors in it, a failed load, attach or
 * search).
 */
async function withNativeSet<T>(src: NativeVectorSource, use: (set: NativeVectorsHandle) => Promise<T>): Promise<T | null> {
  const core = getNativeCore("vectors");
  if (!core || typeof core.loadVectors !== "function") return null;
  let key: string;
  try {
    const s = await stat(src.vectorPath);
    if (!s.isFile() || s.size === 0) return null;
    key = JSON.stringify([src.vectorPath, s.mtimeMs, s.size, src.rebase?.from ?? null, src.rebase?.to ?? null]);
  } catch {
    return null;
  }

  let entry = sets.get(src.set);
  if (!entry || entry.key !== key) {
    if (entry) retire(entry);
    const fresh: Entry = {
      key,
      set: core.loadVectors(src.vectorPath, src.rebase?.from ?? null, src.rebase?.to ?? null),
      filesWanted: ++staleCounter,
    };
    fresh.set.then((s) => { fresh.built = s; }, () => undefined);
    entry = fresh;
  }
  sets.delete(src.set);
  sets.set(src.set, entry);

  let set: NativeVectorsHandle;
  try {
    set = await entry.set;
    const sizes = [...sets].map(([k, e]) => ({ key: k, bytes: footprintOf(e) }));
    for (const evict of entriesOverBudget(sizes, vectorCacheBudgetBytes(), src.set)) {
      const evicted = sets.get(evict);
      if (!evicted) continue;
      retire(evicted);
      sets.delete(evict);
    }
    // A released set (evicted by another call, or idle release) answers as empty with width 0, which
    // a caller would read as "vectors of another width". It is a failure of this path, not an answer.
    if (entry.retired) throw new Error("the set was released during this call");
  } catch (err) {
    return dropAfterFailure(src.set, entry, err);
  }
  // A file that holds no vectors stays cached: reloading and logging it on every query buys nothing.
  if (set.count === 0 || set.dims === 0) return null;
  try {
    await ensureFiles(entry, set, src);
    if (entry.retired) return null; // released while the files were attached
  } catch (err) {
    // The set loaded fine; only the file list failed (e.g. SQLITE_BUSY behind an indexer's write).
    // Keep the set — dropping it would turn a transient lock into a multi-second reload — and answer
    // through the TypeScript path this once; the next call retries the attach.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codesift] native vectors for ${src.set}: attaching files failed (${message}) — using the TypeScript path`);
    return null;
  }
  try {
    const out = await use(set);
    // Released under the search: what it returned (no hits, width 0) describes the release, not
    // the vectors. The TypeScript path answers this call.
    return entry.retired ? null : out;
  } catch (err) {
    return dropAfterFailure(src.set, entry, err);
  }
}

/** A failed load or search drops the set, so the next call loads it again rather than reusing it. */
function dropAfterFailure(setKey: string, entry: Entry, err: unknown): null {
  if (sets.get(setKey) === entry) {
    retire(entry);
    sets.delete(setKey);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[codesift] native vectors for ${setKey} unavailable (${message}) — using the TypeScript path`);
  return null;
}

/** `{ hits, dims }` of `searchSemantic`, or null when the native set cannot answer. */
export async function searchNativeVectors(q: NativeVectorQuery): Promise<{ hits: NativeVectorHit[]; dims: number } | null> {
  return withNativeSet(q, async (set) => {
    // Read before the search: a release racing it leaves the set reporting width 0 afterwards.
    const dims = set.dims;
    if (dims !== q.query.length) return { hits: [], dims };
    const hits = await set.searchAsync(q.query, q.topK, q.contains ?? null, q.excludeTests);
    return { hits, dims };
  });
}

export interface NativeRrfQuery extends NativeVectorSource {
  queries: Float32Array[];
  topK: number;
  contains: string | undefined;
  excludeTests: boolean;
  /** Contributions added after the queries' fusion, in order (a hybrid query's text matches). */
  extra: ReadonlyArray<readonly [string, number]>;
}

/** The fused top ids (`computeRRFScores` + extras + the stable cut) and the stored width, or null. */
export async function rankNativeRrf(q: NativeRrfQuery): Promise<{ ids: string[]; dims: number } | null> {
  return withNativeSet(q, async (set) => {
    // A query of another width adds nothing, as in `computeRRFScores`; the caller reads `dims`.
    const dims = set.dims;
    const hits = await set.searchRrfAsync(
      q.queries, q.topK, q.contains ?? null, q.excludeTests,
      q.extra.map(([id]) => id), q.extra.map(([, score]) => score),
    );
    return { ids: hits.map((h) => h.id), dims };
  });
}

async function ensureFiles(entry: Entry, set: NativeVectorsHandle, src: NativeVectorSource): Promise<void> {
  const version = src.filesVersion ? await src.filesVersion() : 0;
  const wantedKey = () => `${entry.filesWanted}|${version}`;
  while (entry.attachedFor !== wantedKey()) {
    if (entry.attaching) {
      await entry.attaching;
      continue;
    }
    const wanted = wantedKey();
    entry.attaching = (async () => {
      const { ids, files } = await src.listFiles();
      await set.attachFilesAsync(ids.join("\0"), files.join("\0"));
      entry.attachedFor = wanted;
    })();
    try {
      await entry.attaching;
    } finally {
      entry.attaching = undefined;
    }
  }
}

/** The repo's symbols changed (an edit, a reindex): attach their files again before the next search. */
export function markNativeVectorFilesStale(repo: string): void {
  for (const key of [repo, chunkSetKey(repo)]) {
    const entry = sets.get(key);
    if (entry) entry.filesWanted = ++staleCounter;
  }
}

/** The repo was removed or its index invalidated: free its sets now rather than at the next eviction. */
export function dropNativeVectors(repo: string): void {
  for (const key of [repo, chunkSetKey(repo)]) {
    const entry = sets.get(key);
    if (!entry) continue;
    retire(entry);
    sets.delete(key);
  }
}

/** Free every set now (idle release). */
export function releaseNativeVectors(): number {
  const n = sets.size;
  for (const entry of sets.values()) retire(entry);
  sets.clear();
  return n;
}

/** For `/health`: resident sets and their bytes as the core counts them (finished loads only). */
export function nativeVectorCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of sets.values()) bytes += footprintOf(entry) ?? 0;
  return { entries: sets.size, bytes };
}

export function resetNativeVectorsForTesting(): void {
  releaseNativeVectors();
}
