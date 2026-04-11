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

// ---------------------------------------------------------------------------
// Fetch / cookies / headers call extraction (Q2, T6 helper)
// ---------------------------------------------------------------------------

export type FetchCallee = "fetch" | "cookies" | "headers" | "unstable_noStore";

export interface FetchCall {
  callee: FetchCallee;
  line: number;
  /**
   * Parsed cache directive from fetch() options:
   *   - `"force-cache"` / `"no-store"` / `"default"` / ...
   *   - `"isr-60"` for `next: { revalidate: 60 }`
   *   - `null` when no options or fetch callee
   */
  cacheOption: string | null;
  /** True if this awaited call is sequential w.r.t. a previous await in the same block. */
  isSequential: boolean;
  /** True if this call forces SSR (cookies/headers, fetch no-store, unstable_noStore). */
  isSsrTrigger: boolean;
}

/** Extract the string-literal or number-literal value of a single pair inside an object node. */
function readPairValue(obj: Parser.SyntaxNode, key: string): Parser.SyntaxNode | null {
  if (obj.type !== "object") return null;
  const pairs = readObjectPairs(obj);
  return pairs.get(key) ?? null;
}

function parseCacheOption(optsNode: Parser.SyntaxNode | null): string | null {
  if (!optsNode || optsNode.type !== "object") return null;
  // cache: 'no-store' | 'force-cache' | 'default' | ...
  const cacheVal = readPairValue(optsNode, "cache");
  if (cacheVal) {
    const s = readStringLiteral(cacheVal);
    if (s) return s;
  }
  // next: { revalidate: <number> }
  const nextVal = readPairValue(optsNode, "next");
  if (nextVal && nextVal.type === "object") {
    const rev = readPairValue(nextVal, "revalidate");
    if (rev) {
      if (rev.type === "number") return `isr-${rev.text}`;
      // Fallback: accept negative/parenthesized numeric text
      const text = rev.text;
      if (/^-?\d+$/.test(text)) return `isr-${text}`;
    }
  }
  return null;
}

/**
 * Collect the enclosing `statement_block` id of a node (for grouping awaits by scope).
 */
function enclosingBlockId(node: Parser.SyntaxNode): number | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "statement_block") return cur.id;
    cur = cur.parent;
  }
  return null;
}

/**
 * Walk upward from `node` to find the containing `await_expression`, or null.
 */
function enclosingAwait(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "await_expression") return cur;
    if (
      cur.type === "statement_block" ||
      cur.type === "program" ||
      cur.type === "function_declaration" ||
      cur.type === "arrow_function" ||
      cur.type === "function_expression"
    ) {
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Collect the identifiers bound by a single statement (`const x = …`, `const {a,b} = …`).
 * Returns an empty set for non-declarations.
 */
function identifiersBoundByStatement(stmt: Parser.SyntaxNode): Set<string> {
  const out = new Set<string>();
  if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") {
    return out;
  }
  for (const decl of stmt.namedChildren) {
    if (decl.type !== "variable_declarator") continue;
    const name = decl.childForFieldName("name");
    if (!name) continue;
    if (name.type === "identifier") {
      out.add(name.text);
    } else if (name.type === "object_pattern" || name.type === "array_pattern") {
      for (const id of name.descendantsOfType("identifier")) {
        out.add(id.text);
      }
      for (const id of name.descendantsOfType("shorthand_property_identifier_pattern")) {
        out.add(id.text);
      }
    }
  }
  return out;
}

/** Collect all identifier references inside a subtree. */
function collectIdentifierRefs(node: Parser.SyntaxNode): Set<string> {
  const out = new Set<string>();
  for (const id of node.descendantsOfType("identifier")) {
    out.add(id.text);
  }
  return out;
}

/**
 * Read all fetch/cookies/headers/unstable_noStore calls out of a tree.
 *
 * `isSequential` is set when two awaited fetches live in the same statement_block
 * with no identifier overlap between the earlier statement's bindings and the
 * later statement's argument expression. Callers wanting waterfall detection
 * use this flag directly.
 *
 * `// sequential intentional` comments on the line preceding an await suppress
 * the flag for that await.
 */
export function extractFetchCalls(tree: Parser.Tree, source: string): FetchCall[] {
  const root = tree.rootNode;
  const out: FetchCall[] = [];

  // Lines with `// sequential intentional` opt-out comment
  const optOutLines = new Set<number>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/\/\/\s*sequential intentional/i.test(lines[i]!)) {
      // The opt-out comment applies to the NEXT line
      optOutLines.add(i + 2); // next source line (1-indexed)
    }
  }

  // Pass 1: collect raw calls, grouped by (block, topLevelStatement) for sequential detection
  type RawCall = {
    callee: FetchCallee;
    call: Parser.SyntaxNode;
    line: number;
    blockId: number | null;
    containingStmt: Parser.SyntaxNode | null;
    awaitNode: Parser.SyntaxNode | null;
    cacheOption: string | null;
  };
  const raws: RawCall[] = [];

  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function") ?? call.namedChild(0);
    if (!fn || fn.type !== "identifier") continue;
    const name = fn.text;
    if (
      name !== "fetch" &&
      name !== "cookies" &&
      name !== "headers" &&
      name !== "unstable_noStore"
    ) {
      continue;
    }

    const args = call.childForFieldName("arguments") ?? call.namedChild(1);
    let cacheOption: string | null = null;
    if (name === "fetch" && args) {
      const argChildren = args.namedChildren;
      if (argChildren.length >= 2) {
        cacheOption = parseCacheOption(argChildren[1] ?? null);
      }
    }

    // Find the enclosing top-level statement (a direct child of the block)
    let containingStmt: Parser.SyntaxNode | null = null;
    const blockId = enclosingBlockId(call);
    if (blockId !== null) {
      let p: Parser.SyntaxNode | null = call;
      while (p && p.parent && p.parent.type !== "statement_block") {
        p = p.parent;
      }
      containingStmt = p;
    }

    raws.push({
      callee: name as FetchCallee,
      call,
      line: call.startPosition.row + 1,
      blockId,
      containingStmt,
      awaitNode: enclosingAwait(call),
      cacheOption,
    });
  }

  // Pass 2: compute isSequential per raw call
  for (let i = 0; i < raws.length; i++) {
    const cur = raws[i]!;
    let isSequential = false;

    if (cur.awaitNode && cur.blockId !== null && cur.containingStmt) {
      // Find any earlier raw in same block, earlier position, also awaited
      for (let j = 0; j < i; j++) {
        const prev = raws[j]!;
        if (prev.blockId !== cur.blockId) continue;
        if (!prev.awaitNode || !prev.containingStmt) continue;
        if (prev.containingStmt.endIndex >= cur.containingStmt.startIndex) continue;

        // Dependent check: do cur's argument refs overlap prev's bound identifiers?
        const prevBindings = identifiersBoundByStatement(prev.containingStmt);
        if (prevBindings.size > 0) {
          const curArgs = cur.call.childForFieldName("arguments") ?? cur.call.namedChild(1);
          if (curArgs) {
            const refs = collectIdentifierRefs(curArgs);
            let shared = false;
            for (const r of refs) {
              if (prevBindings.has(r)) {
                shared = true;
                break;
              }
            }
            if (shared) continue; // dependent → not sequential
          }
        }
        isSequential = true;
        break;
      }
    }

    if (optOutLines.has(cur.line)) isSequential = false;

    const isSsrTrigger =
      cur.callee === "cookies" ||
      cur.callee === "headers" ||
      cur.callee === "unstable_noStore" ||
      (cur.callee === "fetch" && cur.cacheOption === "no-store");

    out.push({
      callee: cur.callee,
      line: cur.line,
      cacheOption: cur.cacheOption,
      isSequential,
      isSsrTrigger,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Zod schema extraction (T2, T3 helper)
// ---------------------------------------------------------------------------

/** Allowed top-level Zod field methods. */
const ZOD_FIELD_METHODS = new Set([
  "object",
  "string",
  "number",
  "boolean",
  "array",
  "union",
  "enum",
  "literal",
  "optional",
  "nullable",
  "record",
  "tuple",
  "discriminatedUnion",
  "date",
  "any",
  "unknown",
  "bigint",
  "void",
  "never",
  "null",
  "undefined",
]);

/** Allowed chained refinement methods (non-structural). */
const ZOD_CHAIN_METHODS = new Set([
  "extend",
  "merge",
  "omit",
  "pick",
  "strict",
  "refine",
  "superRefine",
  "transform",
  "brand",
  "describe",
  "default",
  "catch",
  "readonly",
  "optional",
  "nullable",
  "nullish",
]);

/** Per-type constraint methods that we record (not exhaustive — tracks common cases). */
const ZOD_CONSTRAINT_METHODS = new Set([
  "int",
  "min",
  "max",
  "length",
  "email",
  "url",
  "uuid",
  "regex",
  "startsWith",
  "endsWith",
  "positive",
  "negative",
  "nonnegative",
  "nonpositive",
  "gt",
  "gte",
  "lt",
  "lte",
  "multipleOf",
  "finite",
  "safe",
  "trim",
  "toLowerCase",
  "toUpperCase",
]);

export interface ZodFieldType {
  type: string;
  constraints?: string[];
  nested?: Record<string, ZodFieldType>;
  optional?: boolean;
  nullable?: boolean;
}

export interface ZodShape {
  fields: Record<string, ZodFieldType>;
  partial: boolean;
}

/**
 * Unwrap a call expression like `z.object({...}).strict().refine(...)` down to
 * the root z.<method>(...) invocation. Returns the underlying call node, the
 * captured field method, and any collected chain modifiers.
 */
function unwrapZodChain(
  call: Parser.SyntaxNode,
): { rootCall: Parser.SyntaxNode; rootMethod: string; chain: string[]; partial: boolean } | null {
  const chain: string[] = [];
  let partial = false;
  let cur: Parser.SyntaxNode = call;

  while (cur.type === "call_expression") {
    const fn = cur.childForFieldName("function") ?? cur.namedChild(0);
    if (!fn) return null;

    // z.<method>(...) — base case
    if (fn.type === "member_expression") {
      const obj = fn.childForFieldName("object") ?? fn.namedChild(0);
      const prop = fn.childForFieldName("property") ?? fn.namedChild(1);

      if (obj?.type === "identifier" && (obj.text === "z" || obj.text === "zod")) {
        if (prop?.type !== "property_identifier") return null;
        const method = prop.text;
        if (!ZOD_FIELD_METHODS.has(method)) return null;
        return { rootCall: cur, rootMethod: method, chain, partial };
      }

      // Chained: <inner>.<chainMethod>(...)
      if (prop?.type === "property_identifier") {
        const method = prop.text;
        if (ZOD_CHAIN_METHODS.has(method)) {
          chain.unshift(method);
          if (method === "extend" || method === "merge") partial = true;
          if (!obj) return null;
          if (obj.type === "call_expression") {
            cur = obj;
            continue;
          }
          // Identifier base (e.g. `BaseSchema.extend(...)`)
          return null;
        }
        if (ZOD_CONSTRAINT_METHODS.has(method)) {
          chain.unshift(method);
          if (!obj) return null;
          if (obj.type === "call_expression") {
            cur = obj;
            continue;
          }
          return null;
        }
        // Unknown chain method on unknown base
        return null;
      }
    }

    // Not a Zod chain
    return null;
  }

  return null;
}

/** Recursively parse a single field call like `z.string()` into a ZodFieldType. */
function parseZodField(call: Parser.SyntaxNode): ZodFieldType | null {
  const unwrapped = unwrapZodChain(call);
  if (!unwrapped) return null;
  const { rootCall, rootMethod, chain } = unwrapped;

  const field: ZodFieldType = { type: rootMethod };
  const constraints = chain.filter((c) => ZOD_CONSTRAINT_METHODS.has(c));
  if (constraints.length > 0) field.constraints = constraints;
  if (chain.includes("optional")) field.optional = true;
  if (chain.includes("nullable") || chain.includes("nullish")) field.nullable = true;

  if (rootMethod === "object") {
    const args = rootCall.childForFieldName("arguments") ?? rootCall.namedChild(1);
    if (args) {
      const objArg = args.namedChildren.find((c) => c.type === "object");
      if (objArg) {
        const nested = parseZodObjectArg(objArg);
        if (nested) field.nested = nested;
      }
    }
  }

  return field;
}

/** Walk an `{ key: z.<method>(), ... }` object literal into a fields map. */
function parseZodObjectArg(objNode: Parser.SyntaxNode): Record<string, ZodFieldType> | null {
  if (objNode.type !== "object") return null;
  const out: Record<string, ZodFieldType> = {};
  for (const pair of objNode.namedChildren) {
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
    if (!value || value.type !== "call_expression") continue;
    const field = parseZodField(value);
    if (field) out[keyText] = field;
  }
  return out;
}

/**
 * Extract the shape of a top-level Zod schema from a source tree.
 *
 * Walks `variable_declarator` nodes and tries each one's initializer. Returns
 * the first successfully parsed Zod schema, or `null` when no z.object(...) is
 * found. Other validation libraries (Yup, Joi, etc.) intentionally return null
 * — downstream tools wrap this and add `schema_lib: "unknown"` at their own
 * aggregation level.
 */
export function extractZodSchema(tree: Parser.Tree, _source: string): ZodShape | null {
  const root = tree.rootNode;

  for (const decl of root.descendantsOfType("variable_declarator")) {
    const value = decl.childForFieldName("value");
    if (!value || value.type !== "call_expression") continue;
    const unwrapped = unwrapZodChain(value);
    if (!unwrapped) continue;
    if (unwrapped.rootMethod !== "object") continue;

    const args = unwrapped.rootCall.childForFieldName("arguments") ?? unwrapped.rootCall.namedChild(1);
    if (!args) continue;
    const objArg = args.namedChildren.find((c) => c.type === "object");
    if (!objArg) continue;
    const fields = parseZodObjectArg(objArg);
    if (!fields) continue;

    return { fields, partial: unwrapped.partial };
  }

  return null;
}
