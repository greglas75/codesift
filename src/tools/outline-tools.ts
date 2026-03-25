import { getCodeIndex } from "./index-tools.js";
import { matchNamePattern } from "../utils/glob.js";
import type { CodeIndex, SymbolKind } from "../types.js";

export interface FileTreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  symbol_count?: number;
  children?: FileTreeNode[];
}

export interface FileTreeOptions {
  path_prefix?: string | undefined;
  name_pattern?: string | undefined;
  depth?: number | undefined;
  compact?: boolean | undefined;
  min_symbols?: number | undefined;
}

export interface CompactFileEntry {
  path: string;
  symbols: number;
}

export interface FileOutlineEntry {
  id: string;
  name: string;
  kind: SymbolKind;
  signature?: string;
  start_line: number;
  end_line: number;
  parent?: string;
}

export interface DirectoryOutline {
  path: string;
  file_count: number;
  symbol_count: number;
  languages: string[];
}

export interface RepoOutlineResult {
  directories: DirectoryOutline[];
  total_symbols: number;
  total_files: number;
  languages: Record<string, number>;
}

/**
 * Count the depth of a path (number of "/" separators).
 */
function pathDepth(filePath: string): number {
  if (!filePath) return 0;
  return filePath.split("/").length;
}

/** Filter index files by shared criteria (path prefix, name pattern, min symbols). */
function filterIndexFiles(
  index: CodeIndex,
  options?: { path_prefix?: string | undefined; name_pattern?: string | undefined; min_symbols?: number | undefined },
): CodeIndex["files"] {
  let files = index.files;
  const pathPrefix = options?.path_prefix;
  const namePattern = options?.name_pattern;
  const minSymbols = options?.min_symbols;

  if (pathPrefix) {
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/";
    files = files.filter((f) => f.path.startsWith(prefix));
  }
  if (namePattern) {
    files = files.filter((f) => matchNamePattern(f.path, namePattern));
  }
  if (minSymbols !== undefined && minSymbols > 0) {
    files = files.filter((f) => f.symbol_count >= minSymbols);
  }
  return files;
}

/**
 * Build a nested file tree from a flat list of file paths.
 *
 * Depth semantics: depth=N shows N levels below the root.
 *   depth=1 → immediate children only (files + dirs, dirs shown without contents)
 *   depth=2 → children + grandchildren
 *
 * When path_prefix is set, the tree is rooted AT the prefix (not wrapped in
 * ancestor directories). When name_pattern is set, empty branches are pruned.
 */
function buildTree(
  index: CodeIndex,
  options?: FileTreeOptions,
): FileTreeNode[] {
  const maxDepth = options?.depth ?? Infinity;
  const pathPrefix = options?.path_prefix;
  const namePattern = options?.name_pattern;

  const minSymbols = options?.min_symbols;

  // Build a symbol count lookup by file path
  const symbolCountByFile = new Map<string, number>();
  for (const file of index.files) {
    symbolCountByFile.set(file.path, file.symbol_count);
  }

  // --- Step 1: Filter files by path_prefix, name_pattern, and min_symbols ---
  const files = filterIndexFiles(index, { path_prefix: pathPrefix, name_pattern: namePattern, min_symbols: minSymbols });

  // Base depth: number of path segments in the prefix (tree root level).
  // Files/dirs are measured relative to this.
  const baseDepth = pathPrefix ? pathDepth(pathPrefix) : 0;

  // --- Step 2: Collect visible files and their ancestor directories ---
  const dirSet = new Set<string>();
  const visibleFiles = new Set<string>();

  for (const file of files) {
    const fileRelDepth = pathDepth(file.path) - baseDepth;

    // depth filter: only include files within maxDepth levels of the root
    if (fileRelDepth > maxDepth) continue;

    visibleFiles.add(file.path);

    // Add ancestor directories between the prefix and this file (not above prefix)
    const parts = file.path.split("/");
    const startIdx = baseDepth; // skip segments that are part of the prefix
    for (let i = startIdx + 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/");
      dirSet.add(dirPath);
    }
  }

  // When depth is limited, also show directories at exactly maxDepth that
  // WOULD have children (so the user knows there's more to explore).
  // These appear as dirs without expanded children.
  if (maxDepth < Infinity) {
    for (const file of files) {
      const fileRelDepth = pathDepth(file.path) - baseDepth;
      if (fileRelDepth <= maxDepth) continue; // already handled above

      // This file is beyond maxDepth — add its ancestor dir at maxDepth level
      const parts = file.path.split("/");
      const truncLen = baseDepth + maxDepth;
      if (truncLen < parts.length) {
        const dirPath = parts.slice(0, truncLen).join("/");
        dirSet.add(dirPath);
        // Also add intermediate dirs between prefix and this truncated dir
        for (let i = baseDepth + 1; i < truncLen; i++) {
          dirSet.add(parts.slice(0, i).join("/"));
        }
      }
    }
  }

  // --- Step 3: Build nested tree from nodeMap ---
  const nodeMap = new Map<string, FileTreeNode>();

  // Create directory nodes
  for (const dirPath of dirSet) {
    const name = dirPath.includes("/")
      ? dirPath.slice(dirPath.lastIndexOf("/") + 1)
      : dirPath;
    nodeMap.set(dirPath, {
      name,
      path: dirPath,
      type: "dir",
      children: [],
    });
  }

  // Create file nodes
  for (const filePath of visibleFiles) {
    const name = filePath.includes("/")
      ? filePath.slice(filePath.lastIndexOf("/") + 1)
      : filePath;
    nodeMap.set(filePath, {
      name,
      path: filePath,
      type: "file",
      symbol_count: symbolCountByFile.get(filePath) ?? 0,
    });
  }

  // Wire up parent-child relationships
  const roots: FileTreeNode[] = [];
  // The root path is the path_prefix itself (if set), or empty (repo root)
  const rootPath = pathPrefix ?? "";

  for (const [nodePath, node] of nodeMap) {
    const lastSlash = nodePath.lastIndexOf("/");
    if (lastSlash < 0) {
      // Top-level item (no parent directory)
      roots.push(node);
    } else {
      const parentPath = nodePath.slice(0, lastSlash);
      // If parent is the root prefix (or above it), this node is a root
      if (parentPath === rootPath || pathDepth(parentPath) < baseDepth) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(parentPath);
        if (parent?.children) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }
  }

  // --- Step 4: Prune empty directories (when filtering is active) ---
  if (namePattern || (minSymbols !== undefined && minSymbols > 0)) {
    function hasVisibleDescendant(node: FileTreeNode): boolean {
      if (node.type === "file") return true;
      if (!node.children) return false;
      node.children = node.children.filter(hasVisibleDescendant);
      return node.children.length > 0;
    }
    const pruned = roots.filter(hasVisibleDescendant);
    roots.length = 0;
    roots.push(...pruned);
  }

  // Sort children: directories first, then alphabetically
  function sortChildren(nodes: FileTreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        sortChildren(node.children);
      }
    }
  }

  sortChildren(roots);

  return roots;
}

/**
 * Build a compact flat list of file paths with symbol counts.
 * Much cheaper than the full nested tree — similar to `find` output.
 */
function buildCompactList(
  index: CodeIndex,
  options?: FileTreeOptions,
): CompactFileEntry[] {
  const pathPrefix = options?.path_prefix;

  let files = filterIndexFiles(index, { path_prefix: pathPrefix, name_pattern: options?.name_pattern, min_symbols: options?.min_symbols });

  // depth filter: count path segments relative to the prefix
  const maxDepth = options?.depth ?? Infinity;
  if (maxDepth < Infinity) {
    const baseDepth = pathPrefix ? pathDepth(pathPrefix) : 0;
    files = files.filter((f) => pathDepth(f.path) - baseDepth <= maxDepth);
  }

  return files
    .map((f) => ({ path: f.path, symbols: f.symbol_count }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Get a nested file tree for a repository.
 * Supports filtering by path prefix, name pattern, and depth.
 *
 * When `compact=true`, returns a flat sorted list of `{ path, symbols }`
 * entries instead of the full nested tree — 10-50x less output.
 */
const MAX_TREE_FILES = 500; // Cap file count in tree output to prevent 30K+ tok responses

export async function getFileTree(
  repo: string,
  options?: FileTreeOptions,
): Promise<FileTreeNode[] | CompactFileEntry[] | { entries: CompactFileEntry[]; truncated: boolean; total: number; hint: string }> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  if (options?.compact) {
    const list = buildCompactList(index, options);
    if (list.length > MAX_TREE_FILES) {
      return {
        entries: list.slice(0, MAX_TREE_FILES),
        truncated: true,
        total: list.length,
        hint: `Showing ${MAX_TREE_FILES}/${list.length} files. Use path_prefix or name_pattern to narrow scope.`,
      };
    }
    return list;
  }

  // For non-compact (nested tree), force compact when result would be huge
  const filteredFiles = filterIndexFiles(index, {
    path_prefix: options?.path_prefix,
    name_pattern: options?.name_pattern,
    min_symbols: options?.min_symbols,
  });

  if (filteredFiles.length > MAX_TREE_FILES) {
    const list = buildCompactList(index, options).slice(0, MAX_TREE_FILES);
    return {
      entries: list,
      truncated: true,
      total: filteredFiles.length,
      hint: `Auto-compacted: ${filteredFiles.length} files exceeds ${MAX_TREE_FILES} limit. Use path_prefix, name_pattern, or compact=true.`,
    };
  }

  return buildTree(index, options);
}

/**
 * Get an outline of symbols in a specific file.
 * Returns symbols sorted by start line, with source stripped for brevity.
 */
const MAX_OUTLINE_SYMBOLS = 200;

export async function getFileOutline(
  repo: string,
  filePath: string,
): Promise<{ symbols: FileOutlineEntry[]; truncated?: boolean; total_symbols?: number }> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const allSymbols = index.symbols
    .filter((s) => s.file === filePath)
    .sort((a, b) => a.start_line - b.start_line);

  const truncated = allSymbols.length > MAX_OUTLINE_SYMBOLS;
  const symbols = truncated ? allSymbols.slice(0, MAX_OUTLINE_SYMBOLS) : allSymbols;

  const entries = symbols.map((s) => {
    const entry: FileOutlineEntry = {
      id: s.id,
      name: s.name,
      kind: s.kind,
      start_line: s.start_line,
      end_line: s.end_line,
    };
    if (s.signature !== undefined) {
      entry.signature = s.signature;
    }
    if (s.parent !== undefined) {
      entry.parent = s.parent;
    }
    return entry;
  });

  if (truncated) {
    return { symbols: entries, truncated: true, total_symbols: allSymbols.length };
  }
  return { symbols: entries };
}

/**
 * Get a high-level outline of the entire repository.
 * Groups files by directory with symbol counts and language breakdown.
 */
export async function getRepoOutline(
  repo: string,
): Promise<RepoOutlineResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  // Group files by directory
  const dirMap = new Map<string, { files: number; symbols: number; languages: Set<string> }>();

  for (const file of index.files) {
    const lastSlash = file.path.lastIndexOf("/");
    const dirPath = lastSlash >= 0 ? file.path.slice(0, lastSlash) : ".";

    let entry = dirMap.get(dirPath);
    if (!entry) {
      entry = { files: 0, symbols: 0, languages: new Set() };
      dirMap.set(dirPath, entry);
    }

    entry.files++;
    entry.symbols += file.symbol_count;
    entry.languages.add(file.language);
  }

  // Build directory outlines, cap to top 100 by symbol count to prevent 50K+ responses
  const MAX_OUTLINE_DIRS = 100;
  const allDirs = [...dirMap.entries()]
    .map(([path, data]) => ({
      path,
      file_count: data.files,
      symbol_count: data.symbols,
      languages: [...data.languages].sort(),
    }));
  const directories: DirectoryOutline[] = allDirs.length > MAX_OUTLINE_DIRS
    ? allDirs.sort((a, b) => b.symbol_count - a.symbol_count).slice(0, MAX_OUTLINE_DIRS)
    : allDirs.sort((a, b) => a.path.localeCompare(b.path));

  // Compute global language counts
  const languageCounts: Record<string, number> = {};
  for (const file of index.files) {
    languageCounts[file.language] = (languageCounts[file.language] ?? 0) + 1;
  }

  return {
    directories,
    total_symbols: index.symbol_count,
    total_files: index.file_count,
    languages: languageCounts,
  };
}

/**
 * Suggest useful queries for exploring an unfamiliar repo.
 * Returns top symbol names, most-symbol-dense files, kind distribution,
 * and example queries ready to paste.
 */
export async function suggestQueries(repo: string): Promise<{
  top_files: Array<{ path: string; symbols: number }>;
  kind_distribution: Record<string, number>;
  example_queries: string[];
}> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  // Top files by symbol count
  const topFiles = [...index.files]
    .sort((a, b) => b.symbol_count - a.symbol_count)
    .slice(0, 10)
    .map((f) => ({ path: f.path, symbols: f.symbol_count }));

  // Kind distribution
  const kinds: Record<string, number> = {};
  for (const sym of index.symbols) {
    kinds[sym.kind] = (kinds[sym.kind] ?? 0) + 1;
  }

  // Extract top symbol names by frequency (most common names = core concepts)
  const nameCounts = new Map<string, number>();
  for (const sym of index.symbols) {
    // Skip internal/anonymous
    if (sym.name.startsWith("<") || sym.name.length < 3) continue;
    nameCounts.set(sym.name, (nameCounts.get(sym.name) ?? 0) + 1);
  }
  const topNames = [...nameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  // Build example queries
  const examples: string[] = [];
  if (topFiles[0]) {
    examples.push(`get_file_outline(repo, "${topFiles[0].path}")`);
  }
  for (const name of topNames.slice(0, 3)) {
    examples.push(`search_symbols(repo, "${name}")`);
  }
  if (topFiles[0]) {
    const dir = topFiles[0].path.split("/").slice(0, -1).join("/");
    if (dir) examples.push(`get_file_tree(repo, path_prefix="${dir}")`);
  }

  return {
    top_files: topFiles,
    kind_distribution: kinds,
    example_queries: examples,
  };
}
