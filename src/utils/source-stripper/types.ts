export type StripState = "code" | "lineComment" | "blockComment" | "single" | "double" | "template" | "regex";

export interface TemplateContext {
  braceDepth: number;
}

export interface StripContext {
  source: string;
  out: string[];
  i: number;
  state: StripState;
  lastCodeChar: string;
  prevToken: string;
  identBuf: string;
  braceDepth: number;
  templateStack: TemplateContext[];
}

export function nextChar(context: StripContext): string {
  return context.i + 1 < context.source.length ? context.source[context.i + 1]! : "";
}
