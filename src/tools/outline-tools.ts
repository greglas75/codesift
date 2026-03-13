import { getCodeIndex } from "./index-tools.js";
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
}

export interface FileOutlineEntry {
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
 * Match a filename or path against a simple glob pattern.
 * Supports: "*.ts", "src/*.ts", "**\/*.ts"
 */
function matchNamePattern(filePath: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return matchNamePattern(filePath, suffix) ||
      filePath.includes("/" + suffix);
  }

  if (pattern.startsWith("*") && !pattern.includes("/")) {
    const suffix = pattern.slice(1);
    return filePath.endsWith(suffix);
  }

  if (!pattern.includes("*")) {
    return filePath.includes(pattern);
  }

  // Fallback: treat * as wildcard in the filename portion
  const fileName = filePath.includes("/")
    ? filePath.slice(filePath.lastIndexOf("/") + 1)
    : filePath;

  if (pattern.startsWith("*") && pattern.endsWith("*")) {
    return fileName.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith("*")) {
    return fileName.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return fileName.startsWith(pattern.slice(0, -1));
  }

  return filePath.includes(pattern);
}

/**
 * Count the depth of a path (number of "/" separators).
 */
function pathDepth(filePath: string): number {
  if (!filePath) return 0;
  return filePath.split("/").length;
}

/**
 * Build a nested file tree from a flat list of file paths.
 */
function buildTree(
  index: CodeIndex,
  options?: FileTreeOptions,
): FileTreeNode[] {
  const maxDepth = options?.depth ?? Infinity;
  const pathPrefix = options?.path_prefix;
  const namePattern = options?.name_pattern;

  // Build a symbol count lookup by file path
  const symbolCountByFile = new Map<string, number>();
  for (const file of index.files) {
    symbolCountByFile.set(file.path, file.symbol_count);
  }

  // Filter files
  let files = index.files;

  if (pathPrefix) {
    const prefix = pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/";
    files = files.filter((f) => f.path.startsWith(prefix) || f.path === pathPrefix);
  }

  if (namePattern) {
    files = files.filter((f) => matchNamePattern(f.path, namePattern));
  }

  // Compute base depth for relative depth limiting
  const baseDepth = pathPrefix ? pathDepth(pathPrefix) : 0;

  // Collect unique directory paths and file entries within depth limit
  const dirSet = new Set<string>();
  const visibleFiles = new Set<string>();

  for (const file of files) {
    const relativeDepth = pathDepth(file.path) - baseDepth;

    if (relativeDepth <= maxDepth) {
      visibleFiles.add(file.path);
    }

    // Add all parent directories (up to depth limit)
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/");
      const dirRelDepth = pathDepth(dirPath) - baseDepth;
      if (dirRelDepth <= maxDepth - 1) {
        dirSet.add(dirPath);
      }
    }
  }

  // Build nested tree using a map
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

  for (const [nodePath, node] of nodeMap) {
    const lastSlash = nodePath.lastIndexOf("/");
    if (lastSlash < 0) {
      roots.push(node);
    } else {
      const parentPath = nodePath.slice(0, lastSlash);
      const parent = nodeMap.get(parentPath);
      if (parent?.children) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
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
 * Get a nested file tree for a repository.
 * Supports filtering by path prefix, name pattern, and depth.
 */
export async function getFileTree(
  repo: string,
  options?: FileTreeOptions,
): Promise<FileTreeNode[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  return buildTree(index, options);
}

/**
 * Get an outline of symbols in a specific file.
 * Returns symbols sorted by start line, with source stripped for brevity.
 */
export async function getFileOutline(
  repo: string,
  filePath: string,
): Promise<FileOutlineEntry[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Run index_folder first.`);
  }

  const symbols = index.symbols
    .filter((s) => s.file === filePath)
    .sort((a, b) => a.start_line - b.start_line);

  return symbols.map((s) => {
    const entry: FileOutlineEntry = {
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

  // Build directory outlines sorted by path
  const directories: DirectoryOutline[] = [...dirMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, data]) => ({
      path,
      file_count: data.files,
      symbol_count: data.symbols,
      languages: [...data.languages].sort(),
    }));

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
