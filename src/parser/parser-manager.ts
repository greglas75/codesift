import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let initialized = false;
const parserCache = new Map<string, Parser>();

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".md": "markdown",
  ".markdown": "markdown",
  ".css": "css",
  ".json": "json",
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
  } catch {
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
