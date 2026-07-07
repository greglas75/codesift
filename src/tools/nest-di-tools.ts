/**
 * NestJS dependency-injection graph analysis.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { detectCycles, type NestToolError } from "./nest-shared-tools.js";

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
  // R-6 fix: separate depth counters for () and <> to avoid cross-corruption
  const params: string[] = [];
  let parenDepth = 0;
  let angleDepth = 0;
  let current = "";
  for (const ch of ctorBody) {
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth--;
    if (ch === "," && parenDepth === 0 && angleDepth === 0) {
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
    // G3: Detect container generics like Repository<User>, Model<Comment>, Repo<X>.
    // For container types, unwrap and return the inner type parameter so consumers
    // can distinguish Repository<Article> from Repository<Comment>.
    const genericMatch = typeStr.match(/^(\w+)<\s*(\w+)\s*(?:,[^>]*)?>/);
    if (genericMatch) {
      const outer = genericMatch[1]!;
      const inner = genericMatch[2]!;
      if (/^(Repository|Repo|Model|Collection|Array|Set|Map|List|Observable|Promise|Ref|Token|Provider|Class)$/.test(outer)) {
        types.push(inner);
        continue;
      }
    }
    // Non-container type — return the outer name as before
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
    cross_module_warnings: [],
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}
