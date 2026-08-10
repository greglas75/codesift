import { join } from "node:path";
import type { CodeIndex, CodeSymbol } from "../../types.js";
import { computeLayoutChain, scanDirective, traceMiddleware } from "../../utils/nextjs.js";
import type { RouteHandler, RouteTraceResult } from "./types.js";

async function findServerActions(
  repoRoot: string,
  calleeSymbols: CodeSymbol[],
  callChain: RouteTraceResult["call_chain"],
): Promise<NonNullable<RouteTraceResult["server_actions"]>> {
  const actions: NonNullable<RouteTraceResult["server_actions"]> = [];
  const uniqueFiles = [...new Set(calleeSymbols.map((symbol) => symbol.file))];
  const directiveEntries = await Promise.all(uniqueFiles.map(async (file) => [
    file,
    await scanDirective(join(repoRoot, file)) === "use server",
  ] as const));
  const hasServerDirective = new Map(directiveEntries);

  for (const symbol of calleeSymbols) {
    if (!hasServerDirective.get(symbol.file)) continue;

    const callerIndex = callChain.findIndex(
      (node) => node.file === symbol.file && node.name === symbol.name,
    );
    actions.push({
      name: symbol.name,
      file: symbol.file,
      called_from: callerIndex > 0 ? callChain[callerIndex - 1]?.name : undefined,
    });
  }
  return actions;
}

export async function enrichNextjsTrace(
  result: RouteTraceResult,
  index: CodeIndex,
  handlers: RouteHandler[],
  calleeSymbols: CodeSymbol[],
): Promise<void> {
  if (!handlers.some((handler) => handler.framework === "nextjs")) return;

  const firstFile = handlers[0]?.file;
  if (firstFile) {
    try {
      result.layout_chain = await computeLayoutChain(firstFile, index.root);
    } catch {
      result.layout_chain = [];
    }
  } else {
    result.layout_chain = [];
  }

  try {
    const middleware = await traceMiddleware(index.root, result.path);
    if (middleware) result.middleware = middleware;
  } catch {
    // Optional middleware analysis must not make route tracing fail.
  }

  result.server_actions = await findServerActions(
    index.root,
    calleeSymbols,
    result.call_chain,
  );
}
