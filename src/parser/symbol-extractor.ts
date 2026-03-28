import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../types.js";
import { extractTypeScriptSymbols } from "./extractors/typescript.js";
import { extractPythonSymbols } from "./extractors/python.js";
import { extractGoSymbols } from "./extractors/go.js";
import { extractRustSymbols } from "./extractors/rust.js";
import { extractJavaScriptSymbols } from "./extractors/javascript.js";

// --- Public API ---

/**
 * Extract symbols from a tree-sitter parse tree.
 * For markdown files, use `extractMarkdownSymbols` directly (no tree-sitter needed).
 */
export function extractSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
  language: string,
): CodeSymbol[] {
  switch (language) {
    case "typescript":
    case "tsx":
      return extractTypeScriptSymbols(tree, filePath, source, repo);
    case "python":
      return extractPythonSymbols(tree, filePath, source, repo);
    case "go":
      return extractGoSymbols(tree, filePath, source, repo);
    case "rust":
      return extractRustSymbols(tree, filePath, source, repo);
    case "javascript":
      return extractJavaScriptSymbols(tree, filePath, source, repo);
    default:
      return extractGenericSymbols(tree, filePath, source, repo);
  }
}

// Re-export custom extractors for use by the indexing pipeline (no tree-sitter grammar)
export { extractMarkdownSymbols } from "./extractors/markdown.js";
export { extractPrismaSymbols } from "./extractors/prisma.js";
export { extractAstroSymbols } from "./extractors/astro.js";
export { extractConversationSymbols } from "./extractors/conversation.js";

/**
 * Splits camelCase, PascalCase, UPPER_SNAKE, and snake_case identifiers
 * into lowercase tokens.
 *
 * Examples:
 *   getUserById   → ["get", "user", "by", "id"]
 *   user_name     → ["user", "name"]
 *   HTMLParser    → ["html", "parser"]
 *   fetchAPIData  → ["fetch", "api", "data"]
 */
export function tokenizeIdentifier(name: string): string[] {
  // Step 1: split on underscores
  const parts = name.split("_").filter(Boolean);

  const tokens: string[] = [];

  for (const part of parts) {
    // Step 2: split camelCase / PascalCase
    // Insert boundary between:
    //   lowercase→uppercase  (get|User)
    //   uppercase sequence→uppercase+lowercase  (HTM|L→P|arser → HTML|Parser)
    const subParts = part
      .replace(/([a-z0-9])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0");

    for (const sub of subParts) {
      if (sub.length > 0) {
        tokens.push(sub.toLowerCase());
      }
    }
  }

  return tokens;
}

export function makeSymbolId(
  repo: string,
  file: string,
  name: string,
  startLine: number,
): string {
  return `${repo}:${file}:${name}:${startLine}`;
}

// --- Generic extraction (fallback for unsupported languages) ---

const GENERIC_NODE_KIND_MAP: Record<string, SymbolKind> = {
  function_declaration: "function",
  function_definition: "function",
  class_declaration: "class",
  class_definition: "class",
  method_definition: "method",
  method_declaration: "method",
};

function extractGenericSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string): void {
    const kind = GENERIC_NODE_KIND_MAP[node.type];

    if (kind) {
      const nameNode = node.childForFieldName("name")
        ?? node.namedChildren.find((c) => c.type === "identifier");
      const name = nameNode?.text ?? "<anonymous>";
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const id = makeSymbolId(repo, filePath, name, startLine);

      const nodeSource = source.slice(node.startIndex, node.endIndex);

      const sym: CodeSymbol = {
        id,
        repo,
        name,
        kind,
        file: filePath,
        start_line: startLine,
        end_line: endLine,
        source: nodeSource.length > 5000
          ? nodeSource.slice(0, 5000) + "..."
          : nodeSource,
        tokens: tokenizeIdentifier(name),
      };

      if (parentId) sym.parent = parentId;

      symbols.push(sym);

      for (const child of node.namedChildren) {
        walk(child, id);
      }
    } else {
      for (const child of node.namedChildren) {
        walk(child, parentId);
      }
    }
  }

  walk(tree.rootNode);
  return symbols;
}
