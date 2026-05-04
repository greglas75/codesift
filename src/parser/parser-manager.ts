import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { STUB_LANGUAGES } from "./stub-languages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let initialized = false;
const parserCache = new Map<string, Parser>();

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".css": "css",
  ".json": "config",
  ".prisma": "prisma",
  ".astro": "astro",
  ".jsonl": "conversation",
  ".env": "config",
  ".yaml": "config",
  ".yml": "config",
  ".toml": "config",
  ".ini": "config",
  ".properties": "config",
  // --- Unparsed source languages ---
  // These extensions are indexed (file appears in get_file_tree, search_text,
  // scan_secrets) but no symbol extraction happens — tree-sitter grammars
  // are not shipped yet. Add a real extractor in src/parser/extractors/
  // and a .wasm grammar in src/parser/languages/ to enable symbol support.
  ".kt": "kotlin",       // Kotlin
  ".kts": "kotlin",      // Kotlin script
  ".swift": "text_stub", // Swift
  ".dart": "text_stub",  // Dart/Flutter
  ".scala": "text_stub", // Scala
  ".clj": "text_stub",   // Clojure
  ".cljs": "text_stub",  // ClojureScript
  ".ex": "text_stub",    // Elixir
  ".exs": "text_stub",   // Elixir script
  ".lua": "text_stub",   // Lua
  ".zig": "text_stub",   // Zig
  ".nim": "text_stub",   // Nim
  ".gradle": "text_stub", // Gradle build scripts
  ".sbt": "text_stub",   // SBT build scripts
  // --- SQL (regex extractor, no tree-sitter) ---
  ".sql": "sql",          // SQL DDL/DML
};

export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

export async function getParser(language: string): Promise<Parser | null> {
  const cached = parserCache.get(language);
  if (cached) return cached;

  await initParser();

  const wasmPath = path.join(
    __dirname,
    "languages",
    `tree-sitter-${language}.wasm`,
  );

  try {
    const lang = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(lang);
    parserCache.set(language, parser);
    return parser;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[parser] WASM grammar not available for ${language}: ${message}`);
    return null;
  }
}

export function getLanguageForExtension(ext: string): string | null {
  return EXTENSION_MAP[ext] ?? null;
}

/**
 * Full-path language resolver. Checks multi-dot suffixes first (e.g.
 * `.gradle.kts` beats `.kts`) so build scripts can be routed to a dedicated
 * extractor while regular `.kts` scripts still use the plain Kotlin pipeline.
 *
 * Returns the language string or null if the path has no recognized
 * extension / suffix.
 */
export function getLanguageForPath(filePath: string): string | null {
  // Multi-dot suffix table — longest match wins. Keep this list small; any
  // entry here represents a file format that shares a primary extension with
  // another format but needs a different extractor.
  if (filePath.endsWith(".gradle.kts")) return "gradle-kts";

  const ext = path.extname(filePath);
  return EXTENSION_MAP[ext] ?? null;
}

/**
 * Languages that do NOT produce structured symbols through the normal parser
 * pipeline. A `FileEntry.language` falling in this set means the file is only
 * indexed via its file entry + ripgrep + secret scanning — symbol tools
 * (search_symbols, get_file_outline, etc.) will return empty results for it.
 *
 * Used by the H11 hint to warn agents when symbol queries come back empty
 * because of missing parsers, rather than because of a legitimately empty
 * search space.
 *
 * Note: this set must NOT contain any language that has a real tree-sitter
 * extractor. When a new parser is added (e.g. kotlin → full extractor), its
 * language string must be removed from here so H11 stops firing for those
 * files.
 */
export { STUB_LANGUAGES } from "./stub-languages.js";

/**
 * Returns true when the given `FileEntry.language` value is known to produce
 * structured symbols (i.e. not in `STUB_LANGUAGES`). This is the dynamic
 * lookup used by H11 — adding a new parser to EXTENSION_MAP with any string
 * outside STUB_LANGUAGES automatically opts it out of the H11 warning.
 */
export function languageHasParser(language: string): boolean {
  return !STUB_LANGUAGES.has(language);
}

/**
 * Default per-file parse timeout. Tree-sitter is synchronous and can hang on
 * pathological inputs (deeply nested AST, malformed source). 30s is generous
 * for normal files; anything slower likely indicates a parser bug or a file
 * that should be skipped. Override via CODESIFT_PARSE_TIMEOUT_MS env var.
 */
export const DEFAULT_PARSE_TIMEOUT_MS = 30_000;

function getParseTimeoutMs(): number {
  const envVal = process.env.CODESIFT_PARSE_TIMEOUT_MS;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PARSE_TIMEOUT_MS;
}

export async function parseFile(
  filePath: string,
  source: string,
  options?: { timeoutMs?: number },
): Promise<Parser.Tree | null> {
  // Gradle KTS files share the Kotlin tree-sitter grammar but route through
  // a dedicated symbol extractor. parseFile() only needs a parser, so fall
  // back to the Kotlin parser here — the extractor split happens in
  // symbol-extractor.ts via the `gradle-kts` language case.
  const language = getLanguageForPath(filePath) === "gradle-kts"
    ? "kotlin"
    : getLanguageForExtension(path.extname(filePath));
  if (!language) return null;

  const parser = await getParser(language);
  if (!parser) return null;

  const timeoutMs = options?.timeoutMs ?? getParseTimeoutMs();

  try {
    // Check parse cache first — Python files are parsed twice per index
    // (symbols + imports), so caching the tree saves a second tree-sitter
    // walk. Other languages are also cacheable but currently parse once.
    // Uses dynamic import to avoid a circular dep (parse-cache imports
    // Parser type, parser-manager depends on parse-cache for cache hits).
    const { getCachedParse, setCachedParse } = await import("./parse-cache.js");
    const cached = getCachedParse(language, source);
    if (cached) return cached;

    // tree-sitter parser.parse() is synchronous. Promise.race against a
    // setTimeout protects against pathological inputs that hang the parser
    // (e.g. deeply nested expressions, certain malformed sources). The actual
    // parse still blocks the event loop while running — this only releases
    // the awaiter so the indexer can move on. A genuinely hung parse leaks
    // CPU until the process exits, but that beats the alternative of stalling
    // the entire indexer indefinitely.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<null>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`parse timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const parsePromise = (async () => parser.parse(source))();

    let tree: Parser.Tree;
    try {
      tree = (await Promise.race([parsePromise, timeoutPromise])) as Parser.Tree;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (!tree) return null;
    setCachedParse(language, source, tree);
    return tree;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[parser] Parse error in ${filePath}: ${message}`);
    return null;
  }
}
