/**
 * Astro content collections analysis tool.
 *
 * Parses `src/content.config.ts` (or legacy `src/content/config.ts`) via the
 * tree-sitter-javascript AST walker and extracts:
 *   - Each `defineCollection(...)` entry (loader, schema fields)
 *   - Zod schema fields with their types + required flag
 *   - `reference("other")` edges to build a collection reference graph
 *   - Glob-resolved entries per loader pattern (default `src/content/<name>/`)
 *   - Frontmatter validation against required fields
 *
 * Exports `astroContentCollections(args)` as the MCP handler.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, dirname, resolve, isAbsolute } from "node:path";
import type Parser from "web-tree-sitter";
import { getParser, initParser } from "../parser/parser-manager.js";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CollectionSchemaField {
  name: string;
  type: string;
  required: boolean;
  references?: string;
}

export interface CollectionInfo {
  name: string;
  loader: "glob" | "file" | "custom" | "unknown";
  loader_pattern?: string;
  schema_fields: CollectionSchemaField[];
  entry_count: number;
  referenced_by: string[];
  references: string[];
}

export interface ContentValidationIssue {
  collection: string;
  file: string;
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ContentCollectionsResult {
  config_file: string | null;
  config_version: "v5+" | "legacy" | "not-found";
  collections: CollectionInfo[];
  reference_graph: Record<string, { field: string; cardinality: "one-to-one" | "many-to-one" }>;
  orphaned_files: string[];
  validation_issues: ContentValidationIssue[];
  summary: {
    total_collections: number;
    total_entries: number;
    collections_with_issues: number;
  };
}

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

interface DiscoveredConfig {
  abs_path: string;
  rel_path: string;
  version: "v5+" | "legacy";
}

const V5_CANDIDATES = ["src/content.config.ts", "src/content.config.mjs", "src/content.config.js"];
const LEGACY_CANDIDATES = ["src/content/config.ts", "src/content/config.mjs", "src/content/config.js"];

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function findConfig(root: string): Promise<DiscoveredConfig | null> {
  for (const rel of V5_CANDIDATES) {
    const abs = join(root, rel);
    if ((await tryRead(abs)) != null) return { abs_path: abs, rel_path: rel, version: "v5+" };
  }
  for (const rel of LEGACY_CANDIDATES) {
    const abs = join(root, rel);
    if ((await tryRead(abs)) != null) return { abs_path: abs, rel_path: rel, version: "legacy" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// AST helpers (shared shape with astro-config.ts)
// ---------------------------------------------------------------------------

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'" || first === "`") && first === last) return s.slice(1, -1);
  return s;
}

function getProperty(obj: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const k = p.childForFieldName("key");
    if (!k) continue;
    const keyText = k.type === "string" ? stripQuotes(k.text) : k.text;
    if (keyText === name) return p.childForFieldName("value") ?? null;
  }
  return null;
}

function isLiteral(n: Parser.SyntaxNode): boolean {
  return n.type === "string" || n.type === "number" || n.type === "true"
    || n.type === "false" || n.type === "null" || n.type === "undefined";
}

/** Find innermost callee of a chained call expression.
 *  Example: z.string().optional() → returns the `z.string()` call.             */
function innermostCall(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current = node;
  while (current.type === "call_expression") {
    const fn = current.childForFieldName("function");
    if (!fn) break;
    // member_expression like `z.string().optional` — the `.optional` call's
    // inner function is a member_expression whose object is another call.
    if (fn.type === "member_expression") {
      const obj = fn.childForFieldName("object");
      if (obj && obj.type === "call_expression") {
        current = obj;
        continue;
      }
    }
    break;
  }
  return current;
}

/** Walks a method chain and returns the ordered list of method names.
 *  Example: z.string().min(1).optional() → ["string", "min", "optional"]      */
function methodChain(node: Parser.SyntaxNode): string[] {
  const chain: string[] = [];
  let current: Parser.SyntaxNode | null = node;
  while (current && current.type === "call_expression") {
    const fn = current.childForFieldName("function");
    if (!fn) break;
    if (fn.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      const obj = fn.childForFieldName("object");
      if (prop) chain.unshift(prop.text);
      if (obj && obj.type === "call_expression") {
        current = obj;
        continue;
      }
      // z.string() — object is an identifier, call done
      if (obj && obj.type === "identifier" && chain.length > 0) break;
      break;
    }
    if (fn.type === "identifier") {
      chain.unshift(fn.text);
      break;
    }
    break;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Loader extraction
// ---------------------------------------------------------------------------

interface LoaderInfo {
  kind: "glob" | "file" | "custom" | "unknown";
  pattern?: string;
  base?: string;
}

function extractLoader(
  loaderNode: Parser.SyntaxNode | null,
  configType: string | null,
): LoaderInfo {
  // Legacy v4 shape: type: "content" | "data" (no explicit loader)
  if (!loaderNode) {
    return configType ? { kind: "glob" } : { kind: "unknown" };
  }

  if (loaderNode.type !== "call_expression") return { kind: "custom" };

  const fn = loaderNode.childForFieldName("function");
  const fnName = fn?.text ?? "";

  // glob({ pattern, base }) or file("path")
  if (fnName === "glob") {
    const args = loaderNode.childForFieldName("arguments");
    const obj = args?.namedChildren.find((n) => n.type === "object");
    if (obj) {
      const patternNode = getProperty(obj, "pattern");
      const baseNode = getProperty(obj, "base");
      const info: LoaderInfo = { kind: "glob" };
      if (patternNode && isLiteral(patternNode)) info.pattern = stripQuotes(patternNode.text);
      if (baseNode && isLiteral(baseNode)) info.base = stripQuotes(baseNode.text);
      return info;
    }
    return { kind: "glob" };
  }
  if (fnName === "file") {
    const args = loaderNode.childForFieldName("arguments");
    const first = args?.namedChildren.find((n) => isLiteral(n));
    const info: LoaderInfo = { kind: "file" };
    if (first) info.pattern = stripQuotes(first.text);
    return info;
  }
  return { kind: "custom" };
}

// ---------------------------------------------------------------------------
// Schema extraction
// ---------------------------------------------------------------------------

interface ParsedField {
  name: string;
  type: string;
  required: boolean;
  references?: string;
}

function classifyZodField(valueNode: Parser.SyntaxNode): {
  type: string;
  required: boolean;
  references?: string;
} {
  // Walk the entire chain (outermost first). `.optional()` / `.nullish()` / `.nullable()` on
  // the outside means required=false.
  let required = true;
  let cursor: Parser.SyntaxNode | null = valueNode;
  while (cursor && cursor.type === "call_expression") {
    const fn = cursor.childForFieldName("function");
    if (!fn) break;
    if (fn.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      if (prop && (prop.text === "optional" || prop.text === "nullish" || prop.text === "nullable" || prop.text === "default")) {
        required = false;
      }
      const obj = fn.childForFieldName("object");
      if (obj && obj.type === "call_expression") {
        cursor = obj;
        continue;
      }
      cursor = obj;
      break;
    }
    // e.g. reference("authors") as the outermost call
    if (fn.type === "identifier") break;
    break;
  }

  // The innermost/base call tells us the type.
  const base = innermostCall(valueNode);
  if (base.type !== "call_expression") return { type: "unknown", required };

  const baseFn = base.childForFieldName("function");
  if (!baseFn) return { type: "unknown", required };

  // reference("collectionName")
  if (baseFn.type === "identifier" && baseFn.text === "reference") {
    const args = base.childForFieldName("arguments");
    const first = args?.namedChildren.find((n) => isLiteral(n));
    const ref = first ? stripQuotes(first.text) : undefined;
    const out: { type: string; required: boolean; references?: string } = {
      type: "reference",
      required,
    };
    if (ref) out.references = ref;
    return out;
  }

  // z.<kind>() style: member_expression(object=z, property=<kind>)
  if (baseFn.type === "member_expression") {
    const prop = baseFn.childForFieldName("property");
    if (prop) {
      return { type: prop.text, required };
    }
  }

  // Fallback: try the innermost chain head
  const chain = methodChain(valueNode);
  if (chain.length > 0) return { type: chain[0]!, required };
  return { type: "unknown", required };
}

function extractSchemaFields(schemaNode: Parser.SyntaxNode): ParsedField[] {
  // Expect z.object({ ... }) — walk to the first z.object(...) we find.
  let target: Parser.SyntaxNode | null = null;
  const stack: Parser.SyntaxNode[] = [schemaNode];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "member_expression") {
        const prop = fn.childForFieldName("property");
        if (prop?.text === "object") {
          target = node;
          break;
        }
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  if (!target) return [];

  const args = target.childForFieldName("arguments");
  const obj = args?.namedChildren.find((n) => n.type === "object");
  if (!obj) return [];

  const fields: ParsedField[] = [];
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const keyNode = pair.childForFieldName("key");
    const valueNode = pair.childForFieldName("value");
    if (!keyNode || !valueNode) continue;
    const name = keyNode.type === "string" ? stripQuotes(keyNode.text) : keyNode.text;
    const classified = classifyZodField(valueNode);
    const field: ParsedField = {
      name,
      type: classified.type,
      required: classified.required,
    };
    if (classified.references) field.references = classified.references;
    fields.push(field);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Collection discovery from AST
// ---------------------------------------------------------------------------

interface RawCollection {
  name: string;
  loader: LoaderInfo;
  fields: ParsedField[];
}

/** Locate the object literal argument passed to a `defineCollection(...)` call. */
function defineCollectionObject(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const fn = call.childForFieldName("function");
  if (fn?.text !== "defineCollection") return null;
  const args = call.childForFieldName("arguments");
  return args?.namedChildren.find((n) => n.type === "object") ?? null;
}

function extractRawCollection(
  name: string,
  defineObj: Parser.SyntaxNode,
): RawCollection {
  const loaderNode = getProperty(defineObj, "loader");
  const typeNode = getProperty(defineObj, "type");
  const schemaNode = getProperty(defineObj, "schema");
  const configType = typeNode && isLiteral(typeNode) ? stripQuotes(typeNode.text) : null;
  const loader = extractLoader(loaderNode, configType);
  const fields = schemaNode ? extractSchemaFields(schemaNode) : [];
  return { name, loader, fields };
}

/** Build `const <name> = defineCollection({...})` map and resolve the `collections` export. */
function discoverCollections(root: Parser.SyntaxNode): RawCollection[] {
  // Map of local const name → defineCollection object literal
  const localDefines = new Map<string, Parser.SyntaxNode>();
  const collected: RawCollection[] = [];

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        const valueNode = decl.childForFieldName("value");
        if (!nameNode || !valueNode) continue;
        if (valueNode.type === "call_expression") {
          const obj = defineCollectionObject(valueNode);
          if (obj) localDefines.set(nameNode.text, obj);
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);

  // Walk top-level export_statements looking for `export const collections = {...}`
  // or direct `export const <name> = defineCollection(...)`.
  for (const child of root.namedChildren) {
    if (child.type !== "export_statement") continue;

    // export const collections = { blog, authors }
    const lex = child.namedChildren.find((n) => n.type === "lexical_declaration" || n.type === "variable_declaration");
    if (lex) {
      for (const decl of lex.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        const valueNode = decl.childForFieldName("value");
        if (!nameNode || !valueNode) continue;

        // Inline defineCollection
        if (valueNode.type === "call_expression") {
          const obj = defineCollectionObject(valueNode);
          if (obj) localDefines.set(nameNode.text, obj);
        }

        // export const collections = { a, b: aliased, c: defineCollection(...) }
        if (nameNode.text === "collections" && valueNode.type === "object") {
          for (const pair of valueNode.namedChildren) {
            if (pair.type === "shorthand_property_identifier") {
              const defObj = localDefines.get(pair.text);
              if (defObj) collected.push(extractRawCollection(pair.text, defObj));
              continue;
            }
            if (pair.type !== "pair") continue;
            const keyNode = pair.childForFieldName("key");
            const valNode = pair.childForFieldName("value");
            if (!keyNode || !valNode) continue;
            const name = keyNode.type === "string" ? stripQuotes(keyNode.text) : keyNode.text;
            if (valNode.type === "identifier") {
              const defObj = localDefines.get(valNode.text);
              if (defObj) collected.push(extractRawCollection(name, defObj));
            } else if (valNode.type === "call_expression") {
              const defObj = defineCollectionObject(valNode);
              if (defObj) collected.push(extractRawCollection(name, defObj));
            }
          }
        }
      }
    }
  }

  // Fallback: no `export const collections = {}` present → surface all local defines.
  if (collected.length === 0 && localDefines.size > 0) {
    for (const [name, obj] of localDefines) {
      collected.push(extractRawCollection(name, obj));
    }
  }

  return collected;
}

// ---------------------------------------------------------------------------
// Entry file discovery + validation
// ---------------------------------------------------------------------------

const FRONTMATTER_EXTENSIONS = new Set([".md", ".mdx", ".mdoc", ".markdown"]);
const DATA_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function extFromPath(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx) : "";
}

/** Resolve the filesystem directory where this collection's entries live.
 *
 *  Astro resolves `glob({ base })` / `file("path")` relative to the project root
 *  (cwd when running `astro dev`), not the config file's directory. We mirror
 *  that here and fall back to the default `src/content/<name>/` convention. */
function resolveLoaderBase(
  projectRoot: string,
  _configDir: string,
  collectionName: string,
  loader: LoaderInfo,
): string {
  if (loader.base) {
    return isAbsolute(loader.base)
      ? loader.base
      : resolve(projectRoot, loader.base);
  }
  if (loader.kind === "file" && loader.pattern) {
    return resolve(projectRoot, dirname(loader.pattern));
  }
  return join(projectRoot, "src", "content", collectionName);
}

/** Parse simple YAML frontmatter (key: value) into an object. Best-effort only. */
function parseFrontmatter(source: string): Record<string, unknown> | null {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const body = match[1]!;
  const out: Record<string, unknown> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // Skip nested mapping continuations (lines starting with whitespace)
    if (/^\s/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    let value: unknown = kv[2]!.trim();
    if (typeof value === "string") {
      if (value === "") value = "";
      else if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (value === "null" || value === "~") value = null;
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
      else if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter((s) => s.length > 0);
      } else {
        value = (value as string).replace(/^["']|["']$/g, "");
      }
    }
    out[key] = value;
  }
  return out;
}

async function parseJsonEntry(absPath: string): Promise<Record<string, unknown> | null> {
  const raw = await tryRead(absPath);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function emptyResult(configFile: string | null, version: "not-found"): ContentCollectionsResult {
  return {
    config_file: configFile,
    config_version: version,
    collections: [],
    reference_graph: {},
    orphaned_files: [],
    validation_issues: [],
    summary: { total_collections: 0, total_entries: 0, collections_with_issues: 0 },
  };
}

export async function astroContentCollections(args: {
  repo?: string;
  project_root?: string;
  validate_entries?: boolean;
}): Promise<ContentCollectionsResult> {
  const validateEntries = args.validate_entries ?? true;

  // Resolve the project root. Prefer explicit `project_root` (handy for tests),
  // otherwise fall back to the indexed repo.
  let projectRoot: string | null = args.project_root ?? null;
  if (!projectRoot) {
    const index = await getCodeIndex(args.repo ?? "");
    if (index) projectRoot = index.root;
  }
  if (!projectRoot) return emptyResult(null, "not-found");

  const discovered = await findConfig(projectRoot);
  if (!discovered) return emptyResult(null, "not-found");

  const source = await tryRead(discovered.abs_path);
  if (source == null) return emptyResult(discovered.rel_path, "not-found");

  await initParser();
  const parser = await getParser("javascript");
  if (!parser) return emptyResult(discovered.rel_path, "not-found");

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    return {
      config_file: discovered.rel_path,
      config_version: discovered.version,
      collections: [],
      reference_graph: {},
      orphaned_files: [],
      validation_issues: [],
      summary: { total_collections: 0, total_entries: 0, collections_with_issues: 0 },
    };
  }

  const rawCollections = discoverCollections(tree.rootNode);
  const configDir = dirname(discovered.abs_path);

  // Build reference graph, outgoing refs per collection.
  const referenceGraph: Record<string, { field: string; cardinality: "one-to-one" | "many-to-one" }> = {};
  const outgoingRefs = new Map<string, Set<string>>();
  for (const rc of rawCollections) {
    const outs = new Set<string>();
    for (const field of rc.fields) {
      if (field.references) {
        outs.add(field.references);
        referenceGraph[`${rc.name}.${field.name}`] = {
          field: field.name,
          cardinality: field.type === "array" ? "many-to-one" : "one-to-one",
        };
      }
    }
    outgoingRefs.set(rc.name, outs);
  }

  const incoming = new Map<string, string[]>();
  for (const [src, outs] of outgoingRefs) {
    for (const dst of outs) {
      const arr = incoming.get(dst) ?? [];
      arr.push(src);
      incoming.set(dst, arr);
    }
  }

  // Enumerate entries per collection.
  const collections: CollectionInfo[] = [];
  const validationIssues: ContentValidationIssue[] = [];
  const orphanedFiles: string[] = [];
  let totalEntries = 0;

  for (const rc of rawCollections) {
    const baseDir = resolveLoaderBase(projectRoot, configDir, rc.name, rc.loader);
    const entryFiles: string[] = [];
    await walkFiles(baseDir, entryFiles);

    // Filter entries based on loader kind.
    const contentLikeExts = new Set([...FRONTMATTER_EXTENSIONS, ...DATA_EXTENSIONS]);
    const scopedFiles = entryFiles.filter((f) => contentLikeExts.has(extFromPath(f)));

    if (validateEntries && rc.fields.length > 0) {
      const requiredFields = rc.fields.filter((f) => f.required);
      for (const file of scopedFiles) {
        const ext = extFromPath(file);
        let data: Record<string, unknown> | null = null;
        if (FRONTMATTER_EXTENSIONS.has(ext)) {
          const src = await tryRead(file);
          if (src == null) continue;
          data = parseFrontmatter(src);
          if (data == null) {
            orphanedFiles.push(relative(projectRoot, file));
            continue;
          }
        } else if (ext === ".json") {
          data = await parseJsonEntry(file);
          if (data == null) continue;
        } else {
          // .yaml/.yml — not parsed here; skip validation.
          continue;
        }

        for (const field of requiredFields) {
          if (!(field.name in data)) {
            validationIssues.push({
              collection: rc.name,
              file: relative(projectRoot, file),
              field: field.name,
              message: `Missing required field '${field.name}' (${field.type})`,
              severity: "error",
            });
          }
        }
      }
    }

    const info: CollectionInfo = {
      name: rc.name,
      loader: rc.loader.kind,
      schema_fields: rc.fields.map((f) => {
        const out: CollectionSchemaField = {
          name: f.name,
          type: f.type,
          required: f.required,
        };
        if (f.references) out.references = f.references;
        return out;
      }),
      entry_count: scopedFiles.length,
      referenced_by: incoming.get(rc.name) ?? [],
      references: [...(outgoingRefs.get(rc.name) ?? [])],
    };
    if (rc.loader.pattern) info.loader_pattern = rc.loader.pattern;
    collections.push(info);
    totalEntries += scopedFiles.length;
  }

  const collectionsWithIssues = new Set(validationIssues.map((i) => i.collection)).size;

  return {
    config_file: discovered.rel_path,
    config_version: discovered.version,
    collections,
    reference_graph: referenceGraph,
    orphaned_files: orphanedFiles,
    validation_issues: validationIssues,
    summary: {
      total_collections: collections.length,
      total_entries: totalEntries,
      collections_with_issues: collectionsWithIssues,
    },
  };
}
