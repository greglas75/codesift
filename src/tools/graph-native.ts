import type { CodeSymbol } from "../types.js";
import { getNativeCore, type NativeCallGraphHandle } from "../native/index.js";
import { loadConfig } from "../config.js";
import { resolveRegisteredRepoMeta } from "../storage/registry.js";
import { resolveIndexBackend, sqlitePathFor } from "../storage/index-migration.js";
import { getDataVersion } from "../storage/sqlite/accessors.js";

/**
 * The call graph built by the Rust core (ADR-006 stage 7), served through the `.get(id)` shape every
 * consumer of `buildAdjacencyIndex` uses.
 *
 * The TypeScript build scans every symbol's source with three regexes on the main thread: measured on
 * a 454,892-symbol index, 4.1 s with tests skipped and 11.7 s / 28.3M edges / +1.17 GB of heap with
 * them included — paid again on every trace_call_chain, impact_analysis and trace_route. Here the
 * graph is built off the main thread, held in Rust memory as node positions, and cached until the
 * database's `data_version` moves.
 *
 * Exactness: nodes are positions in rowid order, which is the order `index.symbols` is loaded in. That
 * is checked, not assumed — the core hashes every id in node order and this file recomputes the hash
 * over the caller's array before mapping a single position onto it. A resident index patched in place,
 * or one read at another `data_version`, fails the check and the caller builds in TypeScript as before.
 *
 * Only with the native store on: the graph reads the database through the core's own SQLite, and two
 * SQLite copies on one file in one process is the corruption hazard stage 1 exists to remove.
 */

export interface AdjacencyLookup {
  get(id: string): CodeSymbol[] | undefined;
}

export interface NativeAdjacency {
  callees: AdjacencyLookup;
  callers: AdjacencyLookup;
}

interface CachedGraph {
  version: number;
  graph: Promise<NativeCallGraphHandle>;
  /** Set once the build finished — what `/health` reads, so it never waits on a build in flight. */
  built?: NativeCallGraphHandle;
}

/** Graphs by `dbPath|skipTests|filterReactHooks`, newest last; a handful at most. */
const graphs = new Map<string, CachedGraph>();
const MAX_GRAPHS = 4;

/**
 * Free an evicted graph's Rust memory. V8 cannot see those bytes, so leaving it to the wrapper's GC
 * could keep gigabytes alive; the delay lets a call already holding this graph finish with it.
 */
const RELEASE_DELAY_MS = 60_000;
/**
 * At most ONE retired graph waits out its delay. Under version churn — an agent editing a big repo,
 * each edit moving `data_version` — every graph call retires the previous build, and a 60 s grace per
 * graph would hold several 380 MB graphs at once (raised by the review of 1f681871). A newer retirement
 * releases the one already waiting, so the bound is MAX_GRAPHS + 1.
 */
let waiting: { graph: NativeCallGraphHandle; timer: NodeJS.Timeout } | null = null;
function retire(entry: CachedGraph): void {
  entry.graph.then((g) => {
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.graph.release();
    }
    const timer = setTimeout(() => {
      g.release();
      if (waiting?.graph === g) waiting = null;
    }, RELEASE_DELAY_MS);
    timer.unref();
    waiting = { graph: g, timer };
  }, () => undefined);
}

/** Which symbol arrays a graph has been proven to describe (node order = array order). */
const verified = new WeakMap<NativeCallGraphHandle, WeakSet<CodeSymbol[]>>();

const FNV_OFFSET = 0x811c9dc5;
const ALT_OFFSET = 0x5bd1e995;
const FNV_PRIME = 0x01000193;

/** The core's `hash_ids`: FNV-1a 32 twice (two offsets) over each id's UTF-16 units, NUL-separated. */
export function hashSymbolIds(symbols: readonly CodeSymbol[]): [number, number] {
  let a = FNV_OFFSET;
  let b = ALT_OFFSET;
  for (const sym of symbols) {
    const id = sym.id;
    for (let i = 0; i <= id.length; i++) {
      const unit = i < id.length ? id.charCodeAt(i) : 0;
      a = Math.imul(a ^ unit, FNV_PRIME) >>> 0;
      b = Math.imul(b ^ unit, FNV_PRIME) >>> 0;
    }
  }
  return [a, b];
}

function describes(graph: NativeCallGraphHandle, symbols: CodeSymbol[]): boolean {
  // The length first, every time: a proven array that has since grown or shrunk must not pass on the
  // strength of an earlier proof.
  if (graph.nodeCount !== symbols.length) return false;
  let proven = verified.get(graph);
  if (proven?.has(symbols)) return true;
  const [a, b] = hashSymbolIds(symbols);
  const [ga, gb] = graph.idHash();
  if (a !== ga || b !== gb) return false;
  if (!proven) {
    proven = new WeakSet();
    verified.set(graph, proven);
  }
  proven.add(symbols);
  return true;
}

function lookup(symbols: CodeSymbol[], fetch: (id: string) => Uint32Array | null): AdjacencyLookup {
  // Memoised per id, like the TypeScript Map: repeated `get`s of one id return the same array.
  const memo = new Map<string, CodeSymbol[] | undefined>();
  return {
    get(id: string): CodeSymbol[] | undefined {
      if (memo.has(id)) return memo.get(id);
      // A graph released under a long call answers by throwing; surface it as a storage-shaped error
      // rather than a wrong empty adjacency.
      const positions = fetch(id);
      const out = positions === null ? undefined : Array.from(positions, (i) => symbols[i]!);
      memo.set(id, out);
      return out;
    },
  };
}

/**
 * The native graph of `repo`'s index for these options, built (or reused) at the database's current
 * `data_version` — or `null` when it cannot be used: no core, the native store off, the JSON backend,
 * an unknown repo, or a failed build. `null` always means "do it in TypeScript".
 */
export async function nativeGraphFor(
  repo: string,
  skipTests: boolean,
  filterReactHooks: boolean,
): Promise<NativeCallGraphHandle | null> {
  const core = getNativeCore("store");
  if (!core || typeof core.buildCallGraph !== "function") return null;
  if ((await resolveIndexBackend()) !== "sqlite") return null;
  const resolved = await resolveRegisteredRepoMeta(loadConfig().registryPath, repo);
  if (!resolved) return null;
  const dbPath = sqlitePathFor(resolved.meta.index_path);

  const key = `${dbPath}|${skipTests ? 1 : 0}|${filterReactHooks ? 1 : 0}`;
  try {
    const version = await getDataVersion(dbPath);
    let entry = graphs.get(key);
    if (!entry || entry.version !== version) {
      if (entry) retire(entry);
      const fresh: CachedGraph = { version, graph: core.buildCallGraph(dbPath, skipTests, filterReactHooks) };
      fresh.graph.then((g) => { fresh.built = g; }, () => undefined);
      entry = fresh;
    }
    graphs.delete(key);
    graphs.set(key, entry); // most recently used last
    while (graphs.size > MAX_GRAPHS) {
      const oldest = graphs.keys().next().value!;
      retire(graphs.get(oldest)!);
      graphs.delete(oldest);
    }
    return await entry.graph;
  } catch {
    // A failed build must not stay cached as this key's answer.
    graphs.delete(key);
    return null;
  }
}

/**
 * The native graph for `repo` mapped onto `symbols`, or `null` when it cannot be used — including
 * `symbols` not matching the graph's node order. `null` means "build it in TypeScript", never "no edges".
 */
export async function nativeAdjacency(
  repo: string,
  symbols: CodeSymbol[],
  skipTests: boolean,
  filterReactHooks: boolean,
): Promise<NativeAdjacency | null> {
  const graph = await nativeGraphFor(repo, skipTests, filterReactHooks);
  if (!graph || !describes(graph, symbols)) return null;
  return {
    callees: lookup(symbols, (id) => graph.callees(id)),
    callers: lookup(symbols, (id) => graph.callers(id)),
  };
}

/** The symbols at these node positions, in order — from the store, checked against the graph's ids. */
export async function graphSymbolsAt(
  graph: NativeCallGraphHandle,
  positions: readonly number[],
  withSource: boolean,
): Promise<CodeSymbol[]> {
  if (positions.length === 0) return [];
  const chunks = await graph.symbolsJson(Uint32Array.from(positions), withSource);
  const out: CodeSymbol[] = [];
  for (const chunk of chunks) for (const sym of JSON.parse(chunk) as CodeSymbol[]) out.push(sym);
  return out;
}

/** For `/health`: resident graphs and their bytes as the core counts them (finished builds only). */
export function nativeGraphCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of graphs.values()) bytes += entry.built?.footprintBytes() ?? 0;
  return { entries: graphs.size, bytes };
}

export function resetNativeGraphsForTesting(): void {
  graphs.clear();
}
