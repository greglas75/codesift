/** Lightweight state-machine lexer for outbound HTTP call detection. */

import { LexerContext } from "./cross-repo-outbound-lexer/context.js";
import { detectOutboundCall, isIdentifierCharacter } from "./cross-repo-outbound-lexer/call-detectors.js";
import { processNonCodeState } from "./cross-repo-outbound-lexer/non-code-states.js";
import type { LexerOutboundCall } from "./cross-repo-outbound-lexer/types.js";

export type {
  LexerOutboundCall,
  OutboundCallee,
  UrlLiteral,
} from "./cross-repo-outbound-lexer/types.js";

function isRegexStart(output: readonly string[]): boolean {
  for (let index = output.length - 1; index >= 0; index--) {
    const char = output[index]!;
    if (/[ \t\n\r]/.test(char)) continue;
    return !(char === ")" || char === "]" || isIdentifierCharacter(char));
  }
  return true;
}

function enterDelimitedState(context: LexerContext): boolean {
  const char = context.current();
  const next = context.peek();
  if (char === "/" && next === "/") {
    context.state = "lineComment";
    context.emit();
    context.emit();
    return true;
  }
  if (char === "/" && next === "*") {
    context.state = "blockComment";
    context.emit();
    context.emit();
    return true;
  }
  if (char === "/" && next !== "/" && next !== "*" && isRegexStart(context.out)) {
    context.state = "regex";
    context.inRegexClass = false;
    context.emit();
    return true;
  }
  if (char === '"' || char === "'") {
    context.state = char === '"' ? "doubleString" : "singleString";
    context.emit();
    return true;
  }
  if (char === "`") {
    context.state = "template";
    context.templateStack.push(context.braceDepth);
    context.emit();
    return true;
  }
  return false;
}

function processBrace(context: LexerContext): boolean {
  const char = context.current();
  if (char === "{") {
    context.braceDepth++;
    context.emit();
    return true;
  }
  if (char !== "}") return false;
  const templateDepth = context.templateStack.at(-1);
  if (templateDepth !== undefined && context.braceDepth === templateDepth) {
    context.templateStack.pop();
    context.braceDepth--;
    context.state = "template";
  } else {
    context.braceDepth--;
  }
  context.emit();
  return true;
}

/**
 * Lex source and return outbound HTTP calls whose URL argument is a literal.
 * Calls inside strings, templates, comments, and regex literals are skipped.
 */
export function findOutboundCalls(source: string): LexerOutboundCall[] {
  const context = new LexerContext(source);
  const results: LexerOutboundCall[] = [];
  while (context.index < context.length) {
    if (processNonCodeState(context)) continue;
    if (enterDelimitedState(context)) continue;
    if (processBrace(context)) continue;
    const call = detectOutboundCall(context);
    if (call) {
      results.push(call);
      continue;
    }
    if (context.current() === "\n") context.line++;
    context.emit();
  }
  return results;
}
