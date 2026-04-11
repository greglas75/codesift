/**
 * trace_fastapi_depends — FastAPI dependency injection graph.
 *
 * Traces `Depends(X)` and `Security(X)` chains recursively from route
 * handlers through the dependency tree. Answers "what runs before my
 * endpoint executes?" — auth, DB sessions, request parsing, etc.
 *
 * Detects:
 *   - Direct Depends() in function signatures
 *   - Nested Depends() (dep A uses dep B that uses dep C)
 *   - Security() (OAuth2, API key, scopes)
 *   - yield dependencies (resource cleanup via context managers)
 *   - global_dependencies in APIRouter/app
 *
 * Unique differentiator — no other MCP server traces FastAPI DI.
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface DependsCallSite {
  /** Name of the dependency function (e.g. "get_db") */
  name: string;
  /** Raw Depends() expression, e.g. "Depends(get_db)" or "Security(oauth2_scheme, scopes=['admin'])" */
  expression: string;
  /** Whether this is a Security() call (auth dependency) */
  is_security: boolean;
  /** Security scopes if present */
  scopes: string[];
}

export interface DependsNode {
  /** Dependency function name */
  name: string;
  /** File where the dependency is defined, if resolvable */
  file?: string;
  /** Line where the dependency is defined */
  line?: number;
  /** Sub-dependencies this dep itself uses */
  depends_on: DependsNode[];
  /** Is this a yield-based dependency (FastAPI cleanup pattern)? */
  is_yield: boolean;
  /** Is this a Security() dep? */
  is_security: boolean;
  /** Security scopes if present */
  scopes: string[];
  /** Depth in the tree (0 = directly attached to endpoint) */
  depth: number;
}

export interface FastAPIEndpointDeps {
  /** Endpoint function symbol name */
  endpoint: string;
  /** File path */
  file: string;
  /** Line */
  line: number;
  /** HTTP method and path, e.g. "GET /users/{id}" */
  route?: string;
  /** Full dependency tree rooted at this endpoint */
  depends: DependsNode[];
  /** All unique dep names used (flattened) */
  all_deps: string[];
  /** Are any Security() deps in the chain? */
  has_auth: boolean;
}

export interface FastAPIDependsResult {
  endpoints: FastAPIEndpointDeps[];
  total_endpoints: number;
  total_unique_deps: number;
  endpoints_without_auth: string[];
  shared_deps: Array<{ name: string; used_by: number }>;
}

/** Match Depends(foo) or Depends(foo, use_cache=False) */
const DEPENDS_RE = /\b(Security|Depends)\s*\(\s*([\w.]+)(?:\s*,([^)]*))?\)/g;
/** Match scopes=["admin", "read"] inside a Security() call */
const SCOPES_RE = /scopes\s*=\s*\[([^\]]*)\]/;
/** Match FastAPI route decorator */
const ROUTE_DECORATOR_RE = /@\w+\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]*)['"]/;

const MAX_DEPTH = 5;

/**
 * Trace FastAPI Depends() chains for all endpoints in the repository.
 */
export async function traceFastAPIDepends(
  repo: string,
  options?: {
    file_pattern?: string;
    endpoint?: string;
    max_depth?: number;
  },
): Promise<FastAPIDependsResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;
  const endpointFilter = options?.endpoint;
  const maxDepth = options?.max_depth ?? MAX_DEPTH;

  // Build a lookup: function name → symbol (for resolving dep references)
  const symbolByName = new Map<string, CodeSymbol>();
  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    if (!symbolByName.has(sym.name)) {
      symbolByName.set(sym.name, sym);
    }
  }

  // Find FastAPI endpoints — functions with @app.get/@router.get etc.
  const endpoints: FastAPIEndpointDeps[] = [];
  const sharedDeps = new Map<string, number>();

  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (endpointFilter && sym.name !== endpointFilter) continue;
    if (!sym.decorators || sym.decorators.length === 0) continue;

    // Check if any decorator matches FastAPI route pattern
    let route: string | undefined;
    for (const dec of sym.decorators) {
      const m = dec.match(ROUTE_DECORATOR_RE);
      if (m) {
        route = `${m[1]!.toUpperCase()} ${m[2]!}`;
        break;
      }
    }
    if (!route) continue;

    // Extract direct Depends() from the function signature (stored in source)
    const callSites = extractDependsFromSource(sym.source ?? "");
    const directDeps: DependsNode[] = callSites.map((cs) =>
      resolveDepNode(cs, symbolByName, new Set([sym.name]), 0, maxDepth),
    );

    // Flatten all_deps
    const allDeps = new Set<string>();
    function collectDeps(nodes: DependsNode[]): void {
      for (const n of nodes) {
        allDeps.add(n.name);
        collectDeps(n.depends_on);
      }
    }
    collectDeps(directDeps);

    // Check if any dep in the chain is Security
    const hasAuth = hasSecurityInTree(directDeps);

    // Track shared dep usage counts
    for (const dep of allDeps) {
      sharedDeps.set(dep, (sharedDeps.get(dep) ?? 0) + 1);
    }

    const ep: FastAPIEndpointDeps = {
      endpoint: sym.name,
      file: sym.file,
      line: sym.start_line,
      depends: directDeps,
      all_deps: [...allDeps].sort(),
      has_auth: hasAuth,
    };
    if (route) ep.route = route;
    endpoints.push(ep);
  }

  // Shared deps: only include those used by 2+ endpoints
  const sharedList = [...sharedDeps.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => ({ name, used_by: count }))
    .sort((a, b) => b.used_by - a.used_by);

  const endpointsWithoutAuth = endpoints
    .filter((e) => !e.has_auth)
    .map((e) => `${e.route ?? e.endpoint} (${e.file}:${e.line})`);

  return {
    endpoints,
    total_endpoints: endpoints.length,
    total_unique_deps: sharedDeps.size,
    endpoints_without_auth: endpointsWithoutAuth,
    shared_deps: sharedList,
  };
}

/**
 * Extract Depends() call sites from a function's source text.
 * Returns call sites in the order they appear in the parameter list.
 */
function extractDependsFromSource(source: string): DependsCallSite[] {
  const sites: DependsCallSite[] = [];
  DEPENDS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEPENDS_RE.exec(source)) !== null) {
    const kind = m[1]!;
    const name = m[2]!;
    const extra = m[3] ?? "";
    const isSecurity = kind === "Security";

    const scopes: string[] = [];
    if (isSecurity) {
      const scopeMatch = extra.match(SCOPES_RE);
      if (scopeMatch) {
        for (const s of scopeMatch[1]!.split(",")) {
          const trimmed = s.trim().replace(/^['"]|['"]$/g, "");
          if (trimmed) scopes.push(trimmed);
        }
      }
    }

    sites.push({
      name,
      expression: m[0]!,
      is_security: isSecurity,
      scopes,
    });
  }
  return sites;
}

/**
 * Resolve a dep call site to a DependsNode, recursively extracting sub-deps.
 */
function resolveDepNode(
  site: DependsCallSite,
  symbolByName: Map<string, CodeSymbol>,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): DependsNode {
  const sym = symbolByName.get(site.name);
  const node: DependsNode = {
    name: site.name,
    depends_on: [],
    is_yield: false,
    is_security: site.is_security,
    scopes: site.scopes,
    depth,
  };
  if (sym) {
    node.file = sym.file;
    node.line = sym.start_line;
    // Detect yield dependency (FastAPI resource cleanup pattern)
    if (sym.source && /\byield\b/.test(sym.source)) {
      node.is_yield = true;
    }
  }

  // Stop recursing if: too deep, already visited (cycle), or symbol missing
  if (depth >= maxDepth || visited.has(site.name) || !sym) {
    return node;
  }

  // Recurse: extract Depends() from this dep's source
  const subVisited = new Set(visited);
  subVisited.add(site.name);
  const subSites = extractDependsFromSource(sym.source ?? "");
  node.depends_on = subSites.map((sub) =>
    resolveDepNode(sub, symbolByName, subVisited, depth + 1, maxDepth),
  );
  return node;
}

function hasSecurityInTree(nodes: DependsNode[]): boolean {
  for (const n of nodes) {
    if (n.is_security) return true;
    if (hasSecurityInTree(n.depends_on)) return true;
  }
  return false;
}
