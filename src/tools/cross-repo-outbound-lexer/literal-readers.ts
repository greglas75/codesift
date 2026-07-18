import { LexerContext } from "./context.js";
import { readTemplateContent } from "./template-reader.js";
import type { UrlLiteral } from "./types.js";

export function readStringContent(context: LexerContext, quote: string): string {
  let raw = "";
  while (context.index < context.length) {
    const char = context.current();
    if (char === "\\") {
      raw += char;
      context.index++;
      if (context.index < context.length) {
        raw += context.current();
        if (context.current() === "\n") context.line++;
        context.index++;
      }
      continue;
    }
    if (char === quote) {
      context.index++;
      break;
    }
    if (char === "\n") context.line++;
    raw += char;
    context.index++;
  }
  return raw;
}

export function tryReadUrlArgument(context: LexerContext): UrlLiteral | null {
  const position = context.skipWhitespace();
  if (position >= context.length) return null;
  const quote = context.source[position]!;
  if (quote === '"' || quote === "'") {
    consumeWhitespace(context, position);
    context.index++;
    return { kind: "string", raw: readStringContent(context, quote) };
  }
  if (quote === "`") {
    consumeWhitespace(context, position);
    context.index++;
    return { kind: "template", raw: readTemplateContent(context) };
  }
  return null;
}

function consumeWhitespace(context: LexerContext, end: number): void {
  while (context.index < end) {
    if (context.current() === "\n") context.line++;
    context.emit();
  }
}

export function peekNextCodeToken(context: LexerContext): string {
  const position = context.skipWhitespace();
  let token = "";
  let cursor = position;
  while (cursor < context.length && token.length < 20) {
    const char = context.source[cursor]!;
    if (/[ \t\n\r]/.test(char)) break;
    token += char;
    cursor++;
  }
  return token;
}
