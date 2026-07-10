export const DEFAULT_MAX_TEXT_MATCHES = 200;
export const MAX_WALK_FILES = 50_000;
export const SEARCH_TIMEOUT_MS = 30_000;

export const SEARCH_TEXT_WALL_CLOCK_MS = (() => {
  const env = process.env["CODESIFT_SEARCH_TEXT_CAP_MS"];
  const parsed = env ? Number(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();

export const RIPGREP_TIMEOUT_MS = Math.min(SEARCH_TIMEOUT_MS, SEARCH_TEXT_WALL_CLOCK_MS);

export const AUTO_GROUP_THRESHOLD = 50;
export const SERVER_AUTO_GROUP_THRESHOLD = 30;
export const MAX_RESPONSE_CHARS = 80_000;
export const MAX_SYMBOL_RESULTS = 1000;
export const MAX_TEXT_RESULTS = 1000;
export const MAX_CONTEXT_LINES = 20;
export const MAX_FIRST_MATCH_CHARS = 300;
export const MAX_LINE_CHARS = 500;
export const DEFAULT_TOP_K_WITH_SOURCE = 10;
export const BM25_FILTER_MULTIPLIER = 5;
export const BM25_FILTER_MIN_K = 200;
export const IDENTIFIER_QUERY_RX = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;
export const DEFAULT_SOURCE_CHARS_NARROW = 200;
export const DEFAULT_SOURCE_CHARS_WIDE = 500;
export const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_MAX_REGEX_RESULTS = 50;
export const JSON_OVERHEAD_PER_MATCH = 40;
export const SERVER_AUTO_COMPACT_THRESHOLD = 12;

export const REDOS_PATTERNS = [
  /\(.*[+*].*\)[+*]/,
  /\(.*\|.*\)[+*]/,
  /\(.*[+*].*\)\{/,
  /\([^)]*\\[dDwWsS][+*].*\)[+*]/,
];

export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".o", ".obj",
  ".wasm", ".class", ".pyc", ".pyo",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".db", ".sqlite", ".sqlite3", ".lock",
]);

export const RG_EXCLUDE_DIRS = [
  "node_modules", ".git", ".next", "dist", ".codesift", "coverage",
  ".playwright-mcp", "__pycache__", ".mypy_cache", ".tox",
];

export const ZERO_HIT_SUGGESTION_CAP = 5;
export const ZERO_HIT_SEMANTIC_TOP_K = 5;
export const ZERO_HIT_SEMANTIC_CAP_MS = 4000;
export const ZERO_HIT_EDIT_DISTANCE_MAX = 2;
export const ZERO_HIT_MIN_QUERY_LEN = 3;
