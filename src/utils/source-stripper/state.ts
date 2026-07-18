import type { StripContext } from "./types.js";

export function createContext(source: string): StripContext {
  return {
    source,
    out: [],
    i: 0,
    state: "code",
    lastCodeChar: "",
    prevToken: "",
    identBuf: "",
    braceDepth: 0,
    templateStack: [],
  };
}

export function flushIdentifier(context: StripContext): void {
  if (context.identBuf.length > 0) {
    context.prevToken = context.identBuf;
    context.identBuf = "";
  }
}
