import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

export async function parseFile(
  filePath: string,
  source: string,
): Promise<Parser.Tree | null> {
  const ext = path.extname(filePath);
  const language = getLanguageForExtension(ext);
  if (!language) return null;

  const parser = await getParser(language);
  if (!parser) return null;

  return parser.parse(source);
}
