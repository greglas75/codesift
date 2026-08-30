import { tokenizeIdentifier } from "../parser/symbol-utils.js";
import { isTestFile } from "../utils/test-file.js";
import type { CodeSymbol, SearchResult } from "../types.js";

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

export interface BM25Index {
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
function finishBuild(acc: BM25Accumulator, symbols: CodeSymbol[]): BM25Index {

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

function recomputeAverages(index: BM25Index): void {
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
function removeSymbolFromIndex(index: BM25Index, symbol: CodeSymbol): void {
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
export function buildBM25Index(symbols: CodeSymbol[]): BM25Index {
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
export async function buildBM25IndexYielding(symbols: CodeSymbol[]): Promise<BM25Index> {
  const acc = newAccumulator();
  let sinceYield = 0;
  for (const symbol of symbols) {
    ingestSymbol(acc, symbol);
    if (++sinceYield >= SYMBOLS_PER_TURN) { sinceYield = 0; await yieldToEventLoop(); }
  }
  return finishBuild(acc, symbols);
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
