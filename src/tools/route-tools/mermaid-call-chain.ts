import type { DbCall, RouteCallNode, RouteTraceResult } from "./types.js";

interface StackEntry {
  node: RouteCallNode;
  alias: string;
}

function nodeAlias(
  node: Pick<RouteCallNode, "name" | "file">,
  aliases: Map<string, string>,
): string {
  const key = `${node.file}:${node.name}`;
  const existing = aliases.get(key);
  if (existing) return existing;

  const baseName = node.file.split("/").pop()?.replace(/\.\w+$/, "") ?? node.name;
  // Collapsing every non-alphanumeric to `_` made distinct participants share one alias:
  // `user-service.ts:getAll` and `user.service.ts:getAll` both became `user_service_getAll`, so
  // two nodes merged into one lifeline and the diagram silently misrepresented the call chain.
  // A per-alias counter keeps them apart without changing the readable prefix.
  const base = `${baseName}_${node.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const taken = new Set(aliases.values());
  let alias = base;
  for (let n = 2; taken.has(alias); n++) alias = `${base}_${n}`;
  aliases.set(key, alias);
  return alias;
}

function appendDbCalls(
  lines: string[],
  dbCalls: DbCall[],
  node: Pick<RouteCallNode, "name" | "file">,
  actor: string,
): void {
  const calls = dbCalls
    .filter((dbCall) => dbCall.file === node.file && dbCall.symbol_name === node.name)
    .slice(0, 3);
  for (const dbCall of calls) {
    lines.push(`    ${actor}->>+DB: ${dbCall.operation}`);
    lines.push(`    DB-->>-${actor}: result`);
  }
}

function closeStack(
  lines: string[],
  stack: StackEntry[],
  nextDepth: number,
): void {
  while (stack.length > 0 && (stack[stack.length - 1]?.node.depth ?? -1) >= nextDepth) {
    const finished = stack.pop();
    if (!finished) return;
    const returnTo = stack.at(-1)?.alias ?? "Controller";
    lines.push(`    ${finished.alias}-->>-${returnTo}: result`);
  }
}

export function appendTracedCalls(lines: string[], result: RouteTraceResult): void {
  const root = result.call_chain[0];
  if (root) appendDbCalls(lines, result.db_calls, root, "Controller");

  const descendants = result.call_chain
    .filter((node, index) => index > 0 && node.depth > 0)
    .slice(0, 12);
  const aliases = new Map<string, string>();
  const stack: StackEntry[] = [];

  for (let index = 0; index < descendants.length; index++) {
    const node = descendants[index]!;
    closeStack(lines, stack, node.depth);
    const parentActor = stack.at(-1)?.alias ?? "Controller";
    const alias = nodeAlias(node, aliases);
    lines.push(`    ${parentActor}->>+${alias}: ${node.name}()`);
    appendDbCalls(lines, result.db_calls, node, alias);
    stack.push({ node, alias });
    closeStack(lines, stack, descendants[index + 1]?.depth ?? 0);
  }
  closeStack(lines, stack, 0);
}
