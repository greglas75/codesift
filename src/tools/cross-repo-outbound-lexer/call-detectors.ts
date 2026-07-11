import { LexerContext } from "./context.js";
import { peekNextCodeToken, tryReadUrlArgument } from "./literal-readers.js";
import type { LexerOutboundCall, OutboundCallee } from "./types.js";

const HTTP_METHODS = ["delete", "patch", "post", "put", "get"] as const;

export function isIdentifierCharacter(char: string): boolean {
  return /[a-zA-Z0-9_$]/.test(char);
}

function emitThrough(context: LexerContext, end: number): void {
  while (context.index < end) {
    if (context.current() === "\n") context.line++;
    context.emit();
  }
}

function detectMethod(context: LexerContext): string | null {
  for (const method of HTTP_METHODS) {
    const candidate = context.source.slice(context.index, context.index + method.length);
    const after = context.source[context.index + method.length] ?? "";
    if (candidate.toLowerCase() === method && !isIdentifierCharacter(after)) return method;
  }
  return null;
}

function readCall(
  context: LexerContext,
  callee: OutboundCallee,
  line: number,
  method?: string,
): LexerOutboundCall | null {
  const openingParen = context.skipWhitespace();
  if (context.source[openingParen] !== "(") return null;
  emitThrough(context, openingParen);
  context.emit("(");
  const urlLiteral = tryReadUrlArgument(context);
  if (!urlLiteral) return null;
  return {
    callee,
    ...(method ? { method } : {}),
    urlLiteral,
    nextCodeToken: peekNextCodeToken(context),
    line,
  };
}

function detectFetch(context: LexerContext): LexerOutboundCall | undefined {
  const start = context.index;
  if (context.current() !== "f" || context.source.slice(start, start + 5) !== "fetch") return undefined;
  if (start > 0 && isIdentifierCharacter(context.source[start - 1]!)) return undefined;
  const line = context.line;
  emitThrough(context, start + 5);
  return readCall(context, "fetch", line) ?? undefined;
}

function detectMethodCall(
  context: LexerContext,
  callee: "axios" | "got",
): LexerOutboundCall | undefined {
  const start = context.index;
  const nameLength = callee.length;
  if (context.source.slice(start, start + nameLength) !== callee) return undefined;
  if (start > 0 && isIdentifierCharacter(context.source[start - 1]!)) return undefined;
  if (callee === "got" && isIdentifierCharacter(context.source[start + nameLength] ?? "")) return undefined;
  const line = context.line;
  emitThrough(context, start + nameLength);
  const dot = callee === "got" ? context.skipWhitespace() : context.index;
  if (context.source[dot] !== ".") return undefined;
  emitThrough(context, dot);
  context.emit(".");
  const method = detectMethod(context);
  if (!method) return undefined;
  emitThrough(context, context.index + method.length);
  return readCall(context, callee, line, method.toUpperCase()) ?? undefined;
}

export function detectOutboundCall(context: LexerContext): LexerOutboundCall | undefined {
  return detectFetch(context)
    ?? detectMethodCall(context, "axios")
    ?? detectMethodCall(context, "got");
}
