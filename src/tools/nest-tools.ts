/**
 * NestJS analysis tools — B1-B5 + C (nest_audit meta-orchestrator).
 * Discoverable via discover_tools(query="nestjs").
 */

import { getCodeIndex } from "./index-tools.js";
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
