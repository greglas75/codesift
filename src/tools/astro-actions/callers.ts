import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIndex } from "../../types.js";
import type { ActionCall, CallerInfo, CallerScanResult } from "./types.js";

const ACTIONS_CALL_PATTERN = /actions\.([A-Za-z_$][\w$]*)\s*\(/g;

/** Locate actions.name() calls and classify Astro frontmatter as server-side. */
export function findActionCalls(file: string, source: string): ActionCall[] {
  const matches: ActionCall[] = [];
  const isAstro = file.endsWith(".astro");
  const frontmatter = isAstro
    ? source.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/)
    : null;
  const frontmatterEnd = frontmatter?.[0].length ?? -1;
  ACTIONS_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTIONS_CALL_PATTERN.exec(source)) !== null) {
    const action = match[1];
    if (!action) continue;
    const line = source.slice(0, match.index).split("\n").length;
    matches.push({
      file,
      line,
      action,
      is_server_side: isAstro && frontmatterEnd > 0 && match.index < frontmatterEnd,
    });
  }
  return matches;
}

/** Return the textual form tag enclosing an action call, when one exists. */
export function findEnclosingFormTag(source: string, offset: number): string | null {
  const lastOpen = source.slice(0, offset).lastIndexOf("<form");
  if (lastOpen === -1) return null;
  const afterOpen = source.slice(lastOpen);
  const firstClose = afterOpen.indexOf(">");
  if (firstClose === -1 || source.indexOf("</form>", offset) === -1) return null;
  return afterOpen.slice(0, firstClose + 1);
}

function lineOffset(source: string, line: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1; index++) offset += (lines[index]?.length ?? 0) + 1;
  return offset;
}

function addCaller(
  callersByAction: Map<string, CallerInfo[]>,
  call: ActionCall,
  source: string,
): void {
  const callers = callersByAction.get(call.action) ?? [];
  callers.push({
    file: call.file,
    line: call.line,
    formTag: findEnclosingFormTag(source, lineOffset(source, call.line)),
  });
  callersByAction.set(call.action, callers);
}

/** Scan indexed Astro/JSX callers while preserving index file order. */
export function scanActionCallers(index: CodeIndex, actionNames: Set<string>): CallerScanResult {
  const result: CallerScanResult = {
    callersByAction: new Map(),
    reportableCalls: [],
  };
  const files = index.files.filter(({ path }) =>
    path.endsWith(".astro") || path.endsWith(".tsx") || path.endsWith(".jsx"));

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }
    for (const call of findActionCalls(file.path, source)) {
      if (!actionNames.has(call.action)) {
        if (!call.is_server_side) result.reportableCalls.push(call);
        continue;
      }
      if (call.is_server_side) result.reportableCalls.push(call);
      else addCaller(result.callersByAction, call, source);
    }
  }
  return result;
}
