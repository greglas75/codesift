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
  attachedFor?: number;
  attaching?: Promise<void> | undefined;
}

/** Repo name → its set. Insertion order is use order (oldest first). */
const sets = new Map<string, Entry>();
let staleCounter = 0;

function retire(entry: Entry): void {
  // A search in flight holds the read lock; release waits for it, then later calls answer empty.
  entry.set.then((s) => s.release(), () => undefined);
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

export interface NativeVectorQuery {
  repo: string;
  vectorPath: string;
  rebase: { from: string; to: string } | null;
  listFiles: ListFiles;
  query: Float32Array;
  topK: number;
  contains: string | undefined;
  excludeTests: boolean;
}

/** `{ hits, dims }`, or null when the native set cannot answer (no core, no file, a failed load). */
export async function searchNativeVectors(q: NativeVectorQuery): Promise<{ hits: NativeVectorHit[]; dims: number } | null> {
  const core = getNativeCore("vectors");
  if (!core || typeof core.loadVectors !== "function") return null;
  let key: string;
  try {
    const s = await stat(q.vectorPath);
    if (!s.isFile() || s.size === 0) return null;
    key = `${q.vectorPath}|${s.mtimeMs}|${s.size}|${q.rebase ? `${q.rebase.from}>${q.rebase.to}` : ""}`;
  } catch {
    return null;
  }

  let entry = sets.get(q.repo);
  if (!entry || entry.key !== key) {
    if (entry) retire(entry);
    const fresh: Entry = {
      key,
      set: core.loadVectors(q.vectorPath, q.rebase?.from ?? null, q.rebase?.to ?? null),
      filesWanted: ++staleCounter,
    };
    fresh.set.then((s) => { fresh.built = s; }, () => undefined);
    entry = fresh;
  }
  sets.delete(q.repo);
  sets.set(q.repo, entry);

  try {
    const set = await entry.set;
    const sizes = [...sets].map(([k, e]) => ({ key: k, bytes: footprintOf(e) }));
    for (const evict of entriesOverBudget(sizes, vectorCacheBudgetBytes(), q.repo)) {
      const evicted = sets.get(evict);
      if (!evicted) continue;
      retire(evicted);
      sets.delete(evict);
    }
    if (set.dims !== q.query.length) return { hits: [], dims: set.dims };
    await ensureFiles(entry, set, q.listFiles);
    const hits = await set.searchAsync(q.query, q.topK, q.contains ?? null, q.excludeTests);
    return { hits, dims: set.dims };
  } catch (err) {
    // A failed load must not stay cached as this repo's answer; a released set (evicted mid-call)
    // answers through the TypeScript path this once.
    if (sets.get(q.repo) === entry) {
      retire(entry);
      sets.delete(q.repo);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codesift] native vectors for ${q.repo} unavailable (${message}) — using the TypeScript path`);
    return null;
  }
}

async function ensureFiles(entry: Entry, set: NativeVectorsHandle, listFiles: ListFiles): Promise<void> {
  while (entry.attachedFor !== entry.filesWanted) {
    if (entry.attaching) {
      await entry.attaching;
      continue;
    }
    const wanted = entry.filesWanted;
    entry.attaching = (async () => {
      const { ids, files } = await listFiles();
      set.attachFiles(ids, files);
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
  const entry = sets.get(repo);
  if (entry) entry.filesWanted = ++staleCounter;
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
