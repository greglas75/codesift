import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname, relative, basename } from "node:path";
import picomatch from "picomatch";
import type Parser from "web-tree-sitter";
import { parseFile } from "../parser/parser-manager.js";

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

const LAYOUT_EXTENSIONS = ["tsx", "jsx", "ts", "js"];

/**
 * Walk up from `filePath` through ancestor directories collecting layout files.
 * Returns relative paths from root to leaf order. Stops at the `app/` boundary.
 * If `filePath` is itself a layout, it is excluded from the chain.
 */
export async function computeLayoutChain(
  filePath: string,
  repoRoot: string,
): Promise<string[]> {
  const chain: string[] = [];
  const rel = filePath.startsWith("/") ? relative(repoRoot, filePath) : filePath;
  const segments = rel.split("/");

  // Find the app/ boundary index
  const appIdx = segments.indexOf("app");
  if (appIdx < 0) return [];

  // Walk from app/ directory down to the parent of the target file
  // Skip the file's own directory if the file itself is a layout
  const targetBasename = basename(rel);
  const isLayout = /^layout\.[jt]sx?$/.test(targetBasename);
  const targetDir = dirname(rel);

  // Build paths from app/ to target's parent directory
  for (let i = appIdx; i < segments.length - 1; i++) {
    const dirPath = segments.slice(0, i + 1).join("/");

    // If the target is a layout, skip its own directory
    if (isLayout && dirPath === targetDir) continue;

    for (const ext of LAYOUT_EXTENSIONS) {
      const layoutPath = join(dirPath, `layout.${ext}`);
      const absPath = join(repoRoot, layoutPath);
      try {
        await access(absPath);
        chain.push(layoutPath);
        break; // Found a layout in this directory, move to next
      } catch {
        // No layout with this extension
      }
    }
  }

  return chain;
}

/** Candidate middleware file paths relative to repo root. */
const MIDDLEWARE_CANDIDATES = [
  "middleware.ts", "middleware.js",
  "src/middleware.ts", "src/middleware.js",
];

/**
 * Convert a Next.js matcher pattern to a picomatch-compatible glob.
 * Next.js uses `:path*` syntax; picomatch uses `**`.
 */
function matcherToGlob(pattern: string): string {
  return pattern.replace(/:[\w]+\*/g, "**").replace(/:[\w]+/g, "*");
}

/**
 * Check if a URL path matches any of the provided Next.js matcher patterns.
 */
function matchesMatcher(patterns: string[], urlPath: string): boolean {
  if (patterns.length === 0) return true; // No matcher = match all
  return patterns.some((p) => {
    const glob = matcherToGlob(p);
    return picomatch.isMatch(urlPath, glob);
  });
}

export interface MiddlewareTraceResult {
  file: string;
  matchers: string[];
  applies: boolean;
}

/**
 * Find and analyze middleware.ts for the given repo root.
 * Returns null if no middleware file exists.
 * Uses tree-sitter AST to extract matcher config.
 */
export async function traceMiddleware(
  repoRoot: string,
  urlPath: string,
): Promise<MiddlewareTraceResult | null> {
  // Find middleware file
  let mwFile: string | null = null;
  let mwRelPath: string | null = null;
  for (const candidate of MIDDLEWARE_CANDIDATES) {
    const absPath = join(repoRoot, candidate);
    try {
      await access(absPath);
      mwFile = absPath;
      mwRelPath = candidate;
      break;
    } catch {
      // Not found
    }
  }
  if (!mwFile || !mwRelPath) return null;

  // Parse the middleware file with tree-sitter
  let source: string;
  try {
    source = await readFile(mwFile, "utf8");
  } catch {
    return { file: mwRelPath, matchers: [], applies: true };
  }

  const tree = await parseFile(mwFile, source);
  if (!tree) {
    return { file: mwRelPath, matchers: [], applies: true };
  }

  // Find `export const config = { matcher: ... }`
  const exportStatements = tree.rootNode.descendantsOfType("export_statement");
  let matchers: string[] = [];
  let foundConfig = false;

  for (const exportNode of exportStatements) {
    const decl = exportNode.descendantsOfType("variable_declarator");
    for (const d of decl) {
      const nameNode = d.childForFieldName("name");
      if (nameNode?.text !== "config") continue;
      foundConfig = true;

      const init = d.childForFieldName("value");
      if (!init) continue;

      // Find the `matcher` property inside the object
      const pairs = init.descendantsOfType("pair");
      for (const pair of pairs) {
        const key = pair.childForFieldName("key");
        if (key?.text !== "matcher") continue;

        const value = pair.childForFieldName("value");
        if (!value) continue;

        if (value.type === "string") {
          // Single string matcher
          const text = value.text.slice(1, -1); // Remove quotes
          matchers = [text];
        } else if (value.type === "array") {
          // Array of matchers
          const elements = value.namedChildren;
          for (const el of elements) {
            if (el.type === "string") {
              matchers.push(el.text.slice(1, -1));
            } else {
              // Non-literal element — fail-open
              matchers = ["<computed>"];
              return { file: mwRelPath, matchers, applies: true };
            }
          }
        } else {
          // Computed matcher (identifier, call expression, etc.)
          matchers = ["<computed>"];
          return { file: mwRelPath, matchers, applies: true };
        }
      }
    }
  }

  if (!foundConfig) {
    // No config export → match all routes (Next.js default)
    return { file: mwRelPath, matchers: [], applies: true };
  }

  const applies = matchesMatcher(matchers, urlPath);
  return { file: mwRelPath, matchers, applies };
}

// ---------------------------------------------------------------------------
// Metadata export extraction (T1 helper)
// ---------------------------------------------------------------------------

export interface MetadataFields {
  title?: string;
  description?: string;
  openGraph?: {
    title?: string;
    description?: string;
    images?: string[];
  };
  twitter?: {
    card?: string;
    title?: string;
    description?: string;
  };
  alternates?: {
    canonical?: string;
  };
  robots?: string;
  other?: Record<string, unknown>;
  /** Set when the metadata export references an identifier or a non-literal expression. */
  _non_literal?: boolean;
}

/** Unwrap a tree-sitter string node (e.g. `"foo"`, `'foo'`, `` `foo` ``) to its literal content, or null. */
function readStringLiteral(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") {
    // Look for string_fragment child first (quoted string)
    const frag = node.namedChildren.find((c) => c.type === "string_fragment");
    if (frag) return frag.text;
    const raw = node.text;
    if (raw.length >= 2) return raw.slice(1, -1);
    return raw;
  }
  if (node.type === "template_string") {
    // Only accept fully-literal template strings (no substitutions)
    const hasSubs = node.namedChildren.some((c) => c.type === "template_substitution");
    if (hasSubs) return null;
    const raw = node.text;
    if (raw.length >= 2) return raw.slice(1, -1);
    return raw;
  }
  return null;
}

/** Extract a string-literal array (e.g. `["a","b"]`) into a string[]. Returns null if any element is non-literal. */
function readStringArray(node: Parser.SyntaxNode | null | undefined): string[] | null {
  if (!node || node.type !== "array") return null;
  const out: string[] = [];
  for (const el of node.namedChildren) {
    const s = readStringLiteral(el);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** Walk an object literal node and return a map of literal key -> child value node. */
function readObjectPairs(
  node: Parser.SyntaxNode,
): Map<string, Parser.SyntaxNode> {
  const map = new Map<string, Parser.SyntaxNode>();
  if (node.type !== "object") return map;
  for (const pair of node.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key") ?? pair.namedChild(0);
    if (!key) continue;
    let keyText: string | null = null;
    if (key.type === "property_identifier" || key.type === "identifier") {
      keyText = key.text;
    } else if (key.type === "string") {
      keyText = readStringLiteral(key);
    }
    if (!keyText) continue;
    const value = pair.childForFieldName("value") ?? pair.namedChild(1);
    if (value) map.set(keyText, value);
  }
  return map;
}

/** Read known metadata fields off an object-literal node into the MetadataFields shape. */
function readMetadataObject(obj: Parser.SyntaxNode): MetadataFields {
  const out: MetadataFields = {};
  if (obj.type !== "object") return out;
  const pairs = readObjectPairs(obj);

  const title = pairs.get("title");
  if (title) {
    const s = readStringLiteral(title);
    if (s !== null) out.title = s;
  }

  const description = pairs.get("description");
  if (description) {
    const s = readStringLiteral(description);
    if (s !== null) out.description = s;
  }

  const robots = pairs.get("robots");
  if (robots) {
    const s = readStringLiteral(robots);
    if (s !== null) out.robots = s;
  }

  const openGraph = pairs.get("openGraph");
  if (openGraph && openGraph.type === "object") {
    const ogPairs = readObjectPairs(openGraph);
    const og: NonNullable<MetadataFields["openGraph"]> = {};
    const ogTitle = ogPairs.get("title");
    if (ogTitle) {
      const s = readStringLiteral(ogTitle);
      if (s !== null) og.title = s;
    }
    const ogDesc = ogPairs.get("description");
    if (ogDesc) {
      const s = readStringLiteral(ogDesc);
      if (s !== null) og.description = s;
    }
    const ogImages = ogPairs.get("images");
    if (ogImages) {
      const arr = readStringArray(ogImages);
      if (arr) og.images = arr;
    }
    out.openGraph = og;
  }

  const twitter = pairs.get("twitter");
  if (twitter && twitter.type === "object") {
    const tPairs = readObjectPairs(twitter);
    const tw: NonNullable<MetadataFields["twitter"]> = {};
    const tCard = tPairs.get("card");
    if (tCard) {
      const s = readStringLiteral(tCard);
      if (s !== null) tw.card = s;
    }
    const tTitle = tPairs.get("title");
    if (tTitle) {
      const s = readStringLiteral(tTitle);
      if (s !== null) tw.title = s;
    }
    const tDesc = tPairs.get("description");
    if (tDesc) {
      const s = readStringLiteral(tDesc);
      if (s !== null) tw.description = s;
    }
    out.twitter = tw;
  }

  const alternates = pairs.get("alternates");
  if (alternates && alternates.type === "object") {
    const aPairs = readObjectPairs(alternates);
    const alt: NonNullable<MetadataFields["alternates"]> = {};
    const canonical = aPairs.get("canonical");
    if (canonical) {
      const s = readStringLiteral(canonical);
      if (s !== null) alt.canonical = s;
    }
    out.alternates = alt;
  }

  const other = pairs.get("other");
  if (other && other.type === "object") {
    // Store the raw text; callers treat this as opaque "any custom fields exist" marker.
    out.other = { _raw: other.text };
  }

  return out;
}

/**
 * Parse a Next.js page/layout for `metadata` or `generateMetadata` exports.
 *
 * Supports two shapes:
 *   - `export const metadata = { title: "...", ... }`
 *   - `export async function generateMetadata() { return { ... }; }`
 *
 * Returns an empty object when no metadata export is present, and sets
 * `_non_literal: true` when the export exists but is not a parseable object
 * literal (e.g. `export const metadata = someExternal`).
 */
export function parseMetadataExport(tree: Parser.Tree, _source: string): MetadataFields {
  const root = tree.rootNode;
  const exportStatements = root.descendantsOfType("export_statement");

  // Pass 1: look for `export const metadata = ...`
  for (const exp of exportStatements) {
    for (const decl of exp.descendantsOfType("variable_declarator")) {
      const name = decl.childForFieldName("name");
      if (name?.text !== "metadata") continue;
      const value = decl.childForFieldName("value");
      if (!value) return { _non_literal: true };
      if (value.type !== "object") return { _non_literal: true };
      return readMetadataObject(value);
    }
  }

  // Pass 2: look for `export async function generateMetadata` (or variant).
  for (const exp of exportStatements) {
    const fnDecl = exp.descendantsOfType("function_declaration")[0];
    if (!fnDecl) continue;
    const fnName = fnDecl.childForFieldName("name");
    if (fnName?.text !== "generateMetadata") continue;
    // Walk the body for a `return <object>` statement.
    const body = fnDecl.childForFieldName("body");
    if (!body) continue;
    const returns = body.descendantsOfType("return_statement");
    for (const ret of returns) {
      // Skip nested return statements belonging to inner functions.
      // Compare by node.id because tree-sitter wrappers are not reference-stable.
      let parent: Parser.SyntaxNode | null = ret.parent;
      let inInnerFn = false;
      while (parent && parent.id !== fnDecl.id) {
        if (
          parent.type === "function_declaration" ||
          parent.type === "arrow_function" ||
          parent.type === "function_expression" ||
          parent.type === "method_definition"
        ) {
          inInnerFn = true;
          break;
        }
        parent = parent.parent;
      }
      if (inInnerFn) continue;
      const retValue = ret.namedChildren[0];
      if (!retValue) continue;
      // The returned expression may be wrapped in parentheses: `return ({ ... })`
      const unwrap =
        retValue.type === "parenthesized_expression"
          ? retValue.namedChildren[0]
          : retValue;
      if (!unwrap) continue;
      if (unwrap.type === "object") {
        return readMetadataObject(unwrap);
      }
      // Non-literal return → flag
      return { _non_literal: true };
    }
  }

  return {};
}
