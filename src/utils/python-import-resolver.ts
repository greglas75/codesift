/**
 * Python import resolution — pure functions, no I/O.
 *
 * Handles:
 *   - Relative imports (`from . import X`, `from ..pkg import Y`) via dot
 *     counting and package-root walking
 *   - Absolute imports (`import X`, `from X.Y import Z`) via index lookup
 *     with automatic `src/` layout detection
 *   - `.py` and `__init__.py` resolution
 */

/**
 * Walk upward from a file to find the innermost package root.
 * A "package" is a directory containing `__init__.py`. The package root is
 * the innermost ancestor directory (including the file's own directory) that
 * contains `__init__.py`.
 *
 * If no ancestor has `__init__.py`, returns the file's directory.
 * If the file is at repo root, returns "".
 */
export function findPackageRoot(
  filePath: string,
  indexedFiles: Set<string>,
): string {
  const segments = filePath.split("/");
  segments.pop(); // remove filename

  // Walk from deepest dir upward; return first dir with __init__.py
  for (let i = segments.length; i >= 1; i--) {
    const dir = segments.slice(0, i).join("/");
    if (indexedFiles.has(`${dir}/__init__.py`)) {
      return dir;
    }
  }

  // No package found — return file's directory (or "" for repo root)
  return segments.join("/");
}

/**
 * Detect if the project uses a `src/` layout (e.g., `src/myapp/__init__.py`).
 * Returns the layout root name (`"src"`) or `null` if no src layout detected.
 */
export function detectSrcLayout(indexedFiles: string[]): string | null {
  for (const f of indexedFiles) {
    const match = f.match(/^src\/([^/]+)\/__init__\.py$/);
    if (match) return "src";
  }
  return null;
}

/**
 * Resolve a Python import to a file path in the indexed tree.
 *
 * Algorithm:
 *   - If `level > 0` (relative import): walk up `level - 1` dirs from the
 *     importing file's package root, then resolve the remaining dotted path
 *   - If `level === 0` (absolute import): try each search root + dotted path,
 *     resolving to `.py` first, then `/__init__.py`, then null
 *
 * Returns the resolved file path (relative to repo root) or `null` if the
 * import cannot be resolved to an indexed file (stdlib, third-party, etc.).
 */
export function resolvePythonImport(
  imp: { module: string; level: number },
  importerFile: string,
  indexedFiles: string[] | Set<string>,
  srcLayout?: string | null,
): string | null {
  const fileSet = indexedFiles instanceof Set ? indexedFiles : new Set(indexedFiles);
  const { module, level } = imp;

  if (level > 0) {
    // Relative import
    const packageRoot = findPackageRoot(importerFile, fileSet);
    const packageSegments = packageRoot === "" ? [] : packageRoot.split("/");

    // Walk up (level - 1) directories from package root
    if (level - 1 > packageSegments.length) return null;
    const baseSegments = packageSegments.slice(0, packageSegments.length - (level - 1));
    const moduleSegments = module === "" ? [] : module.split(".");
    const fullPath = [...baseSegments, ...moduleSegments].join("/");

    return tryResolve(fullPath, fileSet);
  }

  // Absolute import — try repo root first, then src/ layout
  const moduleSegments = module.split(".");
  const resolvedSrcLayout = srcLayout !== undefined ? srcLayout : detectSrcLayout([...fileSet]);
  const searchRoots = ["", resolvedSrcLayout].filter(
    (r): r is string => r !== null,
  );

  for (const root of searchRoots) {
    const base = root === "" ? moduleSegments.join("/") : `${root}/${moduleSegments.join("/")}`;
    const resolved = tryResolve(base, fileSet);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Try to resolve a path to an indexed file.
 * Tries `.py` first, then `/__init__.py`.
 */
function tryResolve(basePath: string, fileSet: Set<string>): string | null {
  if (basePath === "") return null;

  // Try direct .py file
  const asPyFile = `${basePath}.py`;
  if (fileSet.has(asPyFile)) return asPyFile;

  // Try as package __init__.py
  const asInit = `${basePath}/__init__.py`;
  if (fileSet.has(asInit)) return asInit;

  return null;
}
