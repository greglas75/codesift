/**
 * HonoExtractor — AST-based extractor for Hono framework applications.
 *
 * Parses a Hono entry file using tree-sitter TypeScript grammar and produces
 * a HonoAppModel that describes routes, middleware, context flow, OpenAPI
 * schemas, and RPC exports.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md
 * Plan: docs/specs/2026-04-10-hono-framework-intelligence-plan.md (Task 2+)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type Parser from "web-tree-sitter";
import { getParser } from "../parser-manager.js";
import type {
  HonoApp,
  HonoAppModel,
  HonoHandler,
  HonoMethod,
  HonoRoute,
} from "./hono-model.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "all",
  "on",
]);

export class HonoExtractor {
  async parse(entryFile: string): Promise<HonoAppModel> {
    const absoluteEntry = path.resolve(entryFile);
    const source = await readFile(absoluteEntry, "utf-8");
    const language = pickLanguage(absoluteEntry);
    const parser = await getParser(language);
    if (!parser) {
      return emptyModel(absoluteEntry, { parser_unavailable: 1 });
    }

    const tree = parser.parse(source);
    if (!tree) {
      return emptyModel(absoluteEntry, { parse_failed: 1 });
    }

    try {
      const model = emptyModel(absoluteEntry, {
        middleware_not_extracted: 1,
        context_flow_not_extracted: 1,
        openapi_not_extracted: 1,
      });
      model.files_used = [absoluteEntry];

      this.walkAppVariables(tree.rootNode, absoluteEntry, model);
      this.walkRoutes(tree.rootNode, absoluteEntry, model);

      return model;
    } finally {
      // web-tree-sitter allocates tree memory in the WASM heap — must be freed
      // explicitly or bulk indexing leaks into OOM.
      tree.delete();
    }
  }

  private walkAppVariables(
    root: Parser.SyntaxNode,
    file: string,
    model: HonoAppModel,
  ): void {
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode) return;
      if (nameNode.type !== "identifier") return;
      const name = nameNode.text;

      const createdVia = classifyAppCreation(valueNode);
      if (!createdVia) return;

      const app: HonoApp = {
        variable_name: name,
        file,
        line: nameNode.startPosition.row + 1,
        created_via: createdVia,
        base_path: "",
      };
      model.app_variables[name] = app;
    });
  }

  private walkRoutes(
    root: Parser.SyntaxNode,
    file: string,
    model: HonoAppModel,
  ): void {
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "call_expression") return;
      const fnNode = node.childForFieldName("function");
      const argsNode = node.childForFieldName("arguments");
      if (!fnNode || !argsNode) return;
      if (fnNode.type !== "member_expression") return;

      const objectNode = fnNode.childForFieldName("object");
      const propertyNode = fnNode.childForFieldName("property");
      if (!objectNode || !propertyNode) return;
      if (objectNode.type !== "identifier") return;

      const ownerVar = objectNode.text;
      const method = propertyNode.text.toLowerCase();
      if (!model.app_variables[ownerVar]) return;
      if (!HTTP_METHODS.has(method)) return;
      if (method === "use") return; // middleware handled elsewhere

      const argList = argsNode.namedChildren;
      if (argList.length === 0) return;

      const firstArg = argList[0];
      if (!firstArg) return;
      const rawPath = stringLiteralValue(firstArg);
      if (rawPath == null) return;

      const handlerArg = argList[argList.length - 1];
      const handler: HonoHandler = buildHandler(handlerArg ?? firstArg, file);

      const route: HonoRoute = {
        method: method.toUpperCase() as HonoMethod,
        path: rawPath,
        raw_path: rawPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: ownerVar,
        handler,
        inline_middleware: [],
        validators: [],
      };
      model.routes.push(route);
    });
  }
}

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
  if (valueNode.type === "new_expression") {
    const ctor = valueNode.childForFieldName("constructor");
    if (!ctor) return null;
    // Direct: new Hono(), new OpenAPIHono()
    if (ctor.type === "identifier") {
      if (ctor.text === "Hono") return "new Hono";
      if (ctor.text === "OpenAPIHono") return "OpenAPIHono";
    }
    // Namespace: new hono.Hono(), new openapi.OpenAPIHono()
    if (ctor.type === "member_expression") {
      const prop = ctor.childForFieldName("property");
      if (prop?.text === "Hono") return "new Hono";
      if (prop?.text === "OpenAPIHono") return "OpenAPIHono";
    }
    return null;
  }
  return null;
}

function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    // Plain single- or double-quoted string. Use JSON.parse to resolve escapes.
    // tree-sitter gives us the raw source text with surrounding quotes.
    const text = node.text;
    if (text.length < 2) return null;
    const quote = text[0];
    if (quote !== '"' && quote !== "'") return null;
    try {
      // JSON.parse only accepts double quotes — convert single-quoted literals.
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
    // Reject interpolated templates — `/users/${prefix}/:id` is not a static path.
    // Accept only templates with zero substitutions (plain backtick-quoted literal).
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

function buildHandler(
  node: Parser.SyntaxNode,
  file: string,
): HonoHandler {
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
