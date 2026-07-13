import type { AstroTemplateParse } from "./types.js";

const MAX_TEMPLATE_SIZE = 512_000;
const MAX_BRACE_DEPTH = 100;

export const EMPTY_PARSE: AstroTemplateParse = {
  islands: [], slots: [], component_usages: [], directives: [],
  parse_confidence: "high", scan_errors: [],
};

export type PreparedTemplate =
  | { kind: "ready"; template: string; startLine: number }
  | { kind: "result"; result: AstroTemplateParse };

function splitFrontmatter(src: string): { template: string; startLine: number } {
  const match = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) return { template: src, startLine: 1 };
  return { template: src.slice(match[0].length), startLine: match[0].split("\n").length };
}

export function prepareTemplate(source: string): PreparedTemplate {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const { template: raw, startLine } = splitFrontmatter(normalized);
  if (raw.length > MAX_TEMPLATE_SIZE) return { kind: "result", result: { ...EMPTY_PARSE, parse_confidence: "degraded" } };
  if (raw.trim().length === 0) return { kind: "result", result: { ...EMPTY_PARSE } };

  const template = raw.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
  let depth = 0;
  for (const char of template) {
    if (char === "{") {
      depth++;
      if (depth > MAX_BRACE_DEPTH) return { kind: "result", result: { ...EMPTY_PARSE, parse_confidence: "degraded" } };
    } else if (char === "}") {
      depth--;
    }
  }
  return { kind: "ready", template, startLine };
}
