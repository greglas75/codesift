/**
 * HTTP route tracing — given a URL path, find handler → service → DB calls.
 * Supports NestJS decorators, Next.js App Router, and Express patterns.
 */
import { getCodeIndex } from "./index-tools.js";
import { buildAdjacencyIndex, buildCallTree, stripSource } from "./graph-tools.js";
import type { CodeSymbol, CodeIndex, CallNode } from "../types.js";
import { deriveUrlPath, computeLayoutChain, traceMiddleware } from "../utils/nextjs.js";
import type { MiddlewareTraceResult } from "../utils/nextjs.js";

const DB_PATTERNS = [
  /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|delete|upsert|count|aggregate|groupBy)/,
  /\.\$(transaction|queryRaw|executeRaw)/,
  /getRepository|\.query\(|\.execute\(/,
  /knex\.|\.raw\(/,
];

interface RouteHandler {
  symbol: ReturnType<typeof stripSource>;
  file: string;
  method?: string;
  framework: "nestjs" | "nextjs" | "express" | "unknown";
  router?: "app" | "pages";
}

interface DbCall {
  symbol_name: string;
  file: string;
  line: number;
  operation: string;
}

export interface RouteTraceResult {
  path: string;
  handlers: RouteHandler[];
  call_chain: Array<{ name: string; file: string; kind: string; depth: number }>;
  db_calls: DbCall[];
  middleware?: MiddlewareTraceResult;
  layout_chain?: string[];
  server_actions?: Array<{ name: string; file: string; called_from?: string }>;
}

type RouteCallNode = RouteTraceResult["call_chain"][number];

/**
 * Match a URL path pattern against a route definition.
 * Handles :param, [param], [...param], [[...param]] as wildcards.
 */
function matchPath(routePath: string, searchPath: string): boolean {
  const normalize = (p: string) => p.replace(/^\/|\/$/g, "").toLowerCase();
  const routeParts = normalize(routePath).split("/");
  const searchParts = normalize(searchPath).split("/");

  if (routeParts.length !== searchParts.length) return false;

  for (let i = 0; i < routeParts.length; i++) {
    const rp = routeParts[i]!;
    const sp = searchParts[i]!;
    // Dynamic segments: :id, [id], [...slug], [[...slug]]
    if (rp.startsWith(":") || rp.startsWith("[")) continue;
    if (rp !== sp) return false;
  }
  return true;
}

/**
 * Find NestJS route handlers via @Controller + @Get/@Post/etc. decorators.
 * Reads raw file content because tree-sitter symbol source may not include decorators.
 */
async function findNestJSHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const methods = ["Get", "Post", "Put", "Delete", "Patch"];

  // Find controller files
  const controllerFiles = index.files.filter((f) =>
    f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const file of controllerFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch { continue; }

    // Extract controller prefix
    const ctrlMatch = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source);
    const controllerPrefix = ctrlMatch?.[1] ?? "";

    for (const method of methods) {
      const re = new RegExp(`@${method}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)\\s*\\n\\s*(?:async\\s+)?(\\w+)`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const routePath = match[1] ?? "";
        const funcName = match[2] ?? "";

        const fullPath = `/${controllerPrefix}/${routePath}`.replace(/\/+/g, "/");
        if (matchPath(fullPath, searchPath)) {
          const sym = index.symbols.find((s) => s.file === file.path && s.name === funcName);
          handlers.push({
            symbol: sym ? stripSource(sym) : { id: `${file.path}:${funcName}`, name: funcName, kind: "method", file: file.path, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
            file: file.path,
            method: method.toUpperCase(),
            framework: "nestjs",
          });
        }
      }
    }
  }

  return handlers;
}

/**
 * Find Next.js App Router handlers — file path IS the route.
 */
function findNextJSHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const normalized = searchPath.replace(/^\/|\/$/g, "");

  for (const file of index.files) {
    // Match app/api/...route.{ts,tsx,js,jsx} or app/...route.{ts,tsx,js,jsx}
    if (!/\/route\.[jt]sx?$/.test(file.path)) continue;

    // Extract route path from file path: app/api/users/[id]/route.ts → /api/users/[id]
    const routeMatch = file.path.match(/app\/(.*?)\/route\.[jt]sx?$/);
    if (!routeMatch) continue;

    const filePath = routeMatch[1]!;
    if (matchPath(filePath, normalized)) {
      // Find exported handler functions (GET, POST, etc.)
      const fileSymbols = index.symbols.filter((s) =>
        s.file === file.path && /^(GET|POST|PUT|DELETE|PATCH)$/.test(s.name),
      );

      for (const sym of fileSymbols) {
        handlers.push({
          symbol: stripSource(sym),
          file: sym.file,
          method: sym.name,
          framework: "nextjs",
          router: "app",
        });
      }

      // If no named exports found, add the file itself
      if (fileSymbols.length === 0) {
        handlers.push({
          symbol: { id: file.path, name: "route", kind: "function", file: file.path, start_line: 1, end_line: 1 } as ReturnType<typeof stripSource>,
          file: file.path,
          framework: "nextjs",
          router: "app",
        });
      }
    }
  }

  return handlers;
}

/**
 * Find Pages Router API route handlers via default exports in pages/api/.
 * @internal exported for unit testing
 */
function findPagesRouterHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];

  for (const file of index.files) {
    // Only match files under pages/api/
    if (!/pages\/api\//.test(file.path)) continue;

    // Derive URL path from file path
    const urlPath = deriveUrlPath(file.path, "pages");
    const normalizedSearch = searchPath.replace(/^\/|\/$/g, "");
    const normalizedUrl = urlPath.replace(/^\/|\/$/g, "");

    if (normalizedUrl !== normalizedSearch) continue;

    // Find default export or named handler in the file
    const fileSymbols = index.symbols.filter((s) => s.file === file.path);

    // Look for default export
    const defaultExport = fileSymbols.find((s) => s.name === "default" || s.name === "handler");

    if (defaultExport) {
      handlers.push({
        symbol: stripSource(defaultExport),
        file: file.path,
        framework: "nextjs",
        router: "pages",
      });
    } else if (fileSymbols.length > 0) {
      // Try variable indirection: find any exported function
      const exported = fileSymbols.find((s) =>
        s.kind === "function" || s.kind === "variable",
      );
      if (exported) {
        handlers.push({
          symbol: stripSource(exported),
          file: file.path,
          framework: "nextjs",
          router: "pages",
        });
      }
    }

    // Fallback: at least mark the file as having a handler
    if (handlers.filter((h) => h.file === file.path).length === 0) {
      handlers.push({
        symbol: {
          id: file.path, name: "handler", kind: "function",
          file: file.path, start_line: 1, end_line: 1,
        } as ReturnType<typeof stripSource>,
        file: file.path,
        framework: "nextjs",
        router: "pages",
      });
    }
  }

  return handlers;
}

/**
 * Find Express-style route handlers via router.get/app.post patterns.
 */
function findExpressHandlers(index: CodeIndex, searchPath: string): RouteHandler[] {
  const handlers: RouteHandler[] = [];
  const methods = ["get", "post", "put", "delete", "patch"];

  for (const sym of index.symbols) {
    if (!sym.source) continue;

    for (const method of methods) {
      const re = new RegExp(`\\.(${method})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`);
      const match = re.exec(sym.source);
      if (!match) continue;

      const routePath = match[2] ?? "";
      if (matchPath(routePath, searchPath)) {
        handlers.push({
          symbol: stripSource(sym),
          file: sym.file,
          method: method.toUpperCase(),
          framework: "express",
        });
      }
    }
  }

  return handlers;
}

/**
 * Detect DB operations in a symbol's call chain.
 */
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

/**
 * Render a RouteTraceResult as a Mermaid sequence diagram.
 */
function routeToMermaid(result: RouteTraceResult): string {
  if (result.handlers.length === 0) {
    return "sequenceDiagram\n    Note over Client: No handler found for " + result.path;
  }

  const lines: string[] = ["sequenceDiagram"];
  const handler = result.handlers[0]!;
  const method = handler.method ?? "REQUEST";
  const aliases = new Map<string, string>();

  lines.push(`    Client->>+Controller: ${method} ${result.path}`);

  const root = result.call_chain[0];
  if (root) {
    appendDbCalls(lines, result.db_calls, root, "Controller");
  }

  const descendants = result.call_chain
    .filter((node, idx) => idx > 0 && node.depth > 0)
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

  for (let i = 0; i < descendants.length; i++) {
    const node = descendants[i]!;
    closeUntilDepth(node.depth);

    const parentActor = stack.length > 0 ? stack[stack.length - 1]!.alias : "Controller";
    const alias = nodeAlias(node, aliases);
    lines.push(`    ${parentActor}->>+${alias}: ${node.name}()`);
    appendDbCalls(lines, result.db_calls, node, alias);
    stack.push({ node, alias });

    const nextDepth = descendants[i + 1]?.depth ?? 0;
    closeUntilDepth(nextDepth);
  }

  closeUntilDepth(0);
  lines.push(`    Controller-->>-Client: response`);
  return lines.join("\n");
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
  const handlers = [
    ...(await findNestJSHandlers(index, path)),
    ...findNextJSHandlers(index, path),
    ...findPagesRouterHandlers(index, path),
    ...findExpressHandlers(index, path),
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

  // Next.js-specific: layout chain and middleware tracing
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
  }

  if (outputFormat === "mermaid") {
    return { mermaid: routeToMermaid(result) };
  }

  return result;
}
