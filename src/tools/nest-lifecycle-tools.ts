/**
 * NestJS lifecycle hook mapping.
 */

import { getCodeIndex } from "./index-tools.js";
import type { NestToolError } from "./nest-shared-tools.js";

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
