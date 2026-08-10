/**
 * HTTP route tracing — given a URL path, find handler → service → DB calls.
 * Framework discovery lives in focused modules; this file coordinates their results.
 */
import { join } from "node:path";
import type { CallNode, CodeSymbol } from "../types.js";
import { computeLayoutChain, scanDirective, traceMiddleware } from "../utils/nextjs.js";
import { findAstroHandlers } from "./astro-routes.js";
import { buildAdjacencyIndex, buildCallTree } from "./graph-tools.js";
import { getCodeIndex } from "./index-tools.js";
import { findExpressHandlers } from "./route-tools/express.js";
import { findHonoHandlers } from "./route-tools/hono.js";
import { findDjangoHandlers } from "./route-tools/django.js";
import { findKtorHandlers } from "./route-tools/ktor.js";
import { findLaravelHandlers } from "./route-tools/laravel.js";
import { findNestJSHandlers } from "./route-tools/nest.js";
import { findNextJSHandlers, findPagesRouterHandlers } from "./route-tools/next.js";
import { findFastAPIHandlers, findFlaskHandlers } from "./route-tools/python-decorators.js";
import { routeToMermaid } from "./route-tools/route-mermaid.js";
import { findSpringBootKotlinHandlers } from "./route-tools/spring-kotlin.js";
import type { DbCall, RouteTraceResult } from "./route-tools/types.js";
import { findYii2Handlers } from "./route-tools/yii2.js";

export { findNestJSHandlers } from "./route-tools/nest.js";
export { matchPath } from "./route-shared.js";
export { routeToMermaid } from "./route-tools/route-mermaid.js";
export type { RouteTraceResult } from "./route-tools/types.js";

const DB_PATTERNS = [
  /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|delete|upsert|count|aggregate|groupBy)/,
  /\.\$(transaction|queryRaw|executeRaw)/,
  /getRepository|\.query\(|\.execute\(/,
  /knex\.|\.raw\(/,
  // PHP / Yii2 ActiveRecord
  /->find\(\)|->findOne\(|->findAll\(|->findBySql\(/,
  /->createCommand\(|Yii::\$app->db/,
  /::find\(\)->where\(|->andWhere\(|->orWhere\(/,
  // Kotlin — Exposed ORM, Spring Data, Ktor
  /transaction\s*\{[\s\S]*?\.(select|insert|update|delete)/,
  /\.(findById|findAll|save|deleteById|findBy\w+)\s*\(/,
  /\bSchemaUtils\.(create|drop)/,
  // Python — Django ORM, SQLAlchemy
  /\.objects\.(get|filter|all|exclude|create|update|delete|aggregate|annotate|values|values_list|count|exists|first|last|bulk_create|bulk_update|get_or_create|update_or_create)\s*\(/,
  /\.query\.(filter|filter_by|get|all|first|one|one_or_none|join|outerjoin|subquery)\s*\(/,
  /session\.(add|delete|commit|rollback|flush|execute|query)\s*\(/,
  /\.select_related\(|\.prefetch_related\(/,
];

/**
 * Detect DB operations in a symbol's call chain.
 */
/**
 * Detect server actions in the call chain by checking for "use server" directive
 * at the file level (not function-body level).
 */
async function findServerActions(
  repoRoot: string,
  calleeSymbols: CodeSymbol[],
  callChain: Array<{ name: string; file: string; kind: string; depth: number }>,
): Promise<Array<{ name: string; file: string; called_from?: string | undefined }>> {
  const actions: Array<{ name: string; file: string; called_from?: string | undefined }> = [];
  const checkedFiles = new Map<string, boolean>();

  for (const sym of calleeSymbols) {
    const absPath = join(repoRoot, sym.file);

    let hasDirective: boolean;
    if (checkedFiles.has(sym.file)) {
      hasDirective = checkedFiles.get(sym.file)!;
    } else {
      const directive = await scanDirective(absPath);
      hasDirective = directive === "use server";
      checkedFiles.set(sym.file, hasDirective);
    }

    if (hasDirective) {
      // Find who called this symbol
      const callerIdx = callChain.findIndex(
        (c) => c.file === sym.file && c.name === sym.name,
      );
      const calledFrom = callerIdx > 0 ? callChain[callerIdx - 1]?.name : undefined;

      actions.push({
        name: sym.name,
        file: sym.file,
        called_from: calledFrom,
      });
    }
  }

  return actions;
}

function findDbCalls(symbols: CodeSymbol[]): DbCall[] {
  const calls: DbCall[] = [];
  for (const sym of symbols) {
    if (!sym.source) continue;
    for (const pattern of DB_PATTERNS) {
      const match = pattern.exec(sym.source);
      if (match) {
        calls.push({
          symbol_name: sym.name,
          file: sym.file,
          line: sym.start_line,
          operation: match[0],
        });
        break; // One match per symbol
      }
    }
  }
  return calls;
}

/**
 * Trace an HTTP route: find handler, trace callees, identify DB calls.
 */
export async function traceRoute(
  repo: string,
  path: string,
  outputFormat?: "json" | "mermaid",
): Promise<RouteTraceResult | { mermaid: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // Try all frameworks
  const astroHandlers = findAstroHandlers(index, path);
  const handlers = [
    ...(await findNestJSHandlers(index, path)),
    ...findNextJSHandlers(index, path),
    ...findPagesRouterHandlers(index, path),
    ...findExpressHandlers(index, path),
    ...(await findHonoHandlers(repo, index, path)),
    ...(await findYii2Handlers(index, path)),
    ...(await findLaravelHandlers(index, path)),
    ...(await findKtorHandlers(index, path)),
    ...(await findSpringBootKotlinHandlers(index, path)),
    ...astroHandlers,
    ...findFastAPIHandlers(index, path),
    ...findFlaskHandlers(index, path),
    ...(await findDjangoHandlers(index, path)),
  ];

  if (handlers.length === 0) {
    return { path, handlers: [], call_chain: [], db_calls: [] };
  }

  // Trace callees from handler symbols
  const adjacency = buildAdjacencyIndex(index.symbols, false);
  const callChain: Array<{ name: string; file: string; kind: string; depth: number }> = [];
  const allCalleeSymbols: CodeSymbol[] = [];

  for (const handler of handlers) {
    // Find the full symbol in index.
    // handler.symbol has a stripped ID (no repo prefix, from stripSource), so match
    // by file + name + start_line instead of id to avoid the prefix mismatch.
    const fullSym = index.symbols.find(
      (s) =>
        s.file === handler.symbol.file &&
        s.name === handler.symbol.name &&
        s.start_line === handler.symbol.start_line,
    );
    if (!fullSym) continue;

    const tree = buildCallTree(fullSym, adjacency, "callees", 3);
    // Flatten tree
    function flatten(node: CallNode, depth: number): void {
      callChain.push({ name: node.symbol.name, file: node.symbol.file, kind: node.symbol.kind, depth });
      allCalleeSymbols.push(node.symbol);
      for (const child of node.children) {
        flatten(child, depth + 1);
      }
    }
    flatten(tree, 0);
  }

  const dbCalls = findDbCalls(allCalleeSymbols);

  const result: RouteTraceResult = { path, handlers, call_chain: callChain, db_calls: dbCalls };

  // Next.js-specific: layout chain, middleware, and server actions tracing
  const hasNextjsHandler = handlers.some((h) => h.framework === "nextjs");
  if (hasNextjsHandler) {
    const repoRoot = index.root;

    // Layout chain from the first handler's file
    const firstFile = handlers[0]?.file;
    if (firstFile) {
      try {
        result.layout_chain = await computeLayoutChain(firstFile, repoRoot);
      } catch {
        result.layout_chain = [];
      }
    } else {
      result.layout_chain = [];
    }

    // Middleware tracing
    try {
      const mw = await traceMiddleware(repoRoot, path);
      if (mw) {
        result.middleware = mw;
      }
    } catch {
      // Middleware tracing failed — skip
    }

    // Server actions detection
    result.server_actions = await findServerActions(repoRoot, allCalleeSymbols, callChain);
  }

  if (outputFormat === "mermaid") {
    return { mermaid: routeToMermaid(result) };
  }

  return result;
}
