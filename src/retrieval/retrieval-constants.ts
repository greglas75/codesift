/** Approximate characters per token for budget estimation. */
export const CHARS_PER_TOKEN = 4;

/** Reciprocal Rank Fusion smoothing constant. */
export const RRF_K = 60;

/** Lines of proximity to consider chunks adjacent (merge threshold). */
export const ADJACENCY_GAP = 5;

/** Padding width for line numbers in formatted output. */
export const LINE_NUMBER_PAD = 6;

/** Word count threshold below which queries are not decomposed. */
export const QUERY_DECOMPOSE_THRESHOLD = 8;

/** Lower bound of the split-window (fraction of word count). */
export const SPLIT_WINDOW_LO = 0.35;

/** Upper bound of the split-window (fraction of word count). */
export const SPLIT_WINDOW_HI = 0.65;

/** Maximum sub-queries per codebaseRetrieval call. */
export const MAX_QUERIES = 20;

/** Minimum remaining token budget to include a truncated result. */
export const MIN_TRUNCATION_TOKENS = 100;

/** Default top-K results for semantic/hybrid queries. */
export const DEFAULT_TOP_K = 10;

/** Default character limit for symbol source truncation. */
export const DEFAULT_SOURCE_CHARS = 200;

/** Timeout in ms for embedding API calls (Voyage, OpenAI, Ollama). */
export const EMBED_TIMEOUT_MS = 30_000;
