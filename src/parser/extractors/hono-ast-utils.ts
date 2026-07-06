import path from "node:path";
import type Parser from "web-tree-sitter";

const MAX_WALK_DEPTH = 500;

export type CursorVisitor = (node: Parser.SyntaxNode) => void;

export function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const text = node.text;
    if (text.length < 2) return null;
    const quote = text[0];
    if (quote !== '"' && quote !== "'") return null;
    return decodeJsStringEscapes(text.slice(1, -1));
  }
  if (node.type === "template_string") {
    const hasInterpolation = node.namedChildren.some(
      (child) => child.type === "template_substitution",
    );
    if (hasInterpolation) return null;
    const text = node.text;
    if (text.length < 2) return null;
    return decodeJsStringEscapes(text.slice(1, -1));
  }
  return null;
}

function decodeJsStringEscapes(raw: string): string {
  return raw
    .replace(/\\(?:\r\n|[\n\r\u2028\u2029])/g, "")
    .replace(
      /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(.)/g,
      (_match, codePoint: string, unicode: string, hex: string, escaped: string) => {
        if (codePoint) {
          const parsedCodePoint = Number.parseInt(codePoint, 16);
          return parsedCodePoint <= 0x10ffff
            ? String.fromCodePoint(parsedCodePoint)
            : "";
        }
        if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
        if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
        const simpleEscapes: Record<string, string> = {
          "0": "\0",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
          v: "\v",
        };
        return simpleEscapes[escaped] ?? escaped;
      },
    );
}

export function walk(
  cursor: Parser.TreeCursor,
  visit: CursorVisitor,
  depth = 0,
): void {
  try {
    if (depth > MAX_WALK_DEPTH) return;
    visit(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      do {
        walk(cursor, visit, depth + 1);
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  } finally {
    if (depth === 0) cursor.delete();
  }
}

export function pickLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "typescript";
  if (ext === ".jsx" || ext === ".js") return "javascript";
  return "typescript";
}
