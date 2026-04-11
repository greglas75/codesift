/**
 * Import graph utilities — shared by context-tools, route-tools, community-tools.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeIndex } from "../types.js";
import { getParser } from "../parser/parser-manager.js";
import { extractPythonImports } from "./python-imports.js";
import { resolvePythonImport } from "./python-import-resolver.js";

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
const PHP_USE_PATTERN = /^\s*use\s+([A-Z][\w\\]+)(?:\s+as\s+\w+)?\s*;/gm;

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
  resolved = resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs|php)$/, "");

  return resolved;
}

/**
 * Extract PHP `use` statements (FQCN imports).
 * Returns fully-qualified class/namespace names without the leading backslash.
 * These are NOT file paths — they require PSR-4 resolution against composer.json.
 */
export function extractPhpUseStatements(source: string): string[] {
  const uses = new Set<string>();
  PHP_USE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHP_USE_PATTERN.exec(source)) !== null) {
    const fqcn = match[1]?.replace(/^\\/, "");
    if (fqcn) uses.add(fqcn);
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

/**
 * Build normalized path map for matching imports to indexed files.
 */
export function buildNormalizedPathMap(index: CodeIndex): Map<string, string> {
  const normalizedPaths = new Map<string, string>();
  for (const file of index.files) {
    const normalized = file.path.replace(/\.(ts|tsx|js|jsx|mjs|cjs|php|kt|kts|py)$/, "");
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
  const edgeSet = new Set<string>();
  const edges: ImportEdge[] = [];

  // Rollback kill switch — skip Python import extraction if env var set
  const pythonDisabled = process.env.CODESIFT_DISABLE_PYTHON_IMPORTS === "1";

  // Python needs the full indexed file list for package resolution
  const indexedPyFiles = index.files
    .filter((f) => f.path.endsWith(".py"))
    .map((f) => f.path);

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

    // Relative-path imports (JS/TS/PHP)
    const importPaths = extractImports(source);
    for (const importPath of importPaths) {
      const resolved = resolveImportPath(file.path, importPath);
      const targetFile = normalizedPaths.get(resolved);
      if (targetFile) addEdge(file.path, targetFile);
    }

    // Kotlin fully-qualified imports (.kt/.kts files only)
    if (/\.kts?$/.test(file.path)) {
      const kotlinImports = extractKotlinImports(source);
      for (const fqName of kotlinImports) {
        const targetFile = resolveKotlinImport(fqName, kotlinFilesByBasename);
        if (targetFile) addEdge(file.path, targetFile);
      }
    }

    // Python imports via tree-sitter AST + package-aware resolution
    if (!pythonDisabled && file.path.endsWith(".py")) {
      try {
        const parser = await getParser("python");
        if (parser) {
          const tree = parser.parse(source);
          const pyImports = extractPythonImports(tree);
          for (const imp of pyImports) {
            const targetFile = resolvePythonImport(
              { module: imp.module, level: imp.level },
              file.path,
              indexedPyFiles,
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
