export type OutboundCallee = "fetch" | "axios" | "got";

export interface UrlLiteral {
  kind: "string" | "template";
  /** Raw content between quotes/backticks, escape sequences intact. */
  raw: string;
}

export interface LexerOutboundCall {
  callee: OutboundCallee;
  /** HTTP method from callee name (axios.get → "GET"). fetch/got default undefined. */
  method?: string;
  urlLiteral: UrlLiteral;
  /** The first non-whitespace token after the closing quote/backtick. */
  nextCodeToken: string;
  /** 1-based line number of the call keyword. */
  line: number;
}

export type LexerState =
  | "code"
  | "lineComment"
  | "blockComment"
  | "singleString"
  | "doubleString"
  | "template"
  | "regex";
