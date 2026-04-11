/**
 * HonoExtractor — AST-based extractor for Hono framework applications.
 *
 * Parses a Hono entry file using tree-sitter TypeScript grammar and produces
 * a HonoAppModel that describes routes, middleware, context flow, OpenAPI
 * schemas, and RPC exports.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md
 * Plan: docs/specs/2026-04-10-hono-framework-intelligence-plan.md (Task 2-3)
 */

import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type Parser from "web-tree-sitter";
import { getParser } from "../parser-manager.js";
import type {
  HonoApp,
  HonoAppModel,
  HonoHandler,
  HonoMethod,
  HonoMount,
  HonoRoute,
} from "./hono-model.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "delete", "patch", "options", "all", "on",
]);

/** Cached child model for memoized sub-app parsing (same file, different prefix). */
interface ChildParseResult {
  app_variables: Record<string, HonoApp>;
  routes: HonoRoute[];
  mounts: HonoMount[];
  files_used: string[];
}

export class HonoExtractor {
  async parse(entryFile: string): Promise<HonoAppModel> {
    const absoluteEntry = canonicalize(path.resolve(entryFile));
    const model = emptyModel(absoluteEntry, {
      middleware_not_extracted: 1,
      context_flow_not_extracted: 1,
      openapi_not_extracted: 1,
    });
    const parsedCache = new Map<string, ChildParseResult>();
    await this.parseFile(absoluteEntry, "", new Set(), parsedCache, model);
    return model;
  }

  /**
   * Parse a single file and merge results into the model.
   * @param file Absolute canonicalized path
   * @param prefix Path prefix to apply to all routes (from parent app.route())
   * @param inFlight In-flight stack for cycle detection (pushed/popped per call)
   * @param parsedCache Memoized child models keyed by canonical path
   * @param model Accumulated model being built
   */
  private async parseFile(
    file: string,
    prefix: string,
    inFlight: Set<string>,
    parsedCache: Map<string, ChildParseResult>,
    model: HonoAppModel,
  ): Promise<void> {
    // Cycle detection: break if this file is already being parsed up the call stack
    if (inFlight.has(file)) return;

    // Record file as used
    if (!model.files_used.includes(file)) {
      model.files_used.push(file);
    }

    // Check memoization cache for previously parsed child
    const cached = parsedCache.get(file);
    if (cached) {
      // Re-use parsed routes with fresh prefix
      for (const route of cached.routes) {
        model.routes.push({
          ...route,
          path: joinPaths(prefix, route.raw_path),
        });
      }
      return;
    }

    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      model.skip_reasons.file_read_failed =
        (model.skip_reasons.file_read_failed ?? 0) + 1;
      return;
    }

    const language = pickLanguage(file);
    const parser = await getParser(language);
    if (!parser) {
      model.skip_reasons.parser_unavailable =
        (model.skip_reasons.parser_unavailable ?? 0) + 1;
      return;
    }

    const tree = parser.parse(source);
    if (!tree) {
      model.skip_reasons.parse_failed =
        (model.skip_reasons.parse_failed ?? 0) + 1;
      return;
    }

    try {
      // Track local data
      const localAppVars: Record<string, HonoApp> = {};
      const localRoutes: HonoRoute[] = [];
      const localMounts: HonoMount[] = [];
      const importMap = this.extractImportMap(tree.rootNode, file);

      // Walk for Hono app variables
      this.walkAppVariables(tree.rootNode, file, localAppVars);

      // Merge local app variables into model
      for (const [name, app] of Object.entries(localAppVars)) {
        model.app_variables[name] = app;
      }

      // Walk for HTTP routes (not app.route — those are handled separately)
      this.walkHttpRoutes(tree.rootNode, file, localAppVars, localRoutes);

      // Apply prefix and add routes to model
      for (const route of localRoutes) {
        model.routes.push({
          ...route,
          path: joinPaths(prefix, route.raw_path),
        });
      }

      // Cache local parse result (routes stored with raw_path, prefix applied on read)
      parsedCache.set(file, {
        app_variables: localAppVars,
        routes: localRoutes,
        mounts: localMounts,
        files_used: [file],
      });

      // Walk for app.route() mounts — recursive into child files
      inFlight.add(file);
      await this.walkRouteMounts(
        tree.rootNode, file, prefix, localAppVars, importMap,
        inFlight, parsedCache, model, localMounts,
      );
      inFlight.delete(file);
    } finally {
      tree.delete();
    }
  }

  /**
   * Build a map of { variableName → absoluteFilePath } from import statements.
   */
  private extractImportMap(
    root: Parser.SyntaxNode,
    currentFile: string,
  ): Map<string, string> {
    const importMap = new Map<string, string>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "import_statement") return;
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) return;
      const specifier = stringLiteralValue(sourceNode);
      if (!specifier || !specifier.startsWith(".")) return;

      const resolved = resolveImportPath(currentFile, specifier);
      if (!resolved) return;

      // Default import: import X from "./file"
      const importClause = node.children.find(
        (c) => c.type === "import_clause",
      );
      if (!importClause) return;

      for (const child of importClause.namedChildren) {
        if (child.type === "identifier") {
          // default import
          importMap.set(child.text, resolved);
        }
        if (child.type === "named_imports") {
          for (const spec of child.namedChildren) {
            if (spec.type === "import_specifier") {
              const alias = spec.childForFieldName("alias");
              const name = spec.childForFieldName("name");
              const varName = alias?.text ?? name?.text;
              if (varName) importMap.set(varName, resolved);
            }
          }
        }
      }
    });
    return importMap;
  }

  private walkAppVariables(
    root: Parser.SyntaxNode,
    file: string,
    localVars: Record<string, HonoApp>,
  ): void {
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode) return;
      if (nameNode.type !== "identifier") return;

      const createdVia = classifyAppCreation(valueNode);
      if (!createdVia) return;

      localVars[nameNode.text] = {
        variable_name: nameNode.text,
        file,
        line: nameNode.startPosition.row + 1,
        created_via: createdVia,
        base_path: "",
      };
    });
  }

  private walkHttpRoutes(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    routes: HonoRoute[],
  ): void {
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "call_expression") return;
      const fnNode = node.childForFieldName("function");
      const argsNode = node.childForFieldName("arguments");
      if (!fnNode || !argsNode || fnNode.type !== "member_expression") return;

      const objectNode = fnNode.childForFieldName("object");
      const propertyNode = fnNode.childForFieldName("property");
      if (!objectNode || !propertyNode || objectNode.type !== "identifier")
        return;

      const ownerVar = objectNode.text;
      const method = propertyNode.text.toLowerCase();
      if (!appVars[ownerVar]) return;
      if (!HTTP_METHODS.has(method) || method === "use" || method === "route")
        return;

      const argList = argsNode.namedChildren;
      if (argList.length === 0) return;
      const firstArg = argList[0];
      if (!firstArg) return;
      const rawPath = stringLiteralValue(firstArg);
      if (rawPath == null) return;

      const handlerArg = argList[argList.length - 1];
      const handler: HonoHandler = buildHandler(handlerArg ?? firstArg, file);

      routes.push({
        method: method.toUpperCase() as HonoMethod,
        path: rawPath,
        raw_path: rawPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: ownerVar,
        handler,
        inline_middleware: [],
        validators: [],
      });
    });
  }

  /**
   * Walk for app.route("/prefix", subApp) calls.
   * Resolves subApp import, recursively parses the file.
   */
  private async walkRouteMounts(
    root: Parser.SyntaxNode,
    file: string,
    parentPrefix: string,
    appVars: Record<string, HonoApp>,
    importMap: Map<string, string>,
    inFlight: Set<string>,
    parsedCache: Map<string, ChildParseResult>,
    model: HonoAppModel,
    localMounts: HonoMount[],
  ): Promise<void> {
    const mounts: Array<{ mountPath: string; childVar: string; line: number }> = [];
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "call_expression") return;
      const fnNode = node.childForFieldName("function");
      const argsNode = node.childForFieldName("arguments");
      if (!fnNode || !argsNode || fnNode.type !== "member_expression") return;

      const objectNode = fnNode.childForFieldName("object");
      const propertyNode = fnNode.childForFieldName("property");
      if (!objectNode || !propertyNode || objectNode.type !== "identifier")
        return;

      const ownerVar = objectNode.text;
      if (!appVars[ownerVar]) return;
      if (propertyNode.text !== "route") return;

      const argList = argsNode.namedChildren;
      if (argList.length < 2) return;
      const pathArg = argList[0];
      const childArg = argList[1];
      if (!pathArg || !childArg) return;

      const mountPath = stringLiteralValue(pathArg);
      if (mountPath == null) return;
      const childVar =
        childArg.type === "identifier" ? childArg.text : null;
      if (!childVar) return;

      mounts.push({
        mountPath,
        childVar,
        line: node.startPosition.row + 1,
      });
    });

    // Process mounts — async because recursive parse needs file I/O
    for (const { mountPath, childVar, line } of mounts) {
      const childFile = importMap.get(childVar);
      const fullMountPath = joinPaths(parentPrefix, mountPath);

      const mount: HonoMount = {
        parent_var: Object.keys(appVars)[0] ?? "app",
        mount_path: fullMountPath,
        child_var: childVar,
        child_file: childFile ?? "",
        mount_type: "hono_route",
      };
      model.mounts.push(mount);
      localMounts.push(mount);

      if (childFile && existsSync(childFile)) {
        await this.parseFile(childFile, fullMountPath, inFlight, parsedCache, model);
      } else {
        model.skip_reasons.unresolved_import =
          (model.skip_reasons.unresolved_import ?? 0) + 1;
      }
    }
  }
}

// --- Utility functions ---

function pickLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "typescript";
  if (ext === ".jsx" || ext === ".js") return "javascript";
  return "typescript";
}

function emptyModel(
  entryFile: string,
  skipReasons: Record<string, number>,
): HonoAppModel {
  return {
    entry_file: entryFile,
    app_variables: {},
    routes: [],
    mounts: [],
    middleware_chains: [],
    context_vars: [],
    openapi_routes: [],
    rpc_exports: [],
    runtime: "unknown",
    env_bindings: [],
    files_used: [],
    extraction_status: Object.keys(skipReasons).length > 0 ? "partial" : "complete",
    skip_reasons: skipReasons,
  };
}

function classifyAppCreation(
  valueNode: Parser.SyntaxNode,
): HonoApp["created_via"] | null {
  if (valueNode.type !== "new_expression") return null;
  const ctor = valueNode.childForFieldName("constructor");
  if (!ctor) return null;
  if (ctor.type === "identifier") {
    if (ctor.text === "Hono") return "new Hono";
    if (ctor.text === "OpenAPIHono") return "OpenAPIHono";
  }
  if (ctor.type === "member_expression") {
    const prop = ctor.childForFieldName("property");
    if (prop?.text === "Hono") return "new Hono";
    if (prop?.text === "OpenAPIHono") return "OpenAPIHono";
  }
  return null;
}

function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const text = node.text;
    if (text.length < 2) return null;
    const quote = text[0];
    if (quote !== '"' && quote !== "'") return null;
    try {
      const normalized =
        quote === "'"
          ? `"${text.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
          : text;
      const parsed: unknown = JSON.parse(normalized);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (node.type === "template_string") {
    const hasInterpolation = node.namedChildren.some(
      (c) => c.type === "template_substitution",
    );
    if (hasInterpolation) return null;
    const text = node.text;
    if (text.length < 2) return null;
    return text.slice(1, -1);
  }
  return null;
}

function buildHandler(node: Parser.SyntaxNode, file: string): HonoHandler {
  const line = node.startPosition.row + 1;
  if (
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function"
  ) {
    return { name: "<inline>", inline: true, file, line };
  }
  if (node.type === "identifier") {
    return { name: node.text, inline: false, file, line };
  }
  return { name: "<inline>", inline: true, file, line };
}

/**
 * Resolve a relative import specifier to an absolute file path.
 * Tries: exact path, .ts, .js, /index.ts, /index.js extensions.
 */
function resolveImportPath(
  fromFile: string,
  importSpecifier: string,
): string | null {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, importSpecifier);

  // Try with various extensions — .ts fixture files imported as .js in ESM
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.jsx$/, ".tsx"),
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return canonicalize(candidate);
    }
  }
  return null;
}

/**
 * Canonicalize path via realpath for consistent cache invalidation.
 * Falls back to the input path if the file doesn't exist.
 */
function canonicalize(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

/** Join a parent prefix with a child path, avoiding double slashes. */
function joinPaths(prefix: string, childPath: string): string {
  if (!prefix) return childPath;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const c = childPath.startsWith("/") ? childPath : "/" + childPath;
  return p + c;
}

const MAX_WALK_DEPTH = 500;
type CursorVisitor = (node: Parser.SyntaxNode) => void;
function walk(
  cursor: Parser.TreeCursor,
  visit: CursorVisitor,
  depth = 0,
): void {
  if (depth > MAX_WALK_DEPTH) return;
  visit(cursor.currentNode);
  if (cursor.gotoFirstChild()) {
    do {
      walk(cursor, visit, depth + 1);
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
}
