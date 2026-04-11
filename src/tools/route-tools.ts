/**
 * HTTP route tracing — given a URL path, find handler → service → DB calls.
 * Supports NestJS decorators, Next.js App Router, Express, Yii2 conventions, and Laravel routes.
 */
import { getCodeIndex } from "./index-tools.js";
import { buildAdjacencyIndex, buildCallTree, stripSource } from "./graph-tools.js";
import type { CodeSymbol, CodeIndex, CallNode, RouteFramework } from "../types.js";
import { findAstroHandlers } from "./astro-routes.js";
import { deriveUrlPath, computeLayoutChain, traceMiddleware, scanDirective } from "../utils/nextjs.js";
import type { MiddlewareTraceResult } from "../utils/nextjs.js";
import { join } from "node:path";

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
];

interface RouteHandler {
  symbol: ReturnType<typeof stripSource>;
  file: string;
  method?: string;
  framework: RouteFramework;
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
export function matchPath(routePath: string, searchPath: string): boolean {
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

    // Strip route groups: (auth)/login → login
    const filePath = routeMatch[1]!.replace(/\([^)]+\)\/?/g, "");
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
/**
 * Detect server actions in the call chain by checking for "use server" directive
 * at the file level (not function-body level).
 */
async function findServerActions(
  repoRoot: string,
  calleeSymbols: CodeSymbol[],
  callChain: Array<{ name: string; file: string; kind: string; depth: number }>,
): Promise<Array<{ name: string; file: string; called_from?: string }>> {
  const actions: Array<{ name: string; file: string; called_from?: string }> = [];
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
 * @internal exported for unit testing
 */
export function routeToMermaid(result: RouteTraceResult): string {
  if (result.handlers.length === 0) {
    return "sequenceDiagram\n    Note over Client: No handler found for " + result.path;
  }

  const lines: string[] = ["sequenceDiagram"];
  const handler = result.handlers[0]!;
  const method = handler.method ?? "REQUEST";
  const aliases = new Map<string, string>();

  // Add Middleware participant if middleware applies
  if (result.middleware?.applies) {
    lines.push(`    participant Middleware`);
    lines.push(`    Client->>+Middleware: ${method} ${result.path}`);
    lines.push(`    Middleware->>+Controller: continue`);
  } else {
    lines.push(`    Client->>+Controller: ${method} ${result.path}`);
  }

  // Add Layout chain rendering
  if (result.layout_chain && result.layout_chain.length > 0) {
    let prev = "Controller";
    for (let i = 0; i < result.layout_chain.length; i++) {
      const layoutName = `Layout${i + 1}`;
      const layoutFile = result.layout_chain[i]!;
      lines.push(`    participant ${layoutName}`);
      lines.push(`    ${prev}->>+${layoutName}: render (${layoutFile})`);
      prev = layoutName;
    }
  }

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

  // Close layout chain
  if (result.layout_chain && result.layout_chain.length > 0) {
    for (let i = result.layout_chain.length - 1; i >= 0; i--) {
      const layoutName = `Layout${i + 1}`;
      const returnTo = i > 0 ? `Layout${i}` : "Controller";
      lines.push(`    ${layoutName}-->>-${returnTo}: rendered`);
    }
  }

  if (result.middleware?.applies) {
    lines.push(`    Controller-->>-Middleware: response`);
    lines.push(`    Middleware-->>-Client: response`);
  } else {
    lines.push(`    Controller-->>-Client: response`);
  }
  return lines.join("\n");
}

/**
 * Find Yii2 route handlers via convention: controller-id/action-id → ControllerIdController::actionActionId().
 * Supports modules: module-id/controller-id/action-id.
 */
async function findYii2Handlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const normalized = searchPath.replace(/^\/|\/$/g, "").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length === 0) return handlers;

  // Determine controller ID and action ID
  // Patterns: "controller/action", "module/controller/action", "controller" (default action=index)
  let controllerId: string;
  let actionId: string;

  if (segments.length === 1) {
    controllerId = segments[0]!;
    actionId = "index";
  } else if (segments.length === 2) {
    controllerId = segments[0]!;
    actionId = segments[1]!;
  } else {
    // Module routing: take last two segments as controller/action
    controllerId = segments[segments.length - 2]!;
    actionId = segments[segments.length - 1]!;
  }

  // Convert kebab-case to PascalCase for class name: "site" → "Site", "user-comment" → "UserComment"
  const toPascal = (s: string): string =>
    s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");

  // Convert kebab-case to camelCase for action method: "hello-world" → "HelloWorld"
  const toCamelAction = (s: string): string =>
    s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");

  const controllerName = toPascal(controllerId) + "Controller";
  const actionMethod = "action" + toCamelAction(actionId);

  // Find controller class in index
  const controllerSymbol = index.symbols.find(
    (s) => s.name === controllerName && s.kind === "class",
  );

  if (!controllerSymbol) {
    // Fallback: try urlManager rules from config/web.php
    return findYii2HandlersFromConfig(index, searchPath);
  }

  // Find action method within the controller
  const actionSymbol = index.symbols.find(
    (s) => s.name === actionMethod && s.parent === controllerSymbol.id,
  );

  if (actionSymbol) {
    handlers.push({
      symbol: stripSource(actionSymbol),
      file: actionSymbol.file,
      method: "GET",
      framework: "yii2",
    });
  } else {
    // Fallback: controller found but action method not indexed — report controller
    handlers.push({
      symbol: stripSource(controllerSymbol),
      file: controllerSymbol.file,
      framework: "yii2",
    });
  }

  return handlers;
}

/**
 * Fallback: parse Yii2 urlManager rules from config/web.php.
 * Matches patterns like: 'GET api/users/<id>' => 'user/view'
 */
async function findYii2HandlersFromConfig(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const configFile = index.files.find((f) => /config\/web\.php$/.test(f.path));
  if (!configFile) return handlers;

  const { readFile: rf } = await import("node:fs/promises");
  const { join: j } = await import("node:path");
  let source: string;
  try {
    source = await rf(j(index.root, configFile.path), "utf-8");
  } catch { return handlers; }

  const normalized = searchPath.replace(/^\/|\/$/g, "").toLowerCase();

  // Match: 'route/pattern' => 'controller/action' or ['GET method/pattern'] => 'controller/action'
  const ruleRe = /['"](?:(?:GET|POST|PUT|DELETE|PATCH)\s+)?([^'"]+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(source)) !== null) {
    const rulePattern = match[1]!.replace(/<\w+(?::[^>]+)?>/g, "[param]").toLowerCase();
    if (!matchPath(rulePattern, normalized)) continue;

    const route = match[2]!; // e.g. "user/view"
    const parts = route.split("/");
    if (parts.length < 2) continue;

    const controllerId = parts[parts.length - 2]!;
    const actionId = parts[parts.length - 1]!;
    const toPascal = (s: string): string =>
      s.split("-").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");

    const controllerName = toPascal(controllerId) + "Controller";
    const actionMethod = "action" + toPascal(actionId);

    const ctrlSym = index.symbols.find(s => s.name === controllerName && s.kind === "class");
    if (!ctrlSym) continue;

    const actionSym = index.symbols.find(s => s.name === actionMethod && s.parent === ctrlSym.id);
    handlers.push({
      symbol: stripSource(actionSym ?? ctrlSym),
      file: (actionSym ?? ctrlSym).file,
      method: "GET",
      framework: "yii2",
    });
  }

  return handlers;
}

/**
 * Find Laravel route handlers by scanning route files for Route::method() patterns.
 */
async function findLaravelHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const routeFiles = index.files.filter((f) =>
    /routes\/(web|api)\.php$/.test(f.path),
  );

  if (routeFiles.length === 0) return handlers;

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const methods = ["get", "post", "put", "delete", "patch"];

  for (const file of routeFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch { continue; }

    for (const method of methods) {
      // Match: Route::get('/path', [Controller::class, 'method']) or Route::get('/path', 'Controller@method')
      const re = new RegExp(
        `Route::${method}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*(?:\\[([\\w\\\\]+)::class\\s*,\\s*['"\`](\\w+)['"\`]\\]|['"\`](\\w+)@(\\w+)['"\`])`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const routePath = match[1] ?? "";
        const controllerClass = match[2] ?? match[4] ?? "";
        const methodName = match[3] ?? match[5] ?? "";

        if (!matchPath(routePath, searchPath)) continue;

        // Find the controller method in the index
        const controllerName = controllerClass.split("\\").pop() ?? controllerClass;
        const sym = index.symbols.find(
          (s) => s.name === methodName && s.kind === "method" &&
            index.symbols.some((c) => c.id === s.parent && c.name === controllerName),
        );

        handlers.push({
          symbol: sym
            ? stripSource(sym)
            : { id: `${controllerName}::${methodName}`, name: methodName, kind: "method", file: file.path, start_line: 0, end_line: 0 } as ReturnType<typeof stripSource>,
          file: sym?.file ?? file.path,
          method: method.toUpperCase(),
          framework: "laravel",
        });
      }
    }
  }

  return handlers;
}

/**
 * Find Ktor route handlers via `routing { get("/path") { ... } }` DSL.
 * Supports nested `route("/prefix") { get("/sub") { } }` patterns.
 */
async function findKtorHandlers(index: CodeIndex, searchPath: string): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"];

  // Ktor handlers are in .kt files, typically in files containing "routing {" or with "Route" in name
  const kotlinFiles = index.files.filter((f) => /\.kts?$/.test(f.path));
  if (kotlinFiles.length === 0) return handlers;

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const file of kotlinFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch { continue; }

    // Skip files without routing DSL
    if (!/\b(routing|route)\s*[({]/.test(source)) continue;

    // Extract route("/prefix") blocks to support nested prefixes
    // Simple approach: find all method calls with path args, combine with enclosing route() prefix via line scan
    const lines = source.split("\n");
    const prefixStack: Array<{ prefix: string; braceDepth: number }> = [];
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Track route("/prefix") { ... } blocks
      const routeMatch = /\broute\s*\(\s*["']([^"']+)["']\s*\)\s*\{/.exec(line);
      if (routeMatch) {
        prefixStack.push({ prefix: routeMatch[1]!, braceDepth });
      }

      // Count braces to detect when route() scope closes
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          braceDepth--;
          // Pop route prefixes whose scope ended
          while (
            prefixStack.length > 0 &&
            prefixStack[prefixStack.length - 1]!.braceDepth >= braceDepth
          ) {
            prefixStack.pop();
          }
        }
      }

      // Match method handlers: get("/path") { ... } or post("/path") { ... }
      for (const method of methods) {
        const re = new RegExp(`\\b${method}\\s*\\(\\s*["']([^"']+)["']\\s*\\)\\s*\\{`);
        const match = re.exec(line);
        if (!match) continue;

        const methodPath = match[1]!;
        const prefix = prefixStack.map((p) => p.prefix).join("");
        const fullPath = `${prefix}/${methodPath}`.replace(/\/+/g, "/");

        if (!matchPath(fullPath, searchPath)) continue;

        // Find enclosing function symbol (if any) for this line
        const lineNum = i + 1;
        const sym = index.symbols.find(
          (s) => s.file === file.path && s.start_line <= lineNum && s.end_line >= lineNum,
        );

        handlers.push({
          symbol: sym
            ? stripSource(sym)
            : {
                id: `${file.path}:${method}:${methodPath}`,
                name: `${method} ${methodPath}`,
                kind: "function",
                file: file.path,
                start_line: lineNum,
                end_line: lineNum,
              } as ReturnType<typeof stripSource>,
          file: file.path,
          method: method.toUpperCase(),
          framework: "ktor",
        });
      }
    }
  }

  return handlers;
}

/**
 * Find Spring Boot Kotlin route handlers via @RestController/@Controller + @GetMapping/etc.
 */
async function findSpringBootKotlinHandlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  const mappingAnnotations: Array<{ ann: string; method: string }> = [
    { ann: "GetMapping", method: "GET" },
    { ann: "PostMapping", method: "POST" },
    { ann: "PutMapping", method: "PUT" },
    { ann: "DeleteMapping", method: "DELETE" },
    { ann: "PatchMapping", method: "PATCH" },
  ];

  const kotlinFiles = index.files.filter((f) => /\.kts?$/.test(f.path));
  if (kotlinFiles.length === 0) return handlers;

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  for (const file of kotlinFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch { continue; }

    // Must have @RestController or @Controller annotation
    if (!/@(?:RestController|Controller)\b/.test(source)) continue;

    // Extract class-level @RequestMapping prefix (optional)
    const classRequestMatch = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']/.exec(source);
    const classPrefix = classRequestMatch?.[1] ?? "";

    for (const { ann, method } of mappingAnnotations) {
      // Match: @GetMapping("/path") fun funcName(...)
      // Or:    @GetMapping(value = "/path") fun funcName(...)
      const re = new RegExp(
        `@${ann}\\s*\\(\\s*(?:value\\s*=\\s*)?["']([^"']*)["'](?:[^)]*)?\\)\\s*(?:fun|\\n\\s*fun)\\s+(\\w+)`,
        "g",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const routePath = match[1] ?? "";
        const funcName = match[2] ?? "";

        const fullPath = `${classPrefix}/${routePath}`.replace(/\/+/g, "/");
        if (!matchPath(fullPath, searchPath)) continue;

        const sym = index.symbols.find(
          (s) => s.file === file.path && s.name === funcName,
        );

        handlers.push({
          symbol: sym
            ? stripSource(sym)
            : {
                id: `${file.path}:${funcName}`,
                name: funcName,
                kind: "method",
                file: file.path,
                start_line: 1,
                end_line: 1,
              } as ReturnType<typeof stripSource>,
          file: file.path,
          method,
          framework: "spring-kotlin",
        });
      }
    }
  }

  return handlers;
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
    ...(await findYii2Handlers(index, path)),
    ...(await findLaravelHandlers(index, path)),
    ...(await findKtorHandlers(index, path)),
    ...(await findSpringBootKotlinHandlers(index, path)),
    ...astroHandlers,
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
