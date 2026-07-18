import type { CodeSymbol } from "../../types.js";
import { tokenizeIdentifier, makeSymbolId } from "../symbol-utils.js";
import { sliceBalancedParens, splitTopLevelCommas } from "./sql-parens.js";

const CONSTRAINT_RE = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX|KEY|FULLTEXT)\b/i;
const SIGNATURE_CONSTRAINT_RE = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|INDEX)\s*[\(]/i;
const COLUMN_RE = /^\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([\w#$]+))\s+(.+)/i;

export interface ColumnContext {
  lines: string[];
  startIdx: number;
  endIdx: number;
  filePath: string;
  repo: string;
  parentId: string;
  matchOffset: number;
  source: string;
}

export function extractColumns(context: ColumnContext): CodeSymbol[] {
  if (context.startIdx === context.endIdx) return extractMinifiedColumns(context);
  const fields: CodeSymbol[] = [];
  for (let lineIndex = context.startIdx + 1; lineIndex <= context.endIdx; lineIndex++) {
    const parsed = parseColumn(context.lines[lineIndex]?.trim() ?? "", true);
    if (parsed) fields.push(buildField(context, parsed.name, parsed.type, lineIndex + 1));
  }
  return fields;
}

function extractMinifiedColumns(context: ColumnContext): CodeSymbol[] {
  const openIndex = context.source.indexOf("(", context.matchOffset);
  if (openIndex === -1) return [];
  const body = sliceBalancedParens(context.source, openIndex);
  if (!body) return [];
  return splitTopLevelCommas(body).flatMap((segment) => {
    const parsed = parseColumn(segment.trim(), false);
    return parsed ? [buildField(context, parsed.name, parsed.type, context.startIdx + 1)] : [];
  });
}

function parseColumn(text: string, trimComma: boolean): { name: string; type: string } | null {
  if (!text || text === ")" || text === ");" || CONSTRAINT_RE.test(text)) return null;
  const match = COLUMN_RE.exec(text);
  const name = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
  const rawType = match?.[5];
  if (!name || !rawType) return null;
  return { name, type: (trimComma ? rawType.replace(/,\s*$/, "") : rawType).trim() };
}

function buildField(
  context: ColumnContext,
  name: string,
  type: string,
  line: number,
): CodeSymbol {
  return {
    id: makeSymbolId(context.repo, context.filePath, name, line),
    repo: context.repo, name, kind: "field", file: context.filePath,
    start_line: line, end_line: line, signature: type,
    parent: context.parentId, tokens: tokenizeIdentifier(name),
  };
}

export function buildTableSignature(
  name: string,
  lines: string[],
  startIdx: number,
  endIdx: number,
): string {
  const columns: string[] = [];
  for (let index = startIdx + 1; index <= endIdx; index++) {
    const text = lines[index]?.trim() ?? "";
    if (SIGNATURE_CONSTRAINT_RE.test(text) || text === "" || text === ")" || text === ");") continue;
    const match = /^"?(\w+)"?\s+\S/i.exec(text);
    if (match?.[1]) columns.push(match[1]);
  }
  return `TABLE ${name} (${columns.join(", ")})`;
}
