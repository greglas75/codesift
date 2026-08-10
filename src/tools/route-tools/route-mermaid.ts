import type { DbCall, RouteCallNode, RouteTraceResult } from "./types.js";

function nodeKey(node: Pick<RouteCallNode, "name" | "file">): string {
  return `${node.file}:${node.name}`;
}

function nodeAlias(
  node: Pick<RouteCallNode, "name" | "file">,
  aliases: Map<string, string>,
): string {
  const key = nodeKey(node);
  const existing = aliases.get(key);
  if (existing) return existing;

  const baseName = node.file.split("/").pop()?.replace(/\.\w+$/, "") ?? node.name;
  const alias = `${baseName}_${node.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
  aliases.set(key, alias);
  return alias;
}

function appendDbCalls(
  lines: string[],
  dbCalls: DbCall[],
  node: Pick<RouteCallNode, "name" | "file">,
  actor: string,
): void {
  const callsForNode = dbCalls.filter((db) =>
    db.file === node.file && db.symbol_name === node.name,
  );

  for (const db of callsForNode.slice(0, 3)) {
    lines.push(`    ${actor}->>+DB: ${db.operation}`);
    lines.push(`    DB-->>-${actor}: result`);
  }
}

/** Render a route trace as a Mermaid sequence diagram. */
export function routeToMermaid(result: RouteTraceResult): string {
  if (result.handlers.length === 0) {
    return "sequenceDiagram\n    Note over Client: No handler found for " + result.path;
  }

  const lines: string[] = ["sequenceDiagram"];
  const handler = result.handlers[0]!;
  const method = handler.method ?? "REQUEST";
  const aliases = new Map<string, string>();

  if (result.middleware?.applies) {
    lines.push("    participant Middleware");
    lines.push(`    Client->>+Middleware: ${method} ${result.path}`);
    lines.push("    Middleware->>+Controller: continue");
  } else {
    lines.push(`    Client->>+Controller: ${method} ${result.path}`);
  }

  if (result.layout_chain && result.layout_chain.length > 0) {
    let previousActor = "Controller";
    for (let index = 0; index < result.layout_chain.length; index++) {
      const layoutName = `Layout${index + 1}`;
      lines.push(`    participant ${layoutName}`);
      lines.push(`    ${previousActor}->>+${layoutName}: render (${result.layout_chain[index]!})`);
      previousActor = layoutName;
    }
  }

  const root = result.call_chain[0];
  if (root) appendDbCalls(lines, result.db_calls, root, "Controller");

  const descendants = result.call_chain
    .filter((node, index) => index > 0 && node.depth > 0)
    .slice(0, 12);
  const stack: Array<{ node: RouteCallNode; alias: string }> = [];
  const closeUntilDepth = (nextDepth: number): void => {
    while (stack.length > 0 && (stack[stack.length - 1]?.node.depth ?? -1) >= nextDepth) {
      const finished = stack.pop();
      if (!finished) break;
      const returnTo = stack.length > 0 ? stack[stack.length - 1]!.alias : "Controller";
      lines.push(`    ${finished.alias}-->>-${returnTo}: result`);
    }
  };

  for (let index = 0; index < descendants.length; index++) {
    const node = descendants[index]!;
    closeUntilDepth(node.depth);
    const parentActor = stack.length > 0 ? stack[stack.length - 1]!.alias : "Controller";
    const alias = nodeAlias(node, aliases);
    lines.push(`    ${parentActor}->>+${alias}: ${node.name}()`);
    appendDbCalls(lines, result.db_calls, node, alias);
    stack.push({ node, alias });
    closeUntilDepth(descendants[index + 1]?.depth ?? 0);
  }
  closeUntilDepth(0);

  if (result.layout_chain && result.layout_chain.length > 0) {
    for (let index = result.layout_chain.length - 1; index >= 0; index--) {
      const layoutName = `Layout${index + 1}`;
      const returnTo = index > 0 ? `Layout${index}` : "Controller";
      lines.push(`    ${layoutName}-->>-${returnTo}: rendered`);
    }
  }

  if (result.middleware?.applies) {
    lines.push("    Controller-->>-Middleware: response");
    lines.push("    Middleware-->>-Client: response");
  } else {
    lines.push("    Controller-->>-Client: response");
  }
  return lines.join("\n");
}
