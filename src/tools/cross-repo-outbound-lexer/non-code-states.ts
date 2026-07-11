import { LexerContext } from "./context.js";

export function processNonCodeState(context: LexerContext): boolean {
  if (context.state === "code") return false;
  const char = context.current();
  const next = context.peek();
  if (context.state === "lineComment") {
    if (char === "\n") { context.state = "code"; context.line++; context.emit(); }
    else { context.emit(" "); }
    return true;
  }
  if (context.state === "blockComment") {
    if (char === "*" && next === "/") {
      context.state = "code";
      context.emit(" ");
      context.emit(" ");
    } else {
      if (char === "\n") context.line++;
      context.emit(char === "\n" ? "\n" : " ");
    }
    return true;
  }
  if (context.state === "singleString" || context.state === "doubleString") {
    processStringState(context, context.state === "singleString" ? "'" : '"');
    return true;
  }
  if (context.state === "template") {
    processTemplateState(context, char, next);
    return true;
  }
  processRegexState(context, char);
  return true;
}

function processStringState(context: LexerContext, quote: string): void {
  const char = context.current();
  context.emit();
  if (char === "\\" && context.index < context.length) {
    if (context.current() === "\n") context.line++;
    context.emit();
    return;
  }
  if (char === quote) context.state = "code";
  if (char === "\n") context.line++;
}

function processTemplateState(context: LexerContext, char: string, next: string): void {
  context.emit();
  if (char === "\\" && context.index < context.length) {
    if (context.current() === "\n") context.line++;
    context.emit();
    return;
  }
  if (char === "`") {
    context.templateStack.pop();
    context.state = "code";
    return;
  }
  if (char === "$" && next === "{") {
    context.emit(next);
    context.braceDepth++;
    context.templateStack.push(context.braceDepth);
    context.state = "code";
    return;
  }
  if (char === "\n") context.line++;
}

function processRegexState(context: LexerContext, char: string): void {
  context.emit();
  if (char === "\\" && context.index < context.length) {
    if (context.current() === "\n") context.line++;
    context.emit();
    return;
  }
  if (char === "[" && !context.inRegexClass) { context.inRegexClass = true; return; }
  if (char === "]" && context.inRegexClass) { context.inRegexClass = false; return; }
  if (char === "/" && !context.inRegexClass) {
    while (context.index < context.length && /[gimsuy]/.test(context.current())) context.emit();
    context.state = "code";
    return;
  }
  if (char === "\n") context.line++;
}
