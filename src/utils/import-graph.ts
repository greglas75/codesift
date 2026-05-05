/**
 * Import graph utilities — shared by context-tools, route-tools, community-tools.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import type { CodeIndex, Workspace } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { getCachedParse, setCachedParse } from "../parser/parse-cache.js";
import { extractPythonImports } from "./python-imports.js";
import { resolvePythonImport, detectSrcLayout } from "./python-import-resolver.js";
import { resolvePhpNamespace } from "../tools/php-tools.js";
import { extractTypeScriptImports } from "./ts-imports.js";
import { resolveTsAliasedImport } from "./tsconfig-paths.js";
import { DirectedGraph } from "graphology";
import { createRequire } from "node:module";
// graphology-metrics has no "exports" field; use createRequire so the deep
// path resolves at runtime under both ESM and CJS consumers.
const req = createRequire(import.meta.url);
const pagerank = req("graphology-metrics/centrality/pagerank") as (g: unknown) => Record<string, number>;

export interface ImportEdge {
  from: string; // importer file path
  to: string;   // imported file path
  type_only?: boolean;   // Python: `if TYPE_CHECKING:` import
  star_import?: boolean; // Python: `from X import *`
  raw?: string;          // original import source for debugging
}

// Patterns for detecting import statements across common languages
const IMPORT_PATTERNS = [
  // ES modules: import ... from '...' or import ... from "..."
  /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
  // Dynamic import: import('...')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS: require('...')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // PHP: require/include with relative path string: require __DIR__ . '/helpers.php';
  /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"](\.\.?\/[^'"]+\.php)['"]/g,
];

// Patterns for extracting PHP `use` statements (FQCN imports — PSR-4 based).
// These are NOT file paths; they need PSR-4 resolution via composer.json.
// Exposed separately so the resolver tool can opt-in.
//
// Accepts both UpperCase (PSR-1/2 modern) and lowercase (common in older
// Yii2 apps: `use app\models\Survey`) namespaces. The FQCN must contain at
// least one backslash to exclude global class imports like `use Closure;`
// and `use Yii;` which would be noise for the import graph.
//
// Two separate patterns:
//   SINGLE — `use App\Models\User;` or `use App\Models\User as U;`
//   GROUP  — `use App\Models\{User, Post, Comment};` or with aliases
const PHP_USE_SINGLE_PATTERN = /^\s*use\s+(\w+(?:\\\w+)+)(?:\s+as\s+\w+)?\s*;/gm;
const PHP_USE_GROUP_PATTERN = /^\s*use\s+(\w+(?:\\\w+)*)\\\{([^}]+)\}\s*;/gm;

// Patterns for extracting Kotlin `import` statements (fully-qualified names).
// These are NOT file paths; they need heuristic resolution against source roots.
// Matches: `import com.example.UserService`, `import com.example.*`, `import com.example.Foo as Bar`
const KOTLIN_IMPORT_PATTERN = /^\s*import\s+([\w.]+(?:\.\*)?)(?:\s+as\s+\w+)?\s*$/gm;

/**
 * Extract import paths from a source string.
 * Returns relative paths only (skips node_modules / bare specifiers).
 */
export function extractImports(source: string): string[] {
  const imports = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const importPath = match[1];
      if (importPath && importPath.startsWith(".")) {
        imports.add(importPath);
      }
    }
  }

  return [...imports];
}

/**
 * Extract bare-specifier imports (e.g. `@org/shared`, `@/utils`).
 * Only used by the workspace-alias / tsconfig-paths resolvers when
 * `index.workspaces` is present. Skips relative paths and skips imports
 * that look like absolute file URLs.
 *
 * Task 6 of monorepo workspace intelligence plan.
 */
export function extractBareImports(source: string): string[] {
  const imports = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const importPath = match[1];
      if (!importPath) continue;
      if (importPath.startsWith(".") || importPath.startsWith("/")) continue;
      // Strip dynamic-import wrappers — we already handled them via pattern groups
      imports.add(importPath);
    }
  }
  return [...imports];
}

/**
 * Normalize an import path relative to the importing file.
 * Resolves "./foo" and "../bar" relative to the importer's directory.
 */
export function resolveImportPath(importerFile: string, importPath: string): string {
  const importerDir = importerFile.includes("/")
    ? importerFile.slice(0, importerFile.lastIndexOf("/"))
    : ".";

  const parts = importerDir.split("/");

  for (const segment of importPath.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  let resolved = parts.join("/");
  resolved = resolved.replace(/\.(astro|ts|tsx|js|jsx|mjs|cjs|php)$/, "");

  return resolved;
}

/**
 * Extract PHP `use` statements (FQCN imports).
 * Returns fully-qualified class/namespace names without the leading backslash.
 * These are NOT file paths — they require PSR-4 resolution against composer.json.
 *
 * Handles both single-FQCN and grouped forms:
 *   `use App\Models\User;`
 *   `use App\Models\User as U;`
 *   `use App\Models\{User, Post, Comment};`
 *   `use App\{Models\User, Services\Auth as A};`
 */
export function extractPhpUseStatements(source: string): string[] {
  const uses = new Set<string>();

  // Single FQCN form
  PHP_USE_SINGLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHP_USE_SINGLE_PATTERN.exec(source)) !== null) {
    const fqcn = match[1]?.replace(/^\\/, "");
    if (fqcn) uses.add(fqcn);
  }

  // Grouped form — split the brace content on commas, strip aliases,
  // concatenate each fragment with the prefix.
  PHP_USE_GROUP_PATTERN.lastIndex = 0;
  while ((match = PHP_USE_GROUP_PATTERN.exec(source)) !== null) {
    const prefix = match[1]?.replace(/^\\/, "");
    const members = match[2];
    if (!prefix || !members) continue;
    for (const raw of members.split(",")) {
      // Strip `as Alias` and surrounding whitespace
      const bare = raw.replace(/\s+as\s+\w+\s*$/, "").trim();
      if (bare) uses.add(`${prefix}\\${bare}`);
    }
  }

  return [...uses];
}

/**
 * Extract Kotlin `import` statements (fully-qualified names).
 * Returns dot-separated package + class names. Wildcards (`com.example.*`) are
 * preserved as-is. These are NOT file paths — they require heuristic resolution
 * against the source root (usually `src/main/kotlin`, `src/commonMain/kotlin`, etc.).
 */
export function extractKotlinImports(source: string): string[] {
  const imports = new Set<string>();
  KOTLIN_IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KOTLIN_IMPORT_PATTERN.exec(source)) !== null) {
    const fqName = match[1];
    if (fqName) imports.add(fqName);
  }
  return [...imports];
}

/**
 * Heuristically resolve a Kotlin fully-qualified import to an indexed file.
 * Strategy: match the last segment of the FQN (the simple class name) against
 * file basenames. For `com.example.service.UserService`, tries to find a file
 * whose basename (without .kt/.kts) is `UserService` AND whose path contains
 * the package path `com/example/service`.
 *
 * Returns the matched file path or null if no match.
 *
 * Limitations: single-repo heuristic. Doesn't handle wildcard imports
 * (`com.example.*`) or multi-module setups with complex source roots.
 */
export function resolveKotlinImport(
  fqName: string,
  kotlinFilesByBasename: Map<string, string[]>,
): string | null {
  // Skip wildcard imports — can't resolve to a single file
  if (fqName.endsWith(".*")) return null;

  // Skip standard library / third-party (no way to index jar files)
  if (fqName.startsWith("kotlin.") || fqName.startsWith("java.") ||
      fqName.startsWith("javax.") || fqName.startsWith("android.") ||
      fqName.startsWith("androidx.") || fqName.startsWith("org.jetbrains.") ||
      fqName.startsWith("org.junit.")) {
    return null;
  }

  const parts = fqName.split(".");
  if (parts.length < 2) return null;

  const simpleName = parts[parts.length - 1]!;
  const packagePath = parts.slice(0, -1).join("/");

  const candidates = kotlinFilesByBasename.get(simpleName);
  if (!candidates) return null;

  // Prefer candidate whose path contains the package path
  for (const candidate of candidates) {
    if (candidate.includes(packagePath)) return candidate;
  }

  // Fallback: if only one candidate, return it (common in small projects)
  if (candidates.length === 1) return candidates[0] ?? null;

  return null;
}

/**
 * Build a lookup map from Kotlin file basenames (without extension) to file paths.
 * Used by resolveKotlinImport for heuristic FQN resolution.
 */
export function buildKotlinFilesByBasename(index: CodeIndex): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of index.files) {
    if (!/\.kts?$/.test(file.path)) continue;
    const basename = file.path
      .slice(file.path.lastIndexOf("/") + 1)
      .replace(/\.kts?$/, "");
    const existing = map.get(basename);
    if (existing) {
      existing.push(file.path);
    } else {
      map.set(basename, [file.path]);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Monorepo workspace-alias resolution (Task 6).
// Activated only when `index.workspaces` is non-null. Adds cross-package edges
// for bare imports like `@org/shared` (workspace-name match) and tsconfig
// `paths` aliases. All resolution data is precomputed at edge-collection time
// using workspace metadata that was already cached at index time (Task 4) —
// zero new IO at query time.
// ---------------------------------------------------------------------------

interface WorkspaceAliasResolver {
  resolve: (importPath: string, importerFile: string) => string | null;
}

const NULL_RESOLVER: WorkspaceAliasResolver = { resolve: () => null };

/** Build a workspace-alias resolver for the given index. Reads each
 *  workspace's package.json once at construction time to discover entry
 *  points; never reads disk afterwards. Returns a no-op resolver on flat
 *  repos. */
export function buildWorkspaceAliasResolver(index: CodeIndex): WorkspaceAliasResolver {
  const workspaces = index.workspaces;
  if (!workspaces || workspaces.length === 0) return NULL_RESOLVER;

  const fileSet = new Set(index.files.map((f) => f.path));
  const normalizedPaths = buildNormalizedPathMap(index);

  // Workspace name → relative root (relative to index.root)
  const wsRelByName = new Map<string, string>();
  // Workspace name → resolved entry file path (relative to index.root)
  const wsEntryByName = new Map<string, string | null>();
  // Sorted list of (relativeRoot, workspace) for longest-prefix file lookup
  const wsByPath: Array<{ rel: string; ws: Workspace }> = [];

  for (const ws of workspaces) {
    const rel = relRoot(ws.root, index.root);
    if (rel === null) continue;
    wsByPath.push({ rel, ws });
    if (ws.name) {
      wsRelByName.set(ws.name, rel);
      wsEntryByName.set(ws.name, resolveWorkspaceEntry(ws.root, rel, fileSet, normalizedPaths));
    }
  }
  // Longest prefix first
  wsByPath.sort((a, b) => b.rel.length - a.rel.length);

  function findOriginatingWorkspace(importerFile: string): Workspace | null {
    for (const { rel, ws } of wsByPath) {
      if (rel === "" || importerFile === rel || importerFile.startsWith(rel + "/")) {
        return ws;
      }
    }
    return null;
  }

  function lookupFile(candidate: string): string | null {
    if (fileSet.has(candidate)) return candidate;
    const stripped = candidate.replace(/\.(astro|ts|tsx|js|jsx|mjs|cjs)$/, "");
    const normalized = normalizedPaths.get(stripped);
    if (normalized) return normalized;
    // Try common entry-file suffixes
    for (const suffix of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) {
      const tryPath = candidate + suffix;
      if (fileSet.has(tryPath)) return tryPath;
    }
    return null;
  }

  function resolveByWorkspaceName(importPath: string): string | null {
    // Exact workspace-name match → entry file
    const directEntry = wsEntryByName.get(importPath);
    if (directEntry) return directEntry;

    // Subpath import: `@org/shared/Button` → workspace `@org/shared` + subpath `Button`
    for (const [wsName, wsRel] of wsRelByName) {
      if (!importPath.startsWith(wsName + "/")) continue;
      const subpath = importPath.slice(wsName.length + 1);
      // Try `<wsRel>/<subpath>`, then `<wsRel>/src/<subpath>`
      for (const candidate of [`${wsRel}/${subpath}`, `${wsRel}/src/${subpath}`]) {
        const found = lookupFile(candidate);
        if (found) return found;
      }
    }
    return null;
  }

  function resolveByTsconfigPaths(importPath: string, importerFile: string): string | null {
    const ws = findOriginatingWorkspace(importerFile);
    if (!ws) return null;
    for (const tsp of ws.tsconfig_paths) {
      const pattern = tsp.from_pattern;
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -1); // "@org/" from "@org/*"
        if (!importPath.startsWith(prefix)) continue;
        const captured = importPath.slice(prefix.length);
        for (const target of tsp.to_paths) {
          const expanded = target.replace("*", captured);
          // Try as repo-relative; also try relative to the originating workspace
          const wsRel = relRoot(ws.root, index.root) ?? "";
          const candidates = [expanded];
          if (wsRel) candidates.push(`${wsRel}/${expanded}`);
          for (const c of candidates) {
            const found = lookupFile(c);
            if (found) return found;
          }
        }
      } else if (pattern === importPath) {
        for (const target of tsp.to_paths) {
          const wsRel = relRoot(ws.root, index.root) ?? "";
          const candidates = [target, wsRel ? `${wsRel}/${target}` : target];
          for (const c of candidates) {
            const found = lookupFile(c);
            if (found) return found;
          }
        }
      }
    }
    return null;
  }

  return {
    resolve: (importPath, importerFile) => {
      // Workspace-name match takes precedence over tsconfig paths
      const byName = resolveByWorkspaceName(importPath);
      if (byName) return byName;
      return resolveByTsconfigPaths(importPath, importerFile);
    },
  };
}

function relRoot(absPath: string, indexRoot: string): string | null {
  if (!absPath.startsWith(indexRoot)) return null;
  const rel = absPath.slice(indexRoot.length).replace(/^[\\/]+/, "");
  return rel;
}

function resolveWorkspaceEntry(
  wsAbsRoot: string,
  wsRel: string,
  fileSet: Set<string>,
  normalizedPaths: Map<string, string>,
): string | null {
  const pkg = readWorkspacePackageJson(wsAbsRoot);
  const entryRel = pickEntry(pkg);
  const candidates: string[] = [];
  if (entryRel) {
    const cleaned = entryRel.replace(/^\.?\/+/, "");
    candidates.push(wsRel ? `${wsRel}/${cleaned}` : cleaned);
  }
  // Common defaults (in order)
  for (const def of ["src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.tsx", "index.js"]) {
    candidates.push(wsRel ? `${wsRel}/${def}` : def);
  }
  for (const c of candidates) {
    if (fileSet.has(c)) return c;
    const stripped = c.replace(/\.(astro|ts|tsx|js|jsx|mjs|cjs)$/, "");
    const normalized = normalizedPaths.get(stripped);
    if (normalized) return normalized;
  }
  return null;
}

interface ParsedPackageJson {
  main?: string;
  module?: string;
  exports?: unknown;
  source?: string;
  types?: string;
}

function readWorkspacePackageJson(absRoot: string): ParsedPackageJson | null {
  try {
    return JSON.parse(readFileSync(`${absRoot}/package.json`, "utf-8")) as ParsedPackageJson;
  } catch {
    return null;
  }
}

function pickEntry(pkg: ParsedPackageJson | null): string | null {
  if (!pkg) return null;
  // Prefer source > module > main; ignore complex exports
  if (typeof pkg.source === "string") return pkg.source;
  if (typeof pkg.module === "string") return pkg.module;
  if (typeof pkg.main === "string") return pkg.main;
  if (pkg.exports && typeof pkg.exports === "object") {
    const exp = pkg.exports as Record<string, unknown>;
    const root = exp["."];
    if (typeof root === "string") return root;
    if (root && typeof root === "object") {
      const r = root as Record<string, unknown>;
      for (const key of ["import", "default", "require"]) {
        const v = r[key];
        if (typeof v === "string") return v;
      }
    }
  }
  return null;
}

/**
 * Build normalized path map for matching imports to indexed files.
 */
export function buildNormalizedPathMap(index: CodeIndex): Map<string, string> {
  const normalizedPaths = new Map<string, string>();
  for (const file of index.files) {
    const normalized = file.path.replace(/\.(astro|ts|tsx|js|jsx|mjs|cjs|php|kt|kts|py)$/, "");
    normalizedPaths.set(normalized, file.path);
    if (normalized.endsWith("/index")) {
      normalizedPaths.set(normalized.slice(0, -6), file.path);
    }
    // Python package index: map `foo/__init__` → `foo`
    if (normalized.endsWith("/__init__")) {
      normalizedPaths.set(normalized.slice(0, -9), file.path);
    }
  }
  return normalizedPaths;
}

/**
 * Collect all import edges between files in the index.
 * Reads file source from disk to extract import statements.
 * Handles JS/TS/PHP relative imports AND Kotlin fully-qualified imports
 * (via heuristic basename + package-path matching).
 */
export async function collectImportEdges(
  index: CodeIndex,
  fileFilter?: Set<string>,
): Promise<ImportEdge[]> {
  const normalizedPaths = buildNormalizedPathMap(index);
  const kotlinFilesByBasename = buildKotlinFilesByBasename(index);
  // Workspace-alias resolver (Task 6) — no-op when index.workspaces is absent.
  const workspaceResolver = buildWorkspaceAliasResolver(index);
  const edgeSet = new Set<string>();
  const edges: ImportEdge[] = [];

  // Rollback kill switch — skip Python import extraction if env var set
  const pythonDisabled = process.env.CODESIFT_DISABLE_PYTHON_IMPORTS === "1";

  // Python needs the full indexed file set for package resolution — built once
  const indexedPyFileSet = new Set(
    index.files.filter((f) => f.path.endsWith(".py")).map((f) => f.path),
  );
  const pySrcLayout = indexedPyFileSet.size > 0
    ? detectSrcLayout([...indexedPyFileSet])
    : null;

  const files = fileFilter
    ? index.files.filter((f) => fileFilter.has(f.path))
    : index.files;

  const addEdge = (
    from: string,
    to: string,
    extras?: Pick<ImportEdge, "type_only" | "star_import" | "raw">,
  ): void => {
    if (to === from) return;
    const edgeKey = `${from}->${to}`;
    if (edgeSet.has(edgeKey)) {
      // Upgrade: runtime import overrides a prior type_only edge
      if (!extras?.type_only) {
        const existing = edges.find((e) => e.from === from && e.to === to);
        if (existing?.type_only) existing.type_only = false;
      }
      return;
    }
    edgeSet.add(edgeKey);
    const edge: ImportEdge = { from, to };
    if (extras?.type_only) edge.type_only = true;
    if (extras?.star_import) edge.star_import = true;
    if (extras?.raw) edge.raw = extras.raw;
    edges.push(edge);
  };

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }

    // TS/TSX AST-based extraction with type_only flagging + tsconfig alias
    // resolution. Skip the regex path for these files; fall back to regex
    // ONLY if AST extraction throws (parse failure).
    const isTsFile = /\.tsx?$/.test(file.path);
    let tsAstHandled = false;
    if (isTsFile) {
      try {
        const lang = file.path.endsWith(".tsx") ? "tsx" : "typescript";
        const parser = await getParser(lang);
        if (parser) {
          let tree = getCachedParse(lang, source);
          if (!tree) {
            tree = parser.parse(source);
            setCachedParse(lang, source, tree);
          }
          const tsImports = extractTypeScriptImports(tree);
          for (const imp of tsImports) {
            let resolved: string | null = null;
            if (imp.path.startsWith(".")) {
              let norm = resolveImportPath(file.path, imp.path);
              // resolveImportPath emits leading "./" when importer is at repo root.
              // Strip it so the lookup matches normalizedPaths keys (which never
              // have leading "./").
              if (norm.startsWith("./")) norm = norm.slice(2);
              if (normalizedPaths.has(norm)) resolved = normalizedPaths.get(norm) ?? null;
            } else {
              // Bare/aliased specifier: try tsconfig paths.
              const aliased = resolveTsAliasedImport(
                join(index.root, file.path),
                imp.path,
                index.root,
              );
              if (aliased) {
                // Only treat as in-repo when resolved path is under index.root
                // (relative() alone can escape with ".." for outside paths).
                const rootAbs = resolve(index.root);
                const aliasAbs = resolve(aliased);
                const relRaw = relative(rootAbs, aliasAbs);
                const inside =
                  relRaw !== "" &&
                  !isAbsolute(relRaw) &&
                  !relRaw.startsWith("..");
                if (inside) {
                  const rel = relRaw.split(sep).join("/");
                  if (normalizedPaths.has(rel.replace(/\.[^./]+$/, ""))
                      || index.files.some((f) => f.path === rel)) {
                    resolved = rel;
                  }
                }
              }
            }
            if (resolved) {
              addEdge(file.path, resolved, { type_only: imp.is_type_only });
            }
          }
          tsAstHandled = true;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[import-graph] TS AST extraction failed for ${file.path}; falling back to regex: ${message}`,
        );
        // Falls through to regex extractImports below.
      }
    }

    // Regex path: JS/JSX/PHP files always; TS/TSX only on AST-failure fallback.
    if (!tsAstHandled) {
      const importPaths = extractImports(source);
      for (const importPath of importPaths) {
        const resolved = resolveImportPath(file.path, importPath);
        const targetFile = normalizedPaths.get(resolved);
        // type_only stays undefined on regex fallback — find_circular_deps
        // treats undefined as runtime, which preserves cycle detection for
        // JS/JSX/PHP and accepts a small false-positive risk on TS-fallback files.
        if (targetFile) addEdge(file.path, targetFile);
      }
    }

    // Workspace-alias / tsconfig-paths imports (JS/TS only when monorepo).
    // Activated only when `index.workspaces` is non-null. Adds cross-package
    // edges so find_references / impact_analysis / trace_call_chain see
    // bare-name imports like `@org/shared`.
    if (workspaceResolver !== NULL_RESOLVER && /\.(astro|ts|tsx|js|jsx|mjs|cjs)$/.test(file.path)) {
      const bareImports = extractBareImports(source);
      for (const importPath of bareImports) {
        const targetFile = workspaceResolver.resolve(importPath, file.path);
        if (targetFile) addEdge(file.path, targetFile);
      }
    }

    // Kotlin fully-qualified imports (.kt/.kts files only)
    if (/\.kts?$/.test(file.path)) {
      const kotlinImports = extractKotlinImports(source);
      for (const fqName of kotlinImports) {
        const targetFile = resolveKotlinImport(fqName, kotlinFilesByBasename);
        if (targetFile) addEdge(file.path, targetFile);
      }
    }

    // PHP cross-file edges via PSR-4 `use` statement resolution.
    // Creates edges like: PostController.php → User.php when we see
    // `use App\Models\User;` and composer.json maps `App\` to `src/`.
    if (file.path.endsWith(".php")) {
      const uses = extractPhpUseStatements(source);
      for (const fqcn of uses) {
        try {
          const resolved = await resolvePhpNamespace(index.repo, fqcn);
          if (resolved.exists && resolved.file_path) {
            const candidate = resolved.file_path.replace(/^\.\//, "");
            // Prefer the exact indexed path (handles prefixes like "./src/")
            const targetFile = index.files.some((f) => f.path === candidate)
              ? candidate
              : normalizedPaths.get(candidate.replace(/\.php$/, "")) ?? null;
            if (targetFile && targetFile !== file.path) {
              addEdge(file.path, targetFile);
            }
          }
        } catch {
          // Missing composer.json, malformed PSR-4, etc. — skip edge, don't crash.
        }
      }
    }

    // Python imports via tree-sitter AST + package-aware resolution.
    // Uses parse cache to avoid re-parsing files already parsed by the
    // symbol extractor pipeline — Python files are the only ones parsed
    // twice per index (once for symbols, once for imports here).
    if (!pythonDisabled && file.path.endsWith(".py")) {
      try {
        const parser = await getParser("python");
        if (parser) {
          let tree = getCachedParse("python", source);
          if (!tree) {
            tree = parser.parse(source);
            setCachedParse("python", source, tree);
          }
          const pyImports = extractPythonImports(tree);
          for (const imp of pyImports) {
            const targetFile = resolvePythonImport(
              { module: imp.module, level: imp.level },
              file.path,
              indexedPyFileSet,
              pySrcLayout,
            );
            if (targetFile) {
              addEdge(file.path, targetFile, {
                type_only: imp.is_type_only,
                star_import: imp.is_star,
              });
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[import-graph] python extraction failed for ${file.path}: ${message}`,
        );
      }
    }
  }

  return edges;
}

/**
 * Compute file-level PageRank from import edges.
 *
 * Returns a Map of file path → PageRank score (sums to ~1). Isolated nodes
 * (files with neither incoming nor outgoing edges) are pre-filtered. On
 * empty input or a graphology/pagerank failure, returns an empty Map.
 * Used by wiki-hub-ranker (spec D4 Layer 2).
 */
export function buildFilePageRank(edges: ImportEdge[]): Map<string, number> {
  if (edges.length === 0) return new Map();
  try {
    const graph = new DirectedGraph();
    for (const edge of edges) {
      if (!graph.hasNode(edge.from)) graph.addNode(edge.from);
      if (!graph.hasNode(edge.to)) graph.addNode(edge.to);
      if (edge.from === edge.to) continue;
      if (!graph.hasEdge(edge.from, edge.to)) graph.addEdge(edge.from, edge.to);
    }
    if (graph.order === 0) return new Map();
    const scores = pagerank(graph);
    return new Map(Object.entries(scores));
  } catch {
    return new Map();
  }
}

/**
 * Build adjacency lists (bidirectional) from import edges.
 */
export function buildImportAdjacency(edges: ImportEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    let fromSet = adj.get(edge.from);
    if (!fromSet) { fromSet = new Set(); adj.set(edge.from, fromSet); }
    fromSet.add(edge.to);

    let toSet = adj.get(edge.to);
    if (!toSet) { toSet = new Set(); adj.set(edge.to, toSet); }
    toSet.add(edge.from);
  }
  return adj;
}
