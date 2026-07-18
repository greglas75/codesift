import { LexerContext } from "./context.js";

export function readTemplateContent(context: LexerContext): string {
  let raw = "";
  let depth = 0;
  let inExpression = false;
  while (context.index < context.length) {
    const char = context.current();
    if (!inExpression) {
      if (char === "\\") {
        raw += readEscape(context);
        continue;
      }
      if (char === "`") { context.index++; break; }
      if (char === "$" && context.peek() === "{") {
        raw += "${";
        context.index += 2;
        inExpression = true;
        depth = 1;
        continue;
      }
      if (char === "\n") context.line++;
      raw += char;
      context.index++;
      continue;
    }
    if (char === "{") { depth++; raw += char; context.index++; continue; }
    if (char === "}") {
      depth--;
      raw += char;
      context.index++;
      if (depth === 0) inExpression = false;
      continue;
    }
    if (char === '"' || char === "'") {
      raw += readExpressionString(context, char);
      continue;
    }
    if (char === "\n") context.line++;
    raw += char;
    context.index++;
  }
  return raw;
}

function readEscape(context: LexerContext): string {
  let raw = context.current();
  context.index++;
  if (context.index < context.length) {
    raw += context.current();
    if (context.current() === "\n") context.line++;
    context.index++;
  }
  return raw;
}

function readExpressionString(context: LexerContext, quote: string): string {
  let raw = quote;
  context.index++;
  while (context.index < context.length) {
    const char = context.current();
    raw += char;
    context.index++;
    if (char === "\\" && context.index < context.length) {
      raw += context.current();
      context.index++;
      continue;
    }
    if (char === quote) break;
  }
  return raw;
}
