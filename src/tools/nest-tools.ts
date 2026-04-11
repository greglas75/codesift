/**
 * NestJS analysis tools — B1-B5 + C (nest_audit meta-orchestrator).
 * Discoverable via discover_tools(query="nestjs").
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { extractNestConventions } from "./project-tools.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

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
    if ((sym as Record<string, unknown>).parent_id) {
      const parentSym = index.symbols.find((s) => s.id === (sym as Record<string, unknown>).parent_id);
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
      nodes.push({ name: inj.name, file: file.path, kind: "provider", scope: inj.scope });

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
