import { closeTemplateInterpolation } from "./template-handler.js";
import { flushIdentifier } from "./state.js";
import { nextChar, type StripContext } from "./types.js";

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "throw", "case", "delete", "in", "of", "instanceof", "typeof",
  "new", "void", "yield", "await", "do", "else",
]);

export function handleCode(context: StripContext): void {
  const c = context.source[context.i]!;
  const next = nextChar(context);
  if (c === "/" && next === "/") return startLineComment(context);
  if (c === "/" && next === "*") return startBlockComment(context);
  if (c === "/" && next !== "=" && isRegexContext(context)) return startRegex(context);
  if (c === "'") return startString(context, "single");
  if (c === '"') return startString(context, "double");
  if (c === "`") return startString(context, "template");
  if (c === "{") context.braceDepth++;
  else if (c === "}" && closeTemplateInterpolation(context)) return;
  else if (c === "}") context.braceDepth--;
  context.out.push(c);
  if (/\s/.test(c)) flushIdentifier(context);
  else {
    context.lastCodeChar = c;
    if (/[A-Za-z_$]/.test(c) || (/[0-9]/.test(c) && context.identBuf.length > 0)) context.identBuf += c;
    else flushNonIdentifier(context);
  }
  context.i++;
}

function isRegexContext(context: StripContext): boolean {
  if (context.lastCodeChar === "") return true;
  if (context.identBuf.length > 0) context.prevToken = context.identBuf;
  if (REGEX_PRECEDING_KEYWORDS.has(context.prevToken)) return true;
  return /[=(,;!&|?:{[<>+\-*%^~]/.test(context.lastCodeChar);
}

function startLineComment(context: StripContext): void {
  flushIdentifier(context);
  context.state = "lineComment";
  context.out.push(" ", " ");
  context.i += 2;
}

function startBlockComment(context: StripContext): void {
  flushIdentifier(context);
  context.state = "blockComment";
  context.out.push(" ", " ");
  context.i += 2;
}

function startRegex(context: StripContext): void {
  context.state = "regex";
  context.out.push(" ");
  context.i++;
  context.identBuf = "";
}

function startString(context: StripContext, state: "single" | "double" | "template"): void {
  context.state = state;
  context.out.push(" ");
  context.i++;
  context.lastCodeChar = state === "single" ? "'" : state === "double" ? '"' : "`";
}

function flushNonIdentifier(context: StripContext): void {
  if (context.identBuf.length > 0) context.prevToken = context.identBuf;
  context.identBuf = "";
}
