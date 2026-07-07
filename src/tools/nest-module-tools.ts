/**
 * NestJS module graph analysis.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { detectCycles, type NestToolError } from "./nest-shared-tools.js";
import { extractNestConventions } from "./project-tools.js";

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
