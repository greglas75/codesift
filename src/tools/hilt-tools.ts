/**
 * Hilt DI graph tools.
 *
 * Build a dependency graph from indexed Kotlin symbols by scanning for Hilt
 * annotations (@HiltViewModel, @AndroidEntryPoint, @Module, @Provides, @Binds)
 * and matching each @Inject constructor parameter type against a provider
 * method that returns that type.
 *
 * Index-only (no filesystem rescan) — operates on whatever the Kotlin
 * extractor already surfaced. Requires the extractor to populate
 * `decorators` on class/method symbols (added in Wave 2 Task 3).
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HiltEntryKind =
  | "HiltViewModel"
  | "HiltAndroidApp"
  | "AndroidEntryPoint";

export interface HiltEntryPoint {
  name: string;
  file: string;
  start_line: number;
  kind: HiltEntryKind;
  dependencies: string[];
}

export type HiltProviderKind = "provides" | "binds";

export interface HiltProvider {
  name: string;
  file: string;
  start_line: number;
  kind: HiltProviderKind;
  provides: string;
}

export interface HiltModule {
  name: string;
  file: string;
  start_line: number;
  providers: HiltProvider[];
}

export interface HiltEdge {
  from: string;
  to: string;
  provided_by?: string;
  module?: string;
}

export interface HiltGraphResult {
  view_models: HiltEntryPoint[];
  entry_points: HiltEntryPoint[];
  modules: HiltModule[];
  edges: HiltEdge[];
}

// ---------------------------------------------------------------------------
// Annotation helpers
// ---------------------------------------------------------------------------

const ENTRY_ANNOTATIONS: Record<string, HiltEntryKind> = {
  HiltViewModel: "HiltViewModel",
  HiltAndroidApp: "HiltAndroidApp",
  AndroidEntryPoint: "AndroidEntryPoint",
};

function hasAnnotation(sym: CodeSymbol, name: string): boolean {
  if (sym.decorators && sym.decorators.includes(name)) return true;
  // Fallback: scan source header for @Annotation (word-bounded so
  // @HiltViewModelExtra does not match @HiltViewModel).
  const head = sym.source?.slice(0, 400);
  if (!head) return false;
  return new RegExp(`@${name}\\b`).test(head);
}

function firstMatchingAnnotation(
  sym: CodeSymbol,
  annotations: Record<string, HiltEntryKind>,
): HiltEntryKind | null {
  for (const [name, kind] of Object.entries(annotations)) {
    if (hasAnnotation(sym, name)) return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency parsing
// ---------------------------------------------------------------------------

/**
 * Parse constructor parameter types from the source of a Hilt entry-point
 * class. Matches `@Inject constructor(...)` and extracts the type of each
 * parameter.
 *
 * Handles:
 *   - val/var prefix, private modifier
 *   - nullable types (String?)
 *   - generic types (List<User>, Map<K, V>)
 *   - assisted inject parameters (for now just returns all param types)
 */
function parseInjectedDependencies(sym: CodeSymbol): string[] {
  const src = sym.source;
  if (!src) return [];

  // Match `@Inject constructor(PARAMS)` — params can span multiple lines.
  const match = /@Inject\s+constructor\s*\(([\s\S]*?)\)/.exec(src);
  if (!match) return [];

  const paramList = match[1]!.trim();
  if (!paramList) return [];

  // Split on top-level commas only (don't split inside generic brackets).
  const params = splitTopLevelCommas(paramList);

  const types: string[] = [];
  for (const raw of params) {
    const param = raw.trim();
    if (!param) continue;
    // Strip modifiers: private, val, var, @Assisted, @Named("x"), etc.
    const withoutModifiers = param
      .replace(/@\w+(?:\([^)]*\))?\s+/g, "")
      .replace(/\b(?:private|public|internal|protected|val|var)\s+/g, "");

    // Expect `name: Type` — split on the first colon.
    const colonIdx = withoutModifiers.indexOf(":");
    if (colonIdx === -1) continue;
    const typeText = withoutModifiers.slice(colonIdx + 1).trim();
    // Strip trailing `?` for nullable, default value ` = ...`, and
    // optional trailing comma.
    const cleanType = typeText
      .replace(/\s*=\s*[\s\S]*$/, "") // drop default values
      .replace(/,$/, "")
      .trim();
    // Use the root type name (strip generic parameters for matching).
    const rootType = cleanType.replace(/<[\s\S]*$/, "").replace(/\?$/, "").trim();
    if (rootType) types.push(rootType);
  }

  return types;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// Provider parsing
// ---------------------------------------------------------------------------

/**
 * Extract the return type from a provider method signature.
 *
 *   "(): UserRepository"                     → "UserRepository"
 *   "(impl: UserRepositoryImpl): UserRepository" → "UserRepository"
 *   "(): List<User>"                         → "List"
 */
function parseProviderReturnType(sym: CodeSymbol): string | null {
  const sig = sym.signature;
  if (!sig) return null;
  // The return type sits after the last `):`.
  const idx = sig.lastIndexOf("):");
  if (idx === -1) return null;
  const rawReturn = sig.slice(idx + 2).trim();
  const rootType = rawReturn.replace(/<[\s\S]*$/, "").replace(/\?$/, "").trim();
  return rootType || null;
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

export async function buildHiltGraph(repo: string): Promise<HiltGraphResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const viewModels: HiltEntryPoint[] = [];
  const entryPoints: HiltEntryPoint[] = [];
  const modules: HiltModule[] = [];

  // First pass — classify classes as entry points or modules.
  // Track modules by id so we can attach providers in the second pass.
  const modulesById = new Map<string, HiltModule>();

  for (const sym of index.symbols) {
    if (sym.kind !== "class" && sym.kind !== "interface") continue;

    const entryKind = firstMatchingAnnotation(sym, ENTRY_ANNOTATIONS);
    if (entryKind) {
      const entry: HiltEntryPoint = {
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        kind: entryKind,
        dependencies: parseInjectedDependencies(sym),
      };
      if (entryKind === "HiltViewModel") {
        viewModels.push(entry);
      } else {
        entryPoints.push(entry);
      }
      continue;
    }

    if (hasAnnotation(sym, "Module")) {
      const mod: HiltModule = {
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        providers: [],
      };
      modules.push(mod);
      modulesById.set(sym.id, mod);
    }
  }

  // Second pass — attach provider methods to their parent modules.
  for (const sym of index.symbols) {
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    if (!sym.parent) continue;
    const module = modulesById.get(sym.parent);
    if (!module) continue;

    let providerKind: HiltProviderKind | null = null;
    if (hasAnnotation(sym, "Provides")) providerKind = "provides";
    else if (hasAnnotation(sym, "Binds")) providerKind = "binds";
    if (!providerKind) continue;

    const returnType = parseProviderReturnType(sym);
    if (!returnType) continue;

    module.providers.push({
      name: sym.name,
      file: sym.file,
      start_line: sym.start_line,
      kind: providerKind,
      provides: returnType,
    });
  }

  // Build edge table — map provider type → {method, module}.
  const providerIndex = new Map<string, { provider: HiltProvider; module: HiltModule }>();
  for (const module of modules) {
    for (const provider of module.providers) {
      if (!providerIndex.has(provider.provides)) {
        providerIndex.set(provider.provides, { provider, module });
      }
    }
  }

  const edges: HiltEdge[] = [];
  for (const entry of [...viewModels, ...entryPoints]) {
    for (const dep of entry.dependencies) {
      const provider = providerIndex.get(dep);
      const edge: HiltEdge = { from: entry.name, to: dep };
      if (provider) {
        edge.provided_by = provider.provider.name;
        edge.module = provider.module.name;
      }
      edges.push(edge);
    }
  }

  return { view_models: viewModels, entry_points: entryPoints, modules, edges };
}

// ---------------------------------------------------------------------------
// trace_hilt_graph tool — rooted dependency tree
// ---------------------------------------------------------------------------

export interface HiltDependencyNode {
  name: string;
  provided_by?: string;
  module?: string;
  unresolved?: boolean;
}

export interface HiltTraceResult {
  root: {
    name: string;
    kind: HiltEntryKind;
    file: string;
    start_line: number;
  };
  dependencies: HiltDependencyNode[];
  depth: number;
}

export async function traceHiltGraph(
  repo: string,
  className: string,
  options?: { depth?: number },
): Promise<HiltTraceResult> {
  const graph = await buildHiltGraph(repo);
  const depth = options?.depth ?? 1;

  const root =
    graph.view_models.find((v) => v.name === className) ??
    graph.entry_points.find((e) => e.name === className);

  if (!root) {
    throw new Error(
      `"${className}" is not a Hilt entry point (missing @HiltViewModel / @HiltAndroidApp / @AndroidEntryPoint annotation).`,
    );
  }

  const dependencies: HiltDependencyNode[] = root.dependencies.map((dep) => {
    const edge = graph.edges.find((e) => e.from === className && e.to === dep);
    const node: HiltDependencyNode = { name: dep };
    if (edge?.provided_by) node.provided_by = edge.provided_by;
    if (edge?.module) node.module = edge.module;
    if (!edge?.provided_by) node.unresolved = true;
    return node;
  });

  return {
    root: {
      name: root.name,
      kind: root.kind,
      file: root.file,
      start_line: root.start_line,
    },
    dependencies,
    depth,
  };
}
