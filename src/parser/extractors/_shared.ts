import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-extractor.js";

export const MAX_SOURCE_LENGTH = 5000;

export function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

export function extractNodeSource(
  node: Parser.SyntaxNode,
  source: string,
): string {
  const text = source.slice(node.startIndex, node.endIndex);
  if (text.length > MAX_SOURCE_LENGTH) {
    return text.slice(0, MAX_SOURCE_LENGTH) + "...";
  }
  return text;
}

export function makeSymbol(
  node: Parser.SyntaxNode,
  name: string,
  kind: SymbolKind,
  filePath: string,
  source: string,
  repo: string,
  opts?: {
    parentId?: string | undefined;
    docstring?: string | undefined;
    signature?: string | undefined;
    decorators?: string[] | undefined;
    extends?: string[] | undefined;
    is_async?: boolean | undefined;
    meta?: Record<string, unknown> | undefined;
  },
): CodeSymbol {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const sym: CodeSymbol = {
    id: makeSymbolId(repo, filePath, name, startLine),
    repo,
    name,
    kind,
    file: filePath,
    start_line: startLine,
    end_line: endLine,
    start_byte: node.startIndex,
    end_byte: node.endIndex,
    source: extractNodeSource(node, source),
    tokens: tokenizeIdentifier(name),
  };

  if (opts?.docstring) sym.docstring = opts.docstring;
  if (opts?.parentId) sym.parent = opts.parentId;
  if (opts?.signature) sym.signature = opts.signature;
  if (opts?.decorators && opts.decorators.length > 0) sym.decorators = opts.decorators;
  if (opts?.extends && opts.extends.length > 0) sym.extends = opts.extends;
  if (opts?.is_async) sym.is_async = true;
  if (opts?.meta && Object.keys(opts.meta).length > 0) sym.meta = opts.meta;

  return sym;
}
