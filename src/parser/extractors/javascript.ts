import type Parser from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import { extractTypeScriptSymbols } from "./typescript.js";

/**
 * JavaScript extractor — reuses the TypeScript extractor since
 * tree-sitter JavaScript and TypeScript grammars share node types
 * for functions, classes, arrow functions, etc.
 */
export function extractJavaScriptSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  return extractTypeScriptSymbols(tree, filePath, source, repo);
}
