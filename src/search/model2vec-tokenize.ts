// Model2Vec tokenization helpers — extracted from static-embedding-provider.ts.
//
// All logic here is pure (no I/O, no caching). The provider imports these to
// keep its own line count inside the project's 100-exec-line cap.

/**
 * Parse a HF tokenizer.json vocab map, tolerating both the nested WordPiece shape
 * `{ model: { vocab: {...} } }` and the flat `{ vocab: {...} }` shape. Throws a
 * descriptive error when no usable map is present (CQ8: external file, validated).
 */
export function parseVocab(raw: unknown): Map<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("static-embedding: tokenizer.json must be a JSON object");

  const obj = raw as Record<string, unknown>;
  const model = obj["model"];
  const nested =
    model && typeof model === "object" && !Array.isArray(model)
      ? (model as Record<string, unknown>)["vocab"]
      : undefined;
  const flat = obj["vocab"];
  const vocabRaw = nested ?? flat;

  if (!vocabRaw || typeof vocabRaw !== "object" || Array.isArray(vocabRaw))
    throw new Error("static-embedding: tokenizer.json missing a usable vocab map");

  const vocab = new Map<string, number>();
  for (const [token, id] of Object.entries(vocabRaw as Record<string, unknown>)) {
    if (typeof id === "number" && Number.isInteger(id) && id >= 0) {
      vocab.set(token, id);
    }
  }
  if (vocab.size === 0)
    throw new Error("static-embedding: tokenizer.json vocab map is empty");
  return vocab;
}

// Bound the max-munch window: the longest vocab key (minus any "##" prefix) per
// vocab, computed once and memoized so repeated tokenize calls don't rescan.
const maxKeyLenCache = new WeakMap<Map<string, number>, number>();
function maxKeyLen(vocab: Map<string, number>): number {
  const cached = maxKeyLenCache.get(vocab);
  if (cached !== undefined) return cached;
  let max = 1;
  for (const k of vocab.keys()) {
    const len = k.startsWith("##") ? k.length - 2 : k.length;
    if (len > max) max = len;
  }
  maxKeyLenCache.set(vocab, max);
  return max;
}

// Code-aware pre-split: lowercase, break camelCase/PascalCase boundaries, split
// on snake_case/kebab/whitespace, and keep punctuation/symbol runs as their own
// candidate tokens (each char) instead of silently deleting them.
function preSplit(text: string): string[] {
  const withBoundaries = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // HTTPServer → HTTP Server
  const out: string[] = [];
  // Words (letters+digits+combining marks) OR single punctuation/symbol chars.
  // Underscores and hyphens act as word-separators AND are emitted as candidate
  // punctuation tokens (matched when in vocab, OOV-dropped otherwise).
  // Underscores are silently dropped (not emitted); hyphens are emitted as
  // candidates so a "-" vocab entry is reachable.
  const re = /[\p{L}\p{M}\p{N}]+|[\p{P}\p{S}]/gu;
  for (const m of withBoundaries.toLowerCase().matchAll(re)) {
    const tok = m[0];
    if (tok !== "_") out.push(tok);
  }
  return out;
}

// Greedy longest-match (max-munch) subword split of one word against the vocab,
// honoring WordPiece "##" continuation for non-initial pieces. Unmatched
// positions skip one char (don't abandon the whole word). Fully-unmatched word
// contributes nothing. Returns matched ids (after the id<rows guard).
function munch(word: string, vocab: Map<string, number>, rows: number, window: number): number[] {
  const fast = vocab.get(word); // whole-word fast path wins over decomposition
  if (fast !== undefined && fast < rows) return [fast]; // OOB id → fall through to munch

  const ids: number[] = [];
  let pos = 0;
  while (pos < word.length) {
    let matched = -1;
    let end = Math.min(word.length, pos + window);
    for (; end > pos; end--) {
      const sub = word.slice(pos, end);
      const key = pos === 0 ? sub : "##" + sub;
      const id = vocab.get(key);
      if (id !== undefined && id < rows) {
        ids.push(id);
        matched = end;
        break;
      }
    }
    pos = matched === -1 ? pos + 1 : matched; // skip one char on no match
  }
  return ids;
}

/**
 * Code-aware pre-split + greedy longest-match (max-munch) SUBWORD tokenization.
 * Real Model2Vec/potion vocabs are subword vocabs, so naive whole-word lookup
 * would catastrophically OOV. Whole words are tried first (fast path); otherwise
 * each word is split into the longest vocab pieces, honoring the WordPiece "##"
 * continuation convention. OOV pieces (and ids outside the matrix) are skipped,
 * not errored. Returns the matched row indices in order.
 */
export function tokenize(text: string, vocab: Map<string, number>, rows: number): number[] {
  text = text.normalize("NFC"); // ensure combining marks are composed before split
  const window = maxKeyLen(vocab);
  const ids: number[] = [];
  for (const word of preSplit(text)) {
    for (const id of munch(word, vocab, rows, window)) ids.push(id);
  }
  return ids;
}

/**
 * Mean-pool the matched rows, then L2-normalize. With no matched rows (empty /
 * OOV-only input) the mean is the zero vector; normalization leaves it zero
 * (never divides by zero — guards against NaN).
 */
export function embedOne(
  rowIds: number[],
  matrix: Float32Array,
  cols: number,
): number[] {
  const acc = new Array<number>(cols).fill(0);

  for (const rowId of rowIds) {
    const base = rowId * cols;
    for (let c = 0; c < cols; c++) acc[c]! += matrix[base + c]!;
  }
  if (rowIds.length > 0) {
    for (let c = 0; c < cols; c++) acc[c]! /= rowIds.length;
  }

  let normSq = 0;
  for (const v of acc) normSq += v * v;
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let c = 0; c < cols; c++) acc[c]! /= norm;
  }
  return acc;
}
