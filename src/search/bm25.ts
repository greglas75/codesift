import { totalmem } from "node:os";
import { tokenizeIdentifier } from "../parser/symbol-utils.js";
import { isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, SearchResult } from "../types.js";
import { getNativeCore, type NativeBm25Handle } from "../native/index.js";

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

const BODY_CHAR_LIMIT = 500;

/**
 * Score multiplier for symbols in test files.
 * Demotes test helpers so production code ranks higher in search results.
 * 0.3 = test symbols score 30% of equivalent production symbols.
 */
const TEST_FILE_SCORE_MULTIPLIER = 0.3;

type FieldName = "name" | "signature" | "docstring" | "body" | "comments";

/**
 * The TypeScript index. Its maps ARE the index, and they live on the V8 heap — measured at 32.5 B per
 * token, ~500 MB for the largest repo here, which is what the native index below moves out.
 */
export interface TsBM25Index {
  /** Per-field inverted index: token -> Map<symbolId, termFrequency> */
  fields: Record<FieldName, Map<string, Map<string, number>>>;
  /** Per-field average document length (in tokens) */
  avgFieldLengths: Record<FieldName, number>;
  /** Total number of indexed documents */
  docCount: number;
  /** Symbol lookup by ID */
  symbols: Map<string, CodeSymbol>;
  /** Import centrality: file -> log-scaled importer count (for search ranking bonus) */
  centrality: Map<string, number>;
  /** Pre-computed per-document field lengths (avoids O(n*m) recomputation per search) */
  fieldLengths: Map<string, Record<FieldName, number>>;
  /**
   * Running per-field token totals. `avgFieldLengths` is derived from these, and keeping the
   * numerator lets one file's symbols be swapped without rescanning every document. Deriving it
   * back as `avg * docCount` would work on paper and accumulate float error in practice.
   */
  totalFieldLengths: Record<FieldName, number>;
}

/**
 * The same index held in Rust memory (ADR-006 stage 2), behind a handle. Only `symbols` stays in JS:
 * search results are symbol OBJECTS, and those are the very objects the loaded code index already
 * holds, so keeping the Map costs pointers, not copies. `docCount` reads through to the handle.
 */
export interface NativeBM25Index {
  readonly native: NativeBm25Handle;
  symbols: Map<string, CodeSymbol>;
  readonly docCount: number;
  /** Read by file in `search_text(ranked=true)`. Fixed after the build — updates do not recompute it
   *  in either implementation — so it is materialised once, on first read. */
  readonly centrality: Map<string, number>;
}

export type BM25Index = TsBM25Index | NativeBM25Index;

/**
 * Whether builds produce native indexes. Callers that would otherwise RESTORE a TypeScript index
 * from the sidecar check this first: loading that file rebuilds the very heap maps stage 2 moves
 * out, and a native build from the symbols already in memory is the cheaper of the two anyway.
 */
export function nativeBM25Enabled(): boolean {
  return getNativeCore("bm25") !== null;
}

export function isNativeBM25(index: BM25Index): index is NativeBM25Index {
  return (index as Partial<NativeBM25Index>).native !== undefined;
}

/** Field order the native handle takes weights in — `fieldNames` below. */
function weightsArray(w: Record<FieldName, number>): number[] {
  return [w.name, w.signature, w.docstring, w.body, w.comments];
}

/**
 * General-purpose tokenizer for signature, docstring, and body text.
 * Splits on non-alphanumeric chars, applies camelCase/snake_case splitting,
 * lowercases, and filters tokens shorter than 2 chars.
 */
export function tokenizeText(text: string): string[] {
  // Split on non-alphanumeric boundaries
  const rawParts = text.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  const tokens: string[] = [];
  for (const part of rawParts) {
    // Split camelCase / PascalCase (same logic as tokenizeIdentifier)
    const subParts = part
      .replace(/([a-z0-9])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0");

    for (const sub of subParts) {
      const lower = sub.toLowerCase();
      if (lower.length >= 2) {
        tokens.push(lower);
      }
    }
  }

  return tokens;
}

function getFieldTokens(symbol: CodeSymbol): Record<FieldName, string[]> {
  const source = symbol.source?.slice(0, BODY_CHAR_LIMIT) ?? "";
  const { code, comments } = splitCodeAndComments(source);

  return {
    name: tokenizeIdentifier(symbol.name),
    signature: symbol.signature ? tokenizeText(symbol.signature) : [],
    docstring: symbol.docstring ? tokenizeText(symbol.docstring) : [],
    body: source ? tokenizeText(code) : [],
    comments: comments ? tokenizeText(comments) : [],
  };
}

/**
 * Split source into code (logic) vs inline comments.
 * Strips single-line (//) and multi-line comments from code,
 * collects them into a separate string.
 *
 * Limitation: regex-based, so `//` inside string literals (e.g. URLs)
 * may be misclassified as comments. Acceptable for BM25 scoring where
 * a few misclassified tokens have negligible impact on ranking.
 */
function splitCodeAndComments(source: string): { code: string; comments: string } {
  const commentParts: string[] = [];
  // Match // comments and /* ... */ blocks
  const stripped = source.replace(/\/\/[^\n]*/g, (m) => {
    commentParts.push(m);
    return "";
  }).replace(/\/\*[\s\S]*?\*\//g, (m) => {
    commentParts.push(m);
    return "";
  });

  return { code: stripped, comments: commentParts.join(" ") };
}

function countTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * Symbols ingested per turn before the event loop gets one.
 *
 * Building this index is the single longest synchronous burst in the process. Measured on the
 * largest real index here (372,949 symbols, 20,132 files): **19.5 seconds during which a 20 ms
 * timer fired ZERO times**. In the shared daemon that is 19.5 seconds where nothing is answered —
 * not another client's search, not `/health` — and it is the largest single contributor to what
 * users reported as "CodeSift is down".
 *
 * The split matters for where to yield: 18.3 s of that is the tokenise-and-map loop below, and only
 * 1.2 s the import-centrality pass after it. So the ingest loop is what yields.
 */
/** Module scope now that ingestion is extracted — it was a local of the old single function. */
const fieldNames: FieldName[] = ["name", "signature", "docstring", "body", "comments"];

const SYMBOLS_PER_TURN = 2000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Mutable state the ingest loop fills; shared by the sync and yielding builders. */
interface BM25Accumulator {
  fields: Record<FieldName, Map<string, Map<string, number>>>;
  totalFieldLengths: Record<FieldName, number>;
  symbolMap: Map<string, CodeSymbol>;
  fieldLengths: Map<string, Record<FieldName, number>>;
}

function newAccumulator(): BM25Accumulator {
  return {
    fields: {
      name: new Map(), signature: new Map(), docstring: new Map(),
      body: new Map(), comments: new Map(),
    },
    totalFieldLengths: { name: 0, signature: 0, docstring: 0, body: 0, comments: 0 },
    symbolMap: new Map(),
    fieldLengths: new Map(),
  };
}

/** One symbol into the inverted index. Extracted so both builders run byte-identical work. */
function ingestSymbol(acc: BM25Accumulator, symbol: CodeSymbol): void {
  acc.symbolMap.set(symbol.id, symbol);
  const fieldTokens = getFieldTokens(symbol);
  const lengths: Record<FieldName, number> = {
    name: 0, signature: 0, docstring: 0, body: 0, comments: 0,
  };

  for (const field of fieldNames) {
    const tokens = fieldTokens[field];
    acc.totalFieldLengths[field] += tokens.length;
    lengths[field] = tokens.length;

    const tf = countTermFrequencies(tokens);
    for (const [token, freq] of tf) {
      let postings = acc.fields[field].get(token);
      if (!postings) {
        postings = new Map();
        acc.fields[field].set(token, postings);
      }
      postings.set(symbol.id, freq);
    }
  }
  acc.fieldLengths.set(symbol.id, lengths);
}

/**
 * Averages plus import centrality — 1.2 s of the 19.5 on the largest index, so it stays synchronous.
 *
 * The inner `for (const file of allFiles)` is a linear scan per import match, i.e. O(imports x files).
 * At 6% of the build it was not worth changing while fixing the blocking, but it is the obvious next
 * thing if this pass ever grows.
 */
function finishBuild(acc: BM25Accumulator, symbols: CodeSymbol[]): TsBM25Index {

  const { fields, totalFieldLengths, symbolMap, fieldLengths } = acc;
  const docCount = symbols.length;
  const avgFieldLengths: Record<FieldName, number> = {
    name: docCount > 0 ? totalFieldLengths.name / docCount : 0,
    signature: docCount > 0 ? totalFieldLengths.signature / docCount : 0,
    docstring: docCount > 0 ? totalFieldLengths.docstring / docCount : 0,
    body: docCount > 0 ? totalFieldLengths.body / docCount : 0,
    comments: docCount > 0 ? totalFieldLengths.comments / docCount : 0,
  };

  // Compute import centrality: count how many files import each file
  // Heuristic: scan symbol source for import/require patterns pointing to files in the index
  const importCount = new Map<string, number>();
  const allFiles = new Set<string>();
  for (const sym of symbols) allFiles.add(sym.file);

  for (const sym of symbols) {
    if (!sym.source) continue;
    // Quick regex for import paths (captures relative paths)
    const importRe = /from\s+['"]\.?\.\/([\w/.-]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(sym.source)) !== null) {
      const imported = match[1]!;
      // Try to match against known files
      for (const file of allFiles) {
        if (file.includes(imported)) {
          importCount.set(file, (importCount.get(file) ?? 0) + 1);
          break;
        }
      }
    }
  }

  // Log-scale centrality: avoids a single highly-imported utility from dominating
  const centrality = new Map<string, number>();
  for (const [file, count] of importCount) {
    centrality.set(file, Math.log2(1 + count));
  }

  return { fields, avgFieldLengths, docCount, symbols: symbolMap, centrality, fieldLengths, totalFieldLengths };
}

function recomputeAverages(index: TsBM25Index): void {
  const n = index.docCount;
  for (const field of fieldNames) {
    index.avgFieldLengths[field] = n > 0 ? index.totalFieldLengths[field] / n : 0;
  }
}

/**
 * Undo one symbol's contribution to the inverted index.
 *
 * No reverse token map is needed: the tokens a symbol contributed are a pure function of the
 * symbol, and the symbol itself is still in `index.symbols`. Re-deriving them is exact and costs
 * one `getFieldTokens` call, against a reverse map that would have to be kept correct forever.
 *
 * Field lengths come from the STORED record rather than the re-derived tokens, so the running
 * totals stay symmetric with what ingest actually added even if tokenisation ever changes under a
 * long-lived index.
 */
function removeSymbolFromIndex(index: TsBM25Index, symbol: CodeSymbol): void {
  const fieldTokens = getFieldTokens(symbol);
  const stored = index.fieldLengths.get(symbol.id);

  for (const field of fieldNames) {
    const tokens = fieldTokens[field];
    index.totalFieldLengths[field] -= stored ? stored[field] : tokens.length;

    const postings = index.fields[field];
    for (const token of new Set(tokens)) {
      const forToken = postings.get(token);
      if (!forToken) continue;
      forToken.delete(symbol.id);
      // A token nobody carries any more must go, or the vocabulary grows without bound across a
      // long-lived daemon and every idf denominator drifts.
      if (forToken.size === 0) postings.delete(token);
    }
  }

  index.symbols.delete(symbol.id);
  index.fieldLengths.delete(symbol.id);
  index.docCount--;
}

/**
 * Swap one file's symbols in place, instead of throwing the whole index away.
 *
 * Editing a single file used to delete the repository's entire BM25 index, and the next search
 * rebuilt it from scratch — measured 6.8 s on a 372k-symbol repository, against 952 `index_file`
 * calls in a week. The agent loop is edit-then-search, so that rebuild was being paid constantly.
 *
 * `centrality` is deliberately NOT recomputed. It is an O(imports x files) scan over every symbol
 * in the repository — the thing this function exists to avoid — and it is a ranking bonus derived
 * from a substring heuristic, not a correctness input. One file's imports moving leaves it
 * marginally stale until the next full build; a 6.8 s pause would not.
 */
export function updateBM25ForFile(index: BM25Index, file: string, symbols: CodeSymbol[]): void {
  if (isNativeBM25(index)) {
    index.native.updateFile(file, symbols);
    // The JS half mirrors the same Map operations the TypeScript path performs on `index.symbols`.
    for (const [id, existing] of [...index.symbols]) if (existing.file === file) index.symbols.delete(id);
    for (const symbol of symbols) index.symbols.set(symbol.id, symbol);
    return;
  }
  // Select by the STORED symbol's file, never by parsing the incoming ids: ids are
  // `repo:file:name:line` and are documented as non-unique, so an incoming id can collide with a
  // symbol that lives in a different file. Matching on the stored record cannot touch it.
  const stale: CodeSymbol[] = [];
  for (const existing of index.symbols.values()) {
    if (existing.file === file) stale.push(existing);
  }
  for (const symbol of stale) removeSymbolFromIndex(index, symbol);

  const acc: BM25Accumulator = {
    fields: index.fields,
    totalFieldLengths: index.totalFieldLengths,
    symbolMap: index.symbols,
    fieldLengths: index.fieldLengths,
  };
  for (const symbol of symbols) {
    ingestSymbol(acc, symbol);
    index.docCount++;
  }

  recomputeAverages(index);
}

/**
 * Synchronous build. Correct, and fine for small inputs — the tool-ranker index is ~150 entries.
 * Do NOT use it on a repository index inside the daemon: see buildBM25IndexYielding.
 */
/**
 * Bytes a BM25 index occupies, from its own token totals.
 *
 * Measured with a heapUsed delta around a real build: 352,125 symbols / 12,882,846 tokens cost
 * 399 MB, i.e. 32.5 B per token — the postings maps dominate, so tokens are the quantity to price
 * by, not symbols. Rounded UP to 40, on the same reasoning as the index footprint: over-reporting
 * evicts something that would have fitted, under-reporting silently breaks the budget. Re-measured
 * 2026-09-27 on a 344,179-symbol / 14,126,954-token index: estimate 565 MB against 498 MB actual,
 * so it still errs by 12% in the safe direction.
 *
 * It lives here, beside the structure it prices, because there are TWO caches of BM25 indexes — the
 * code one in `index-tools/state.ts` and the conversation one in `tools/conversation-cache.ts`. A
 * copy of this per cache is how their budgets drift apart.
 */
export function bm25FootprintBytes(index: BM25Index): number {
  // Measured by the allocator's own capacities rather than estimated per token.
  if (isNativeBM25(index)) return index.native.footprintBytes();
  let tokens = 0;
  for (const field of Object.keys(index.totalFieldLengths) as (keyof typeof index.totalFieldLengths)[]) {
    tokens += index.totalFieldLengths[field];
  }
  return tokens * 40;
}

/**
 * Resident budget for one BM25 cache, in bytes.
 *
 * The index budget's tiers (`indexCacheMemBudgetBytes`): 256 MB up to 16 GB of RAM, 512 MB up to 32 GB,
 * then RAM/32 between 1 GB and 8 GB. `CODESIFT_MAX_BM25_CACHE_MB` overrides.
 */
export function bm25CacheBudgetBytes(env: NodeJS.ProcessEnv = process.env, totalBytes?: number): number {
  const raw = env["CODESIFT_MAX_BM25_CACHE_MB"];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1024 * 1024;
  }
  let total = 8 * 1024 ** 3;
  try { total = totalBytes ?? totalmem(); } catch { /* keep the floor */ }
  if (!Number.isFinite(total) || total <= 0) total = 8 * 1024 ** 3;
  const totalGb = total / 1024 ** 3;
  // Above 32 GB it scales like the index budget (RAM/32, capped at 8 GB). It used to stop at 1 GB, below
  // ONE index of a 1.43M-symbol repo (1.49 GB): the cache held a single worktree, and sessions on
  // different worktrees evicted each other into a ~20 s rebuild per switch (usage.jsonl, 2026-10-10:
  // 28 of 78 rdesigner search_symbols calls over 5 s, p90 23.8 s).
  const mb = totalGb <= 16 ? 256 : totalGb <= 32 ? 512 : Math.min(8192, Math.max(1024, Math.floor(total / (1024 * 1024) / 32)));
  return mb * 1024 * 1024;
}

export function buildBM25Index(symbols: CodeSymbol[]): TsBM25Index {
  const acc = newAccumulator();
  for (const symbol of symbols) ingestSymbol(acc, symbol);
  return finishBuild(acc, symbols);
}

/**
 * Same index, built without monopolising the event loop.
 *
 * Identical work and identical output — it simply hands the loop a turn every SYMBOLS_PER_TURN
 * symbols, so other clients keep getting answers while a large repository is indexed.
 */
export async function buildBM25IndexYielding(
  symbols: CodeSymbol[],
  /** `"ts"` forces the TypeScript index — for the one caller whose job is to WRITE the sidecar
   *  (conversation persistence), since incremental passes amend that file and a native index has
   *  nothing to write. */
  opts?: { engine?: "ts" },
): Promise<BM25Index> {
  const core = opts?.engine === "ts" ? null : getNativeCore("bm25");
  if (core) return buildNativeBM25(core.NativeBm25, symbols);
  const acc = newAccumulator();
  let sinceYield = 0;
  for (const symbol of symbols) {
    ingestSymbol(acc, symbol);
    if (++sinceYield >= SYMBOLS_PER_TURN) { sinceYield = 0; await yieldToEventLoop(); }
  }
  return finishBuild(acc, symbols);
}

/**
 * The native build: same input, same batches, same yields — the tokenising moves to Rust. The
 * `symbols` Map is filled with the same `set` calls `ingestSymbol` makes, so it holds exactly the
 * entries (and the same last-wins winner per colliding id) the TypeScript index would.
 */
async function buildNativeBM25(Ctor: new () => NativeBm25Handle, symbols: CodeSymbol[]): Promise<NativeBM25Index> {
  const native = new Ctor();
  const symbolMap = new Map<string, CodeSymbol>();
  for (let i = 0; i < symbols.length; i += SYMBOLS_PER_TURN) {
    const batch = symbols.slice(i, i + SYMBOLS_PER_TURN);
    // Tokenised in parallel off the main thread; only reading the strings in happens here. Awaited
    // one batch at a time, because ingestion order is what ties are broken by.
    await native.ingestAsync(batch);
    for (const symbol of batch) symbolMap.set(symbol.id, symbol);
  }
  native.finish();
  let centrality: Map<string, number> | undefined;
  return {
    native,
    symbols: symbolMap,
    get docCount() {
      return native.docCount;
    },
    get centrality() {
      centrality ??= new Map(native.centrality());
      return centrality;
    },
  };
}

export function searchBM25(
  index: BM25Index,
  query: string,
  topK: number,
  fieldWeights: Record<FieldName, number>,
): SearchResult[] {
  if (index.docCount === 0 || !query.trim()) {
    return [];
  }

  // A field without a weight contributes nothing. Production always passes all five
  // (`config.bm25FieldWeights` is typed so), but an untyped caller passing four used to turn that
  // field's postings into NaN scores, whose sort order is unspecified — and differs between V8's sort
  // and Rust's, so the two engines could not agree on it. Zero is the only well-defined reading.
  fieldWeights = {
    name: fieldWeights.name ?? 0,
    signature: fieldWeights.signature ?? 0,
    docstring: fieldWeights.docstring ?? 0,
    body: fieldWeights.body ?? 0,
    comments: fieldWeights.comments ?? 0,
  };

  if (isNativeBM25(index)) {
    const results: SearchResult[] = [];
    for (const hit of index.native.search(query, topK, weightsArray(fieldWeights))) {
      const symbol = index.symbols.get(hit.id);
      if (!symbol) continue;
      results.push({ symbol, score: hit.score, matches: hit.matches });
    }
    return results;
  }

  const queryTokens = tokenizeText(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const fieldNames: FieldName[] = ["name", "signature", "docstring", "body", "comments"];

  // Accumulate scores per document
  const scores = new Map<string, number>();
  // Track which query tokens matched per document
  const matchedTokens = new Map<string, Set<string>>();

  // Use precomputed field lengths from index (built once at index time)
  const { fieldLengths } = index;

  for (const qToken of queryTokens) {
    for (const field of fieldNames) {
      const postings = index.fields[field].get(qToken);
      if (!postings) continue;

      const df = postings.size;
      const idf = Math.log((index.docCount - df + 0.5) / (df + 0.5) + 1);
      const avgFl = index.avgFieldLengths[field];
      const weight = fieldWeights[field];

      for (const [symbolId, tf] of postings) {
        const fl = fieldLengths.get(symbolId)?.[field] ?? 0;
        const norm = avgFl > 0 ? fl / avgFl : 1;
        const tfScore = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm));
        const fieldScore = idf * tfScore * weight;

        scores.set(symbolId, (scores.get(symbolId) ?? 0) + fieldScore);

        let tokenSet = matchedTokens.get(symbolId);
        if (!tokenSet) {
          tokenSet = new Set();
          matchedTokens.set(symbolId, tokenSet);
        }
        tokenSet.add(qToken);
      }
    }
  }

  // Centrality bonus: symbols in frequently-imported files get a tiebreaker
  const maxCentrality = Math.max(1, ...index.centrality.values());
  for (const [symbolId, score] of scores) {
    const symbol = index.symbols.get(symbolId);
    if (!symbol) continue;

    let adjusted = score;

    // Centrality: 0-10% bonus scaled by file import popularity
    const fileCentrality = index.centrality.get(symbol.file) ?? 0;
    if (fileCentrality > 0) {
      adjusted += score * 0.1 * (fileCentrality / maxCentrality);
    }

    // Demote test file symbols so production code ranks above test helpers
    if (isTestFile(symbol.file)) {
      adjusted *= TEST_FILE_SCORE_MULTIPLIER;
    }

    scores.set(symbolId, adjusted);
  }

  // Sort by score descending, take top-K
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  const results: SearchResult[] = [];
  for (const [symbolId, score] of sorted) {
    const symbol = index.symbols.get(symbolId);
    if (!symbol) continue;

    results.push({
      symbol,
      score,
      matches: [...(matchedTokens.get(symbolId) ?? [])],
    });
  }

  return results;
}

const CUTOFF_THRESHOLD = 0.15;
const CUTOFF_MIN_RESULTS = 3;

export function applyCutoff(results: SearchResult[]): SearchResult[] {
  if (results.length <= CUTOFF_MIN_RESULTS) return results;
  const topScore = results[0]?.score ?? 0;
  if (topScore <= 0) return results;
  const threshold = topScore * CUTOFF_THRESHOLD;
  for (let i = CUTOFF_MIN_RESULTS; i < results.length; i++) {
    if ((results[i]?.score ?? 0) < threshold) {
      return results.slice(0, i);
    }
  }
  return results;
}
