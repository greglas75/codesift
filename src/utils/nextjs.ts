import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

/** Maximum bytes to read when scanning for a directive. */
export const DIRECTIVE_WINDOW = 512;

/**
 * Strip BOM, shebangs, single-line comments, and block comments
 * from the beginning of source text.
 */
function stripBomAndComments(text: string): string {
  let s = text;
  // Strip BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // Strip shebang
  if (s.startsWith("#!")) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1) : "";
  }
  // Iteratively strip leading comments
  let changed = true;
  while (changed) {
    changed = false;
    s = s.trimStart();
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl >= 0 ? s.slice(nl + 1) : "";
      changed = true;
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end >= 0) {
        s = s.slice(end + 2);
        changed = true;
      }
    }
  }
  return s;
}

/**
 * Scan a file's first 512 bytes for a `"use client"` or `"use server"` directive.
 * Returns the directive string or `null` if not found.
 */
export async function scanDirective(
  filePath: string,
): Promise<"use client" | "use server" | null> {
  try {
    const buf = await readFile(filePath, { encoding: "utf8", flag: "r" });
    const head = buf.slice(0, DIRECTIVE_WINDOW);
    const stripped = stripBomAndComments(head);
    const match = stripped.match(/^\s*["'`](use (?:client|server))["'`]\s*;?/);
    return match ? (match[1] as "use client" | "use server") : null;
  } catch {
    return null;
  }
}

/** App Router convention file names (without extension). */
const APP_CONVENTION_FILES = /^(page|layout|route|loading|error|not-found|global-error|default|template)$/;

/**
 * Derive a URL path from a file path relative to the repo root.
 * Handles App Router route groups, dynamic segments, and Pages Router conventions.
 */
export function deriveUrlPath(filePath: string, router: "app" | "pages"): string {
  let p = filePath;

  // Strip leading src/ if present
  if (p.startsWith("src/")) p = p.slice(4);

  if (router === "app") {
    // Strip app/ prefix
    p = p.replace(/^app\//, "");
    // Strip convention file at end (page.tsx, layout.tsx, route.ts, etc.)
    p = p.replace(/\/?(page|layout|route|loading|error|not-found|global-error|default|template)\.[jt]sx?$/, "");
    // Strip route groups like (auth)
    p = p.replace(/\([^)]+\)\/?/g, "");
    // Clean up trailing slash
    p = p.replace(/\/+$/, "");
  } else {
    // Pages Router: strip pages/ prefix and file extension
    p = p.replace(/^pages\//, "");
    p = p.replace(/\.[jt]sx?$/, "");
    // Strip index at end
    if (p === "index" || p.endsWith("/index")) {
      p = p.replace(/\/?index$/, "");
    }
  }

  return p ? `/${p}` : "/";
}

const NEXT_CONFIG_RE = /^next\.config\.(js|mjs|cjs|ts)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build"]);

/**
 * Discover Next.js workspaces in a monorepo by finding `next.config.*` files.
 * Returns empty array for single-app projects (config at root only) or no config.
 */
export async function discoverWorkspaces(
  repoRoot: string,
): Promise<{ root: string; configFile: string }[]> {
  const results: { root: string; configFile: string }[] = [];

  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await scan(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && NEXT_CONFIG_RE.test(entry.name)) {
        results.push({
          root: dir,
          configFile: join(dir, entry.name),
        });
      }
    }
  }

  await scan(repoRoot, 0);

  // Single config at root = not a monorepo
  if (results.length === 1 && results[0].root === repoRoot) {
    return [];
  }

  return results;
}
