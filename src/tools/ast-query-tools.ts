import { getParser, initParser } from "../parser/parser-manager.js";
import { getCodeIndex } from "./index-tools.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Parser from "web-tree-sitter";

const MAX_MATCHES = 50;
const MAX_FILE_SIZE = 500_000;

export interface AstMatch {
  file: string;
  start_line: number;
  end_line: number;
  text: string;
  captures: Record<string, string>;
}

export interface AstQueryResult {
  matches: AstMatch[];
  files_scanned: number;
  truncated: boolean;
}

/**
 * Search for AST patterns using tree-sitter query language.
 *
 * Examples:
 *   `(function_declaration name: (identifier) @name)` — find all function declarations
 *   `(try_statement handler: (catch_clause body: (statement_block) @body))` — find catch blocks
 *   `(call_expression function: (identifier) @fn (#eq? @fn "JSON.parse"))` — find JSON.parse calls
 *
 * Use `language` to specify which tree-sitter grammar to use. Files are
 * filtered by language-matching extensions from the indexed repo.
 */
export async function astQuery(
  repo: string,
  queryString: string,
  options?: {
    language?: string | undefined;
    file_pattern?: string | undefined;
    max_matches?: number | undefined;
  },
): Promise<AstQueryResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository not found: ${repo}`);

  await initParser();

  const lang = options?.language ?? "typescript";
  const parser = await getParser(lang);
  if (!parser) throw new Error(`No tree-sitter grammar for language: ${lang}`);

  const tsLang = parser.getLanguage();
  let query: Parser.Query;
  try {
    query = tsLang.query(queryString);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid tree-sitter query: ${msg}`);
  }

  const maxMatches = options?.max_matches ?? MAX_MATCHES;
  const matches: AstMatch[] = [];
  let filesScanned = 0;

  // Get extensions for this language
  const targetExts = getExtensionsForLanguage(lang);

  for (const file of index.files) {
    if (matches.length >= maxMatches) break;
    if (options?.file_pattern && !file.path.includes(options.file_pattern)) continue;
    if (!targetExts.some((ext) => file.path.endsWith(ext))) continue;

    const fullPath = path.join(index.root, file.path);
    let source: string;
    try {
      source = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    if (source.length > MAX_FILE_SIZE) continue;
    filesScanned++;

    const tree = parser.parse(source);
    const queryMatches = query.matches(tree.rootNode);

    for (const match of queryMatches) {
      if (matches.length >= maxMatches) break;

      const captures: Record<string, string> = {};
      let minStart = Infinity;
      let maxEnd = -Infinity;
      let mainText = "";

      for (const capture of match.captures) {
        captures[capture.name] = capture.node.text;
        if (capture.node.startPosition.row < minStart) {
          minStart = capture.node.startPosition.row;
        }
        if (capture.node.endPosition.row > maxEnd) {
          maxEnd = capture.node.endPosition.row;
          mainText = capture.node.text;
        }
      }

      matches.push({
        file: file.path,
        start_line: minStart + 1,
        end_line: maxEnd + 1,
        text: mainText.slice(0, 500),
        captures,
      });
    }

    tree.delete();
  }

  return {
    matches,
    files_scanned: filesScanned,
    truncated: matches.length >= maxMatches,
  };
}

function getExtensionsForLanguage(lang: string): string[] {
  const map: Record<string, string[]> = {
    typescript: [".ts", ".tsx"],
    tsx: [".tsx"],
    javascript: [".js", ".jsx"],
    python: [".py"],
    go: [".go"],
    rust: [".rs"],
    java: [".java"],
    ruby: [".rb"],
    php: [".php"],
    css: [".css"],
    markdown: [".md", ".markdown"],
  };
  return map[lang] ?? [];
}
