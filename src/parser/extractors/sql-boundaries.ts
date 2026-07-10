import { findClosingParenByte, findSemicolonByte } from "./sql-end-scanner.js";

export type SqlEndStrategy = "paren" | "semicolon" | "begin-end" | "single-line";

export function findEndByte(source: string, startOffset: number, strategy: SqlEndStrategy): number {
  switch (strategy) {
    case "paren":
      return findClosingParenByte(source, startOffset);
    case "semicolon":
    case "begin-end":
      return findSemicolonByte(source, startOffset);
    case "single-line": {
      const newline = source.indexOf("\n", startOffset);
      return newline === -1 ? source.length - 1 : newline;
    }
    default: {
      const exhaustive: never = strategy;
      return exhaustive;
    }
  }
}
