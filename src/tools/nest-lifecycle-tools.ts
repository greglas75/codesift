/**
 * NestJS lifecycle hook mapping.
 */

import { findRepoSymbols, getIndexSummary, streamRepoSymbols } from "./index-tools.js";
import type { NestToolError } from "./nest-shared-tools.js";
import type { CodeSymbol } from "../types.js";

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
  // The summary settles existence, staleness and storage faults exactly as the full load did; the
  // reads below then skip the freshness check it already ran.
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const hooks: NestLifecycleEntry[] = [];
  const errors: NestToolError[] = [];

  // Pass 1 — which symbols are lifecycle hooks, in index order, WITHOUT source. A name/kind test
  // needs no body, and source is ~45% of an index; this used to hold every symbol of the repository
  // resident to find a handful of methods.
  const isHook = (sym: CodeSymbol): boolean =>
    LIFECYCLE_HOOKS.has(sym.name) && (sym.kind === "method" || sym.kind === "function");
  const hookOrder: CodeSymbol[] = [];
  await streamRepoSymbols(repo, { withSource: false }, (batch) => {
    for (const sym of batch) if (isHook(sym)) hookOrder.push(sym);
    return undefined;
  }, { skipFreshness: true });

  // Pass 2 — the files that hold a hook, WITH source, one indexed `WHERE file = ?` each. That one
  // read serves both remaining needs: the hook's own body (the async test below) and the file's
  // classes (the enclosing-class fallback). Both keep index order within the file, so a file's
  // hooks here are the same subsequence pass 1 saw, and `find` meets candidates in the same order.
  // Paired by id, not by position: the two passes are separate reads, so an `index_file` landing
  // between them could shift a file's hooks and pair a hook with its neighbour's body. A queue per
  // id keeps colliding ids (`file:name:line` is not unique) paired in order.
  const sourcedHooksById = new Map<string, CodeSymbol[]>();
  const classesByFile = new Map<string, CodeSymbol[]>();
  for (const file of new Set(hookOrder.map((sym) => sym.file))) {
    const fileSymbols = await findRepoSymbols(repo, { withSource: true, file }, { skipFreshness: true });
    for (const sym of fileSymbols) {
      if (!isHook(sym)) continue;
      const queue = sourcedHooksById.get(sym.id) ?? [];
      queue.push(sym);
      sourcedHooksById.set(sym.id, queue);
    }
    classesByFile.set(file, fileSymbols.filter((s) => s.kind === "class"));
  }

  for (const hookSym of hookOrder) {
    // A hook pass 2 no longer sees (its file changed in between) is read on its own, with source,
    // rather than reported with an empty body — which would read as "not async".
    const sym = sourcedHooksById.get(hookSym.id)?.shift()
      ?? (await findRepoSymbols(repo, { withSource: true, ids: [hookSym.id], limit: 1 }, { skipFreshness: true }))[0]
      ?? hookSym;

    // Determine parent class name from source or file context
    let className = "Unknown";
    const source = sym.source ?? "";

    // Try to find the enclosing class via parent_id (if available)
    const symAny = sym as unknown as { parent_id?: string };
    if (symAny.parent_id) {
      const [parentSym] = await findRepoSymbols(
        repo, { withSource: false, ids: [symAny.parent_id], limit: 1 }, { skipFreshness: true },
      );
      if (parentSym) className = parentSym.name;
    }

    // Fallback: look for class name in source
    if (className === "Unknown") {
      // Check if there's a class symbol in the same file that contains this method
      const classSym = (classesByFile.get(sym.file) ?? []).find(
        (s) => s.start_line <= sym.start_line && s.end_line >= sym.end_line,
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
