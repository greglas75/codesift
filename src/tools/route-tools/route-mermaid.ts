import { appendTracedCalls } from "./mermaid-call-chain.js";
import type { RouteTraceResult } from "./types.js";

function mermaidText(value: string): string {
  // Newlines were the only thing escaped, but Mermaid also breaks on quotes and bracket/brace
  // characters — and route labels are full of them (`/users/{id}`, `[slug]`). A single such path
  // corrupted the whole diagram, which fails as unparseable output rather than as a wrong label.
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/[[\]{}()<>;#|]/g, "_");
}

function appendRequest(lines: string[], result: RouteTraceResult, method: string): void {
  if (result.middleware?.applies) {
    lines.push("    participant Middleware");
    lines.push(`    Client->>+Middleware: ${method} ${mermaidText(result.path)}`);
    lines.push("    Middleware->>+Controller: continue");
  } else {
    lines.push(`    Client->>+Controller: ${method} ${mermaidText(result.path)}`);
  }
}

function appendLayouts(lines: string[], layoutChain: string[]): void {
  let previousActor = "Controller";
  for (let index = 0; index < layoutChain.length; index++) {
    const layoutName = `Layout${index + 1}`;
    lines.push(`    participant ${layoutName}`);
    lines.push(`    ${previousActor}->>+${layoutName}: render (${mermaidText(layoutChain[index]!)})`);
    previousActor = layoutName;
  }
}

function appendLayoutReturns(lines: string[], layoutCount: number): void {
  for (let index = layoutCount - 1; index >= 0; index--) {
    const layoutName = `Layout${index + 1}`;
    const returnTo = index > 0 ? `Layout${index}` : "Controller";
    lines.push(`    ${layoutName}-->>-${returnTo}: rendered`);
  }
}

function appendResponse(lines: string[], hasMiddleware: boolean): void {
  if (hasMiddleware) {
    lines.push("    Controller-->>-Middleware: response");
    lines.push("    Middleware-->>-Client: response");
  } else {
    lines.push("    Controller-->>-Client: response");
  }
}

/** Render a route trace as a Mermaid sequence diagram. */
export function routeToMermaid(result: RouteTraceResult): string {
  if (result.handlers.length === 0) {
    return "sequenceDiagram\n    Note over Client: No handler found for " + mermaidText(result.path);
  }

  const lines = ["sequenceDiagram"];
  appendRequest(lines, result, result.handlers[0]?.method ?? "REQUEST");
  appendLayouts(lines, result.layout_chain ?? []);
  appendTracedCalls(lines, result);
  appendLayoutReturns(lines, result.layout_chain?.length ?? 0);
  appendResponse(lines, result.middleware?.applies === true);
  return lines.join("\n");
}
