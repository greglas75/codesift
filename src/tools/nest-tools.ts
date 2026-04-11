/**
 * NestJS analysis tools — B1-B5 + C (nest_audit meta-orchestrator).
 * Discoverable via discover_tools(query="nestjs").
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { extractNestConventions } from "./project-tools.js";

// ---------------------------------------------------------------------------
// Shared error type for per-file skip warnings (CQ8)
// ---------------------------------------------------------------------------

export interface NestToolError {
  file: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// B5: nest_lifecycle_map — types + implementation
// ---------------------------------------------------------------------------

const LIFECYCLE_HOOKS = new Set([
  "onModuleInit",
  "onModuleDestroy",
  "onApplicationBootstrap",
  "onApplicationShutdown",
  "beforeApplicationShutdown",
]);

export interface NestLifecycleEntry {
  class_name: string;
  file: string;
  hook: string;
  is_async: boolean;
}

export interface NestLifecycleMapResult {
  hooks: NestLifecycleEntry[];
  errors?: NestToolError[];
}

export async function nestLifecycleMap(
  repo: string,
): Promise<NestLifecycleMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const hooks: NestLifecycleEntry[] = [];
  const errors: NestToolError[] = [];

  for (const sym of index.symbols) {
    if (!LIFECYCLE_HOOKS.has(sym.name)) continue;
    if (sym.kind !== "method" && sym.kind !== "function") continue;

    // Determine parent class name from source or file context
    let className = "Unknown";
    const source = sym.source ?? "";

    // Try to find the enclosing class via parent_id (if available)
    const symAny = sym as unknown as { parent_id?: string };
    if (symAny.parent_id) {
      const parentSym = index.symbols.find((s) => s.id === symAny.parent_id);
      if (parentSym) className = parentSym.name;
    }

    // Fallback: look for class name in source
    if (className === "Unknown") {
      // Check if there's a class symbol in the same file that contains this method
      const classSym = index.symbols.find(
        (s) => s.file === sym.file && s.kind === "class" && s.start_line <= sym.start_line && s.end_line >= sym.end_line,
      );
      if (classSym) className = classSym.name;
    }

    const isAsync = /async\s/.test(source.slice(0, 50));

    hooks.push({
      class_name: className,
      file: sym.file,
      hook: sym.name,
      is_async: isAsync,
    });
  }

  return { hooks, ...(errors.length > 0 ? { errors } : {}) };
}

// ---------------------------------------------------------------------------
// B3: nest_module_graph — types (implementation in Task 6)
// ---------------------------------------------------------------------------

export interface NestModuleNode {
  name: string;
  file: string;
  is_global: boolean;
  imports: string[];
  exports: string[];
  providers: string[];
  controllers: string[];
}

export interface NestModuleGraphResult {
  modules: NestModuleNode[];
  edges: Array<{ from: string; to: string }>;
  circular_deps: string[][];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestModuleGraph(
  repo: string,
  options?: { max_modules?: number; output_format?: "json" | "mermaid" },
): Promise<NestModuleGraphResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxModules = options?.max_modules ?? 200;
  const moduleFiles = index.files.filter((f) => f.path.endsWith(".module.ts") || f.path.endsWith(".module.js"));

  const modules: NestModuleNode[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Parse each module file
  for (const file of moduleFiles) {
    if (modules.length >= maxModules) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const conv = extractNestConventions(source, file.path);

    // Find the module class name from source
    const classMatch = /export\s+class\s+(\w+Module)\b/.exec(source);
    const moduleName = classMatch?.[1] ?? file.path.replace(/.*\//, "").replace(/\.module\.[jt]sx?$/, "Module");

    // Check for @Global()
    const isGlobal = /@Global\s*\(\s*\)/.test(source) || conv.modules.some((m) => m.is_global && m.name === moduleName);

    // Extract exports array
    const exportNames: string[] = [];
    const exportsMatch = /exports:\s*\[([^\]]*)\]/s.exec(source);
    if (exportsMatch) {
      const inner = exportsMatch[1]!;
      for (const m of inner.matchAll(/(\w+)/g)) {
        exportNames.push(m[1]!);
      }
    }

    // Extract provider names
    const providerNames: string[] = [];
    const providersMatch = /providers:\s*\[([^\]]*)\]/s.exec(source);
    if (providersMatch) {
      const inner = providersMatch[1]!;
      for (const m of inner.matchAll(/(?:useClass:\s*)?(\w+(?:Service|Provider|Guard|Interceptor|Pipe|Filter|Factory|Strategy))\b/g)) {
        providerNames.push(m[1]!);
      }
    }

    modules.push({
      name: moduleName,
      file: file.path,
      is_global: isGlobal,
      imports: conv.modules.map((m) => m.name),
      exports: exportNames,
      providers: providerNames,
      controllers: conv.controllers,
    });
  }

  // Build edges: module → imported module
  const moduleNames = new Set(modules.map((m) => m.name));
  for (const mod of modules) {
    for (const imp of mod.imports) {
      if (moduleNames.has(imp)) {
        edges.push({ from: mod.name, to: imp });
      }
    }
  }

  // Detect circular deps via DFS
  const circular_deps = detectCycles(modules.map((m) => m.name), edges);

  return {
    modules,
    edges,
    circular_deps,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/** DFS cycle detection on directed graph */
function detectCycles(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) cycles.push(path.slice(cycleStart).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const next of adj.get(node) ?? []) dfs(next);
    path.pop();
    inStack.delete(node);
  }

  for (const n of nodes) dfs(n);
  return cycles;
}

// ---------------------------------------------------------------------------
// B1: nest_di_graph — types (implementation in Task 7)
// ---------------------------------------------------------------------------

export interface NestDINode {
  name: string;
  file: string;
  kind: "provider" | "module" | "controller";
  scope?: string;
}

export interface NestDIEdge {
  from: string;
  to: string;
  via: "inject" | "import";
}

export interface NestDIGraphResult {
  nodes: NestDINode[];
  edges: NestDIEdge[];
  cycles: string[][];
  cross_module_warnings: Array<{ provider: string; used_in: string; defined_in: string }>;
  errors?: NestToolError[];
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers: constructor injection parsing (CQ14)
// ---------------------------------------------------------------------------

/** Extract constructor parameter body using paren counting (handles decorated params) */
function extractConstructorBody(source: string): string | null {
  const ctorIdx = source.indexOf("constructor(");
  if (ctorIdx === -1) return null;
  const start = ctorIdx + "constructor(".length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") depth--;
    i++;
  }
  return depth === 0 ? source.slice(start, i - 1) : null;
}

/** Extract injected type names from a constructor body string */
function extractInjectedTypes(ctorBody: string): string[] {
  const types: string[] = [];
  // Split by commas (respecting nested parens)
  const params: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of ctorBody) {
    if (ch === "(" || ch === "<") depth++;
    else if (ch === ")" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());

  for (const param of params) {
    // Extract type after the last `:` — handles decorators before the param name
    const colonIdx = param.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const typeStr = param.slice(colonIdx + 1).trim();
    // Get first word (class name, before generics)
    const typeMatch = typeStr.match(/^(\w+)/);
    if (typeMatch) types.push(typeMatch[1]!);
  }
  return types;
}

/** Parse @Injectable() classes from source */
function parseInjectableClasses(source: string): Array<{ name: string; scope?: string }> {
  const results: Array<{ name: string; scope?: string }> = [];
  const re = /@Injectable\s*\(([^)]*)\)\s*(?:export\s+)?class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const args = m[1] ?? "";
    const name = m[2]!;
    const scopeMatch = args.match(/scope:\s*Scope\.(\w+)/);
    results.push({ name, ...(scopeMatch ? { scope: scopeMatch[1] } : {}) });
  }
  return results;
}

export async function nestDIGraph(
  repo: string,
  options?: { max_nodes?: number; focus?: string },
): Promise<NestDIGraphResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxNodes = options?.max_nodes ?? 200;
  const focus = options?.focus;
  const nodes: NestDINode[] = [];
  const edges: NestDIEdge[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Scan files for @Injectable classes
  const candidateFiles = index.files.filter((f) => {
    if (focus && !f.path.includes(focus)) return false;
    return f.path.endsWith(".ts") || f.path.endsWith(".js");
  });

  for (const file of candidateFiles) {
    if (nodes.length >= maxNodes) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const injectables = parseInjectableClasses(source);
    for (const inj of injectables) {
      if (nodes.length >= maxNodes) { truncated = true; break; }
      nodes.push({
        name: inj.name,
        file: file.path,
        kind: "provider",
        ...(inj.scope ? { scope: inj.scope } : {}),
      });

      // Extract constructor injection
      // Find the class body for this specific injectable
      const classIdx = source.indexOf(`class ${inj.name}`);
      if (classIdx === -1) continue;
      const classSource = source.slice(classIdx);
      const ctorBody = extractConstructorBody(classSource);
      if (!ctorBody) continue;
      const injectedTypes = extractInjectedTypes(ctorBody);
      for (const type of injectedTypes) {
        edges.push({ from: inj.name, to: type, via: "inject" });
      }
    }
  }

  // Detect cycles
  const nodeNames = nodes.map((n) => n.name);
  const cycles = detectCycles(nodeNames, edges.map((e) => ({ from: e.from, to: e.to })));

  return {
    nodes,
    edges,
    cycles,
    cross_module_warnings: [], // TODO: implement cross-module warnings in future task
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// B2: nest_guard_chain — types (implementation in Task 8)
// ---------------------------------------------------------------------------

export interface NestGuardChainEntry {
  route: string;
  method: string;
  controller: string;
  file: string;
  chain: Array<{
    layer: "global" | "controller" | "method";
    type: "guard" | "interceptor" | "pipe" | "filter";
    name: string;
    file?: string;
  }>;
}

export interface NestGuardChainResult {
  routes: NestGuardChainEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers: guard/interceptor/pipe parsing (CQ14)
// ---------------------------------------------------------------------------

/** Parse @UseGuards(...) from source, returns guard class names */
function parseUseGuards(source: string): string[] {
  const results: string[] = [];
  const re = /@UseGuards\s*\(\s*([\w\s,]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (const name of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      results.push(name);
    }
  }
  return results;
}

/** Parse @UseInterceptors(...) from source */
function parseUseInterceptors(source: string): string[] {
  const results: string[] = [];
  const re = /@UseInterceptors\s*\(\s*([\w\s,]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (const name of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      results.push(name);
    }
  }
  return results;
}

/** Parse @UsePipes(...) from source */
function parseUsePipes(source: string): string[] {
  const results: string[] = [];
  const re = /@UsePipes\s*\(\s*([\w\s,]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (const name of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      results.push(name);
    }
  }
  return results;
}

/** Parse @UseFilters(...) from source */
function parseUseFilters(source: string): string[] {
  const results: string[] = [];
  const re = /@UseFilters\s*\(\s*([\w\s,]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (const name of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      results.push(name);
    }
  }
  return results;
}

type ChainItem = NestGuardChainEntry["chain"][number];

export async function nestGuardChain(
  repo: string,
  options?: { path?: string; max_routes?: number },
): Promise<NestGuardChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxRoutes = options?.max_routes ?? 300;
  const routes: NestGuardChainEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // 1. Collect global guards/interceptors/pipes from module files
  const globalChain: ChainItem[] = [];
  for (const file of index.files) {
    if (!file.path.endsWith(".module.ts") && !file.path.endsWith(".module.js")) continue;
    let source: string;
    try { source = await readFile(join(index.root, file.path), "utf-8"); } catch { continue; }
    const conv = extractNestConventions(source, file.path);
    for (const g of conv.global_guards) globalChain.push({ layer: "global", type: "guard", name: g.name, file: g.file });
    for (const f of conv.global_filters) globalChain.push({ layer: "global", type: "filter", name: f.name, file: f.file });
    for (const p of conv.global_pipes) globalChain.push({ layer: "global", type: "pipe", name: p.name, file: p.file });
    for (const i of conv.global_interceptors) globalChain.push({ layer: "global", type: "interceptor", name: i.name, file: i.file });
  }

  // 2. Scan controller files
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );
  const methods = ["Get", "Post", "Put", "Delete", "Patch"];

  for (const file of controllerFiles) {
    if (routes.length >= maxRoutes) { truncated = true; break; }
    let source: string;
    try { source = await readFile(join(index.root, file.path), "utf-8"); } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Controller-level info
    const ctrlMatch = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source);
    const ctrlPrefix = ctrlMatch?.[1] ?? "";
    const ctrlClassMatch = /class\s+(\w+)/.exec(source);
    const ctrlClass = ctrlClassMatch?.[1] ?? "UnknownController";

    // Controller-level decorators (before class body — find source before first method)
    const classIdx = source.indexOf(`class ${ctrlClass}`);
    const ctrlHeader = classIdx >= 0 ? source.slice(0, classIdx) : "";
    const ctrlGuards: ChainItem[] = parseUseGuards(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "guard" as const, name: n }));
    const ctrlInterceptors: ChainItem[] = parseUseInterceptors(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "interceptor" as const, name: n }));
    const ctrlPipes: ChainItem[] = parseUsePipes(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "pipe" as const, name: n }));
    const ctrlFilters: ChainItem[] = parseUseFilters(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "filter" as const, name: n }));
    const ctrlLevelChain = [...ctrlGuards, ...ctrlInterceptors, ...ctrlPipes, ...ctrlFilters];

    // Collect ALL method decorator positions first to bound lookback correctly
    const allMethodPositions: Array<{ method: string; path: string; pos: number }> = [];
    for (const method of methods) {
      const reStr = new RegExp(`@${method}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)`, "g");
      const reEmpty = new RegExp(`@${method}\\s*\\(\\s*\\)`, "g");
      let m: RegExpExecArray | null;
      while ((m = reStr.exec(source)) !== null) allMethodPositions.push({ method, path: m[1] ?? "", pos: m.index });
      while ((m = reEmpty.exec(source)) !== null) allMethodPositions.push({ method, path: "", pos: m.index });
    }
    allMethodPositions.sort((a, b) => a.pos - b.pos);

    for (let idx = 0; idx < allMethodPositions.length; idx++) {
      if (routes.length >= maxRoutes) { truncated = true; break; }
      const mm = allMethodPositions[idx]!;
      const fullPath = `/${ctrlPrefix}/${mm.path}`.replace(/\/+/g, "/") || "/";

      if (options?.path && fullPath !== options.path) continue;

      // Lookback window: from previous method decorator (or class start) to current
      const prevEnd = idx > 0 ? allMethodPositions[idx - 1]!.pos + 10 : (classIdx >= 0 ? classIdx : 0);
      const methodCtx = source.slice(Math.max(prevEnd, 0), mm.pos);
      const methodGuards: ChainItem[] = parseUseGuards(methodCtx).map((n) => ({ layer: "method" as const, type: "guard" as const, name: n }));
      const methodInterceptors: ChainItem[] = parseUseInterceptors(methodCtx).map((n) => ({ layer: "method" as const, type: "interceptor" as const, name: n }));
      const methodPipes: ChainItem[] = parseUsePipes(methodCtx).map((n) => ({ layer: "method" as const, type: "pipe" as const, name: n }));
      const methodFilters: ChainItem[] = parseUseFilters(methodCtx).map((n) => ({ layer: "method" as const, type: "filter" as const, name: n }));

      routes.push({
        route: fullPath,
        method: mm.method.toUpperCase(),
        controller: ctrlClass,
        file: file.path,
        chain: [...globalChain, ...ctrlLevelChain, ...methodGuards, ...methodInterceptors, ...methodPipes, ...methodFilters],
      });
    }
  }

  return {
    routes,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// B4: nest_route_inventory — types (implementation in Task 9)
// ---------------------------------------------------------------------------

export interface NestRouteEntry {
  method: string;
  path: string;
  handler: string;
  controller: string;
  file: string;
  guards: string[];
  params: Array<{ decorator: string; name: string; type?: string }>;
}

export interface NestRouteInventoryResult {
  routes: NestRouteEntry[];
  stats: {
    total_routes: number;
    protected: number;
    unprotected: number;
  };
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestRouteInventory(
  repo: string,
  options?: { max_routes?: number },
): Promise<NestRouteInventoryResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxRoutes = options?.max_routes ?? 500;
  const errors: NestToolError[] = [];
  let truncated = false;

  // Use findNestJSHandlers with wildcard path to get ALL routes
  // We pass "/**" as a wildcard — but findNestJSHandlers uses matchPath which
  // doesn't support wildcards. Instead, we scan controllers ourselves.
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );

  const routes: NestRouteEntry[] = [];
  const methods = ["Get", "Post", "Put", "Delete", "Patch"];

  for (const file of controllerFiles) {
    if (routes.length >= maxRoutes) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const ctrlMatchStr = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source);
    const ctrlMatchEmpty = !ctrlMatchStr ? /@Controller\s*\(\s*\)/.exec(source) : null;
    const ctrlPrefix = ctrlMatchStr?.[1] ?? (ctrlMatchEmpty ? "" : "");
    const ctrlClassMatch = /class\s+(\w+)/.exec(source);
    const ctrlClass = ctrlClassMatch?.[1] ?? "UnknownController";

    // Guards at controller level
    const classIdx = source.indexOf(`class ${ctrlClass}`);
    const ctrlHeader = classIdx >= 0 ? source.slice(0, classIdx) : "";
    const ctrlGuards = parseUseGuards(ctrlHeader);

    for (const method of methods) {
      // String-literal paths
      const reStr = new RegExp(`@${method}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)\\s*\\n\\s*(?:async\\s+)?(\\w+)`, "g");
      let m: RegExpExecArray | null;
      while ((m = reStr.exec(source)) !== null) {
        if (routes.length >= maxRoutes) { truncated = true; break; }
        const routePath = m[1] ?? "";
        const handler = m[2] ?? "";
        const fullPath = `/${ctrlPrefix}/${routePath}`.replace(/\/+/g, "/");

        // Method-level guards
        const methodCtx = source.slice(Math.max(0, m.index - 200), m.index);
        const methodGuards = parseUseGuards(methodCtx);
        const allGuards = [...ctrlGuards, ...methodGuards];

        // Parse @Param/@Body/@Query decorators from method context + next ~200 chars
        const paramCtx = source.slice(m.index, Math.min(source.length, m.index + 300));
        const params = parseParamDecorators(paramCtx);

        routes.push({
          method: method.toUpperCase(),
          path: fullPath,
          handler,
          controller: ctrlClass,
          file: file.path,
          guards: allGuards,
          params,
        });
      }

      // Empty decorator paths
      const reEmpty = new RegExp(`@${method}\\s*\\(\\s*\\)\\s*\\n\\s*(?:async\\s+)?(\\w+)`, "g");
      while ((m = reEmpty.exec(source)) !== null) {
        if (routes.length >= maxRoutes) { truncated = true; break; }
        const handler = m[1] ?? "";
        const fullPath = `/${ctrlPrefix}`.replace(/\/+/g, "/") || "/";
        if (routes.some((r) => r.file === file.path && r.handler === handler)) continue;

        const methodCtx = source.slice(Math.max(0, m.index - 200), m.index);
        const methodGuards = parseUseGuards(methodCtx);
        const paramCtx = source.slice(m.index, Math.min(source.length, m.index + 300));

        routes.push({
          method: method.toUpperCase(),
          path: fullPath,
          handler,
          controller: ctrlClass,
          file: file.path,
          guards: [...ctrlGuards, ...methodGuards],
          params: parseParamDecorators(paramCtx),
        });
      }
    }
  }

  const protectedCount = routes.filter((r) => r.guards.length > 0).length;
  return {
    routes,
    stats: {
      total_routes: routes.length,
      protected: protectedCount,
      unprotected: routes.length - protectedCount,
    },
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/** Parse @Param/@Body/@Query decorators from source context */
function parseParamDecorators(source: string): NestRouteEntry["params"] {
  const params: NestRouteEntry["params"] = [];
  const re = /@(Param|Body|Query|Headers)\s*\(\s*(?:['"`](\w+)['"`])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    params.push({ decorator: m[1]!, name: m[2] ?? "" });
  }
  return params;
}

// ---------------------------------------------------------------------------
// C: nest_audit — types (implementation in Task 10)
// ---------------------------------------------------------------------------

export interface NestAuditResult {
  framework_detected: boolean;
  lifecycle_map?: NestLifecycleMapResult;
  module_graph?: NestModuleGraphResult;
  di_graph?: NestDIGraphResult;
  guard_chain?: NestGuardChainResult;
  route_inventory?: NestRouteInventoryResult;
  anti_patterns?: Array<{ pattern: string; count: number }>;
  summary: {
    total_routes: number;
    cycles: number;
    violations: number;
    anti_pattern_hits: number;
    failed_checks: number;
    truncated_checks: string[];
  };
  warnings?: NestToolError[];
  errors?: Array<{ check: string; reason: string }>;
}

const ALL_NEST_CHECKS = ["modules", "routes", "di", "guards", "lifecycle", "patterns"] as const;
type NestCheck = (typeof ALL_NEST_CHECKS)[number];

export async function nestAudit(
  repo: string,
  options?: { checks?: string[] },
): Promise<NestAuditResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  // Check if this is a NestJS repo
  const { detectFrameworks } = await import("../utils/framework-detect.js");
  const frameworks = detectFrameworks(index);
  if (!frameworks.has("nestjs")) {
    return {
      framework_detected: false,
      summary: { total_routes: 0, cycles: 0, violations: 0, anti_pattern_hits: 0, failed_checks: 0, truncated_checks: [] },
    };
  }

  const enabledChecks = new Set<NestCheck>(
    (options?.checks ?? [...ALL_NEST_CHECKS]) as NestCheck[],
  );

  // Run all enabled checks in parallel via Promise.allSettled
  type CheckResult = {
    name: NestCheck;
    result?: unknown;
    error?: string;
  };

  const tasks: Array<Promise<CheckResult>> = [];

  if (enabledChecks.has("lifecycle")) {
    tasks.push(
      nestLifecycleMap(repo).then((r) => ({ name: "lifecycle" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "lifecycle" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("modules")) {
    tasks.push(
      nestModuleGraph(repo).then((r) => ({ name: "modules" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "modules" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("di")) {
    tasks.push(
      nestDIGraph(repo).then((r) => ({ name: "di" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "di" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("guards")) {
    tasks.push(
      nestGuardChain(repo).then((r) => ({ name: "guards" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "guards" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("routes")) {
    tasks.push(
      nestRouteInventory(repo).then((r) => ({ name: "routes" as NestCheck, result: r }))
        .catch((e: unknown) => ({ name: "routes" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }
  if (enabledChecks.has("patterns")) {
    tasks.push(
      (async () => {
        const { searchPatterns, listPatterns } = await import("./pattern-tools.js");
        const nestPatterns = listPatterns().filter((p) => p.name.startsWith("nest-"));
        const results: Array<{ pattern: string; count: number }> = [];
        for (const p of nestPatterns) {
          const r = await searchPatterns(repo, p.name);
          if (r.matches.length > 0) results.push({ pattern: p.name, count: r.matches.length });
        }
        return { name: "patterns" as NestCheck, result: results };
      })().catch((e: unknown) => ({ name: "patterns" as NestCheck, error: e instanceof Error ? e.message : String(e) })),
    );
  }

  const settled = await Promise.all(tasks);

  // Aggregate
  const auditErrors: Array<{ check: string; reason: string }> = [];
  const warnings: NestToolError[] = [];
  const truncatedChecks: string[] = [];

  let lifecycleResult: NestLifecycleMapResult | undefined;
  let moduleResult: NestModuleGraphResult | undefined;
  let diResult: NestDIGraphResult | undefined;
  let guardResult: NestGuardChainResult | undefined;
  let routeResult: NestRouteInventoryResult | undefined;
  let patternResults: Array<{ pattern: string; count: number }> | undefined;

  for (const item of settled) {
    if (item.error) {
      auditErrors.push({ check: item.name, reason: item.error });
      continue;
    }
    switch (item.name) {
      case "lifecycle": lifecycleResult = item.result as NestLifecycleMapResult; break;
      case "modules": {
        const r = item.result as NestModuleGraphResult;
        moduleResult = r;
        if (r.truncated) truncatedChecks.push("modules");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "di": {
        const r = item.result as NestDIGraphResult;
        diResult = r;
        if (r.truncated) truncatedChecks.push("di");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "guards": {
        const r = item.result as NestGuardChainResult;
        guardResult = r;
        if (r.truncated) truncatedChecks.push("guards");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "routes": {
        const r = item.result as NestRouteInventoryResult;
        routeResult = r;
        if (r.truncated) truncatedChecks.push("routes");
        if (r.errors) warnings.push(...r.errors);
        break;
      }
      case "patterns": patternResults = item.result as Array<{ pattern: string; count: number }>; break;
    }
  }

  const totalRoutes = routeResult?.stats.total_routes ?? 0;
  const cycles = (moduleResult?.circular_deps.length ?? 0) + (diResult?.cycles.length ?? 0);
  const antiPatternHits = patternResults?.reduce((sum, p) => sum + p.count, 0) ?? 0;

  return {
    framework_detected: true,
    ...(lifecycleResult ? { lifecycle_map: lifecycleResult } : {}),
    ...(moduleResult ? { module_graph: moduleResult } : {}),
    ...(diResult ? { di_graph: diResult } : {}),
    ...(guardResult ? { guard_chain: guardResult } : {}),
    ...(routeResult ? { route_inventory: routeResult } : {}),
    ...(patternResults ? { anti_patterns: patternResults } : {}),
    summary: {
      total_routes: totalRoutes,
      cycles,
      violations: 0, // TODO: boundary violations from module_graph
      anti_pattern_hits: antiPatternHits,
      failed_checks: auditErrors.length,
      truncated_checks: truncatedChecks,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(auditErrors.length > 0 ? { errors: auditErrors } : {}),
  };
}
