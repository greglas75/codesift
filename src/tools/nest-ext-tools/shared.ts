import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "../index-tools.js";
import type { NestToolError } from "../nest-tools.js";
import { stripCommentsAndStrings } from "../../utils/source-stripper.js";

export type NestCodeIndex = NonNullable<Awaited<ReturnType<typeof getCodeIndex>>>;

export interface NestClassRange {
  name: string;
  start: number;
  bodyStart: number;
  end: number;
}

export interface NestDecoratorCall {
  start: number;
  end: number;
  args: string;
}

export async function requireNestCodeIndex(repo: string): Promise<NestCodeIndex> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  return index;
}

export async function readNestSource(
  index: NestCodeIndex,
  file: string,
  errors: NestToolError[],
): Promise<string | undefined> {
  try {
    return await readFile(join(index.root, file), "utf-8");
  } catch (err) {
    errors.push({
      file,
      reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
}

export function maskNestSource(source: string): string {
  return stripCommentsAndStrings(source);
}

export function findNestClassRanges(source: string): NestClassRange[] {
  const masked = maskNestSource(source);
  const ranges: NestClassRange[] = [];
  const classRe = /\bclass\s+(\w+)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(masked)) !== null) {
    const bodyStart = masked.indexOf("{", match.index);
    if (bodyStart === -1) continue;
    let depth = 1;
    let cursor = bodyStart + 1;
    while (cursor < masked.length && depth > 0) {
      if (masked[cursor] === "{") depth++;
      else if (masked[cursor] === "}") depth--;
      cursor++;
    }
    ranges.push({
      name: match[1]!,
      start: match.index,
      bodyStart,
      end: depth === 0 ? cursor : masked.length,
    });
  }
  return ranges;
}

export function findClassAtPosition(
  ranges: NestClassRange[],
  position: number,
): NestClassRange | undefined {
  return ranges.find((range) => position >= range.bodyStart && position < range.end);
}

export function findDecoratorCalls(source: string, decorator: string): NestDecoratorCall[] {
  const masked = maskNestSource(source);
  const calls: NestDecoratorCall[] = [];
  const decoratorRe = new RegExp(`@${decorator}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = decoratorRe.exec(masked)) !== null) {
    const open = masked.indexOf("(", match.index);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < masked.length && depth > 0) {
      if (masked[cursor] === "(") depth++;
      else if (masked[cursor] === ")") depth--;
      cursor++;
    }
    if (depth !== 0) continue;
    calls.push({
      start: match.index,
      end: cursor,
      args: source.slice(open + 1, cursor - 1).trim(),
    });
  }
  return calls;
}

export function findDecoratedClass(
  ranges: NestClassRange[],
  call: NestDecoratorCall,
): NestClassRange | undefined {
  return ranges.find((range) => range.start >= call.end);
}

export function isNodeModulesPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").includes("node_modules");
}

export function firstNestDecoratorArgument(args: string): string {
  const masked = maskNestSource(args);
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < masked.length; index++) {
    switch (masked[index]) {
      case "(":
        round++;
        break;
      case ")":
        round--;
        break;
      case "[":
        square++;
        break;
      case "]":
        square--;
        break;
      case "{":
        curly++;
        break;
      case "}":
        curly--;
        break;
      case ",":
        if (round === 0 && square === 0 && curly === 0) {
          return args.slice(0, index).trim();
        }
        break;
    }
  }
  return args.trim();
}

export function stripLeadingNestComments(value: string): string {
  return value.replace(
    /^\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)*/,
    "",
  );
}

export function findTopLevelStringProperty(
  objectSource: string,
  property: string,
): string | undefined {
  const masked = maskNestSource(objectSource);
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    if (masked[index] === "{") {
      depth++;
      continue;
    }
    if (masked[index] === "}") {
      depth--;
      continue;
    }
    if (depth !== 1 || !masked.startsWith(property, index)) continue;
    const before = masked[index - 1];
    const after = masked[index + property.length];
    if ((before && /[\w$]/.test(before)) || (after && /[\w$]/.test(after))) continue;
    const colon = masked.indexOf(":", index + property.length);
    if (colon === -1) continue;
    const match = /^\s*['"`]([^'"`]+)['"`]/.exec(objectSource.slice(colon + 1));
    if (match) return match[1];
  }
  return undefined;
}
