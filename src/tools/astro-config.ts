/**
 * Astro config analysis tool.
 *
 * Parses `astro.config.{mjs,ts,cjs}` using tree-sitter-javascript AST walker
 * to extract project conventions (output mode, adapter, integrations, i18n, etc.).
 *
 * Exports:
 * - `extractAstroConventions(files, projectRoot)` — consumed by analyzeProject
 * - `astroConfigAnalyze(args)` — MCP tool handler
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { getParser, initParser } from "../parser/parser-manager.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AstroConventions {
  output_mode: "static" | "server" | "hybrid" | null;
  adapter: string | null;
  integrations: string[];
  site: string | null;
  base: string | null;
  i18n: { default_locale: string; locales: string[] } | null;
  redirects: Record<string, string>;
  config_resolution: "static" | "partial" | "dynamic";
  config_file: string | null;
}

export interface AstroConfigResult {
  conventions: AstroConventions;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG_CANDIDATES = ["astro.config.mjs", "astro.config.ts", "astro.config.cjs"];

function dynamicResult(configFile: string | null, issue: string): AstroConfigResult {
  return {
    conventions: {
      output_mode: null, adapter: null, integrations: [], site: null,
      base: null, i18n: null, redirects: {}, config_resolution: "dynamic", config_file: configFile,
    },
    issues: [issue],
  };
}

async function findConfigFile(root: string, files?: string[]): Promise<string | null> {
  for (const name of CONFIG_CANDIDATES) {
    const full = join(root, name);
    if (files) {
      if (files.includes(name) || files.includes(full)) return full;
    } else {
      try { await readFile(full, "utf-8"); return full; } catch { /* next */ }
    }
  }
  return null;
}

function stripQuotes(s: string): string {
  return (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] ? s.slice(1, -1) : s;
}

function isLiteral(n: Parser.SyntaxNode): boolean {
  return n.type === "string" || n.type === "number" || n.type === "true"
    || n.type === "false" || n.type === "null" || n.type === "undefined";
}

function getProperty(obj: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const k = p.childForFieldName("key");
    if (k?.text === name) return p.childForFieldName("value") ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------

/** Build import specifier -> module source map from top-level imports. */
function buildImportMap(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const child of root.namedChildren) {
    if (child.type !== "import_statement") continue;
    const src = child.childForFieldName("source");
    if (!src) continue;
    const mod = stripQuotes(src.text);

    // Default import: import vercel from "@astrojs/vercel"
    const def = child.namedChildren.find((n) => n.type === "identifier");
    if (def) map.set(def.text, mod);

    // import { x } from "y" — import_clause wrapper
    const clause = child.namedChildren.find((n) => n.type === "import_clause");
    if (clause) {
      const id = clause.namedChildren.find((n) => n.type === "identifier");
      if (id) map.set(id.text, mod);
      const named = clause.namedChildren.find((n) => n.type === "named_imports");
      if (named) {
        for (const spec of named.namedChildren) {
          const nm = spec.childForFieldName("alias") ?? spec.childForFieldName("name") ?? spec.namedChildren[0];
          if (nm) map.set(nm.text, mod);
        }
      }
    }
  }
  return map;
}

/** Find the object literal passed to `defineConfig(...)`. */
function findConfigObject(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of root.namedChildren) {
    if (child.type !== "export_statement") continue;
    const call = child.namedChildren.find((n) => n.type === "call_expression");
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.text !== "defineConfig") continue;
    const args = call.childForFieldName("arguments");
    return args?.namedChildren.find((n) => n.type === "object") ?? null;
  }
  return null;
}

/** Extract config properties from the defineConfig object. */
function extractFromAST(
  root: Parser.SyntaxNode,
  importMap: Map<string, string>,
): { conv: Partial<AstroConventions>; nonLiteralCount: number } {
  const obj = findConfigObject(root);
  if (!obj) return { conv: {}, nonLiteralCount: 0 };

  let nlc = 0; // non-literal counter
  const conv: Partial<AstroConventions> = {};

  // --- Simple string fields ---
  for (const field of ["output", "site", "base"] as const) {
    const node = getProperty(obj, field);
    if (!node) continue;
    const key = field === "output" ? "output_mode" : field;
    if (isLiteral(node)) {
      const val = stripQuotes(node.text);
      (conv as Record<string, unknown>)[key] = field === "output"
        ? (val === "static" || val === "server" || val === "hybrid" ? val : null)
        : val;
    } else { (conv as Record<string, unknown>)[key] = null; nlc++; }
  }

  // --- Adapter (call expression resolved via imports) ---
  const adN = getProperty(obj, "adapter");
  if (adN) {
    if (adN.type === "call_expression") {
      const fn = adN.childForFieldName("function");
      if (fn) conv.adapter = importMap.get(fn.text) ?? fn.text;
    } else if (isLiteral(adN)) { conv.adapter = stripQuotes(adN.text); }
    else { conv.adapter = null; nlc++; }
  }

  // --- Integrations (array of call expressions) ---
  const intN = getProperty(obj, "integrations");
  if (intN) {
    if (intN.type === "array") {
      conv.integrations = intN.namedChildren.flatMap((el) => {
        if (el.type === "call_expression") {
          const fn = el.childForFieldName("function");
          return fn ? [importMap.get(fn.text) ?? fn.text] : [];
        }
        return isLiteral(el) ? [stripQuotes(el.text)] : [];
      });
    } else { conv.integrations = []; nlc++; }
  }

  // --- i18n ---
  const i18n = getProperty(obj, "i18n");
  if (i18n) {
    if (i18n.type === "object") {
      const dlN = getProperty(i18n, "defaultLocale");
      const lN = getProperty(i18n, "locales");
      const dl = dlN && isLiteral(dlN) ? stripQuotes(dlN.text) : null;
      const locales = lN?.type === "array"
        ? lN.namedChildren.filter(isLiteral).map((e) => stripQuotes(e.text))
        : [];
      if (dl) conv.i18n = { default_locale: dl, locales };
      else nlc++;
    } else nlc++;
  }

  // --- Redirects ---
  const redN = getProperty(obj, "redirects");
  if (redN) {
    if (redN.type === "object") {
      const r: Record<string, string> = {};
      for (const p of redN.namedChildren) {
        if (p.type !== "pair") continue;
        const k = p.childForFieldName("key"), v = p.childForFieldName("value");
        if (k && v && isLiteral(v)) r[stripQuotes(k.text)] = stripQuotes(v.text);
      }
      conv.redirects = r;
    } else nlc++;
  }

  return { conv, nonLiteralCount: nlc };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractAstroConventions(
  files: string[],
  projectRoot: string,
): Promise<AstroConfigResult> {
  const configPath = await findConfigFile(projectRoot, files.length > 0 ? files : undefined);
  if (!configPath) return dynamicResult(null, "No astro.config.{mjs,ts,cjs} found");

  let source: string;
  try { source = await readFile(configPath, "utf-8"); } catch {
    return dynamicResult(configPath, "Failed to read config file");
  }

  await initParser();
  const parser = await getParser("javascript");
  if (!parser) return dynamicResult(configPath, "JavaScript parser unavailable");

  let tree: Parser.Tree;
  try { tree = parser.parse(source); } catch {
    return dynamicResult(configPath, "AST parse error");
  }

  const importMap = buildImportMap(tree.rootNode);
  const { conv, nonLiteralCount } = extractFromAST(tree.rootNode, importMap);

  const issues: string[] = [];
  if (conv.site === undefined) issues.push("Missing site URL in config");

  const configFile = configPath.startsWith(projectRoot)
    ? configPath.slice(projectRoot.length + 1)
    : configPath;

  return {
    conventions: {
      output_mode: conv.output_mode ?? null,
      adapter: conv.adapter ?? null,
      integrations: conv.integrations ?? [],
      site: conv.site ?? null,
      base: conv.base ?? null,
      i18n: conv.i18n ?? null,
      redirects: conv.redirects ?? {},
      config_resolution: nonLiteralCount === 0 ? "static" : "partial",
      config_file: configFile,
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// MCP tool handler
// ---------------------------------------------------------------------------

export async function astroConfigAnalyze(args: {
  project_root: string;
}): Promise<AstroConfigResult> {
  return extractAstroConventions([], args.project_root);
}
