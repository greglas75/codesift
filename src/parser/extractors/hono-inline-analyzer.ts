/**
 * HonoInlineAnalyzer — shared body-analysis for inline handlers and middleware.
 *
 * Walks a tree-sitter syntax node (expected: arrow_function / function_expression)
 * and extracts:
 *   - c.json/text/html/body/redirect/newResponse emissions with status
 *   - throw new HTTPException/Error with status
 *   - Database calls (prisma.*, db.*, knex.*, drizzle*, .query, .execute)
 *   - Fetch calls (fetch, axios.*)
 *   - c.set/get/var/env context access
 *   - Inline validator references (zValidator, vValidator, etc.)
 *   - has_try_catch presence flag
 *
 * Used by HonoExtractor.walkHttpRoutes (Phase 2 T3) and consumed by
 * analyze_inline_handler, extract_response_types, audit_hono_security.
 *
 * Defensive: accepts any node. Non-function nodes return an empty analysis
 * (no throws). Nested functions inside the handler body ARE walked — that is
 * intentional so closures over request context are captured.
 */

import type Parser from "web-tree-sitter";
import type {
  InlineHandlerAnalysis,
  ResponseEmission,
  ErrorEmission,
  ExternalCall,
  ContextAccess,
} from "./hono-model.js";

const MAX_WALK_DEPTH = 500;
const MAX_SHAPE_HINT_LEN = 200;

/** Default status code for c.redirect when second arg is omitted. */
const REDIRECT_DEFAULT_STATUS = 302;
/** Default status code for c.json/text/html/body/newResponse without explicit status. */
const RESPONSE_DEFAULT_STATUS = 200;
/** Default status code for `throw new Error(...)` when no HTTPException wrapper. */
const GENERIC_ERROR_STATUS = 500;

const RESPONSE_METHODS: ReadonlySet<ResponseEmission["kind"]> = new Set([
  "json",
  "text",
  "html",
  "body",
  "redirect",
  "newResponse",
]);

/**
 * DB call prefixes — first token of a member expression chain. Matches
 * `prisma.user.findMany`, `db.select`, `knex("users").where`, `drizzle.query.*`.
 * Suffix-only matching was dropped — it produced false positives on
 * non-DB code like `app.insert`, `array.delete`, `config.from`.
 */
const DB_ROOT_IDENTIFIERS: ReadonlySet<string> = new Set([
  "prisma",
  "db",
  "knex",
  "drizzle",
  "mongoose",
  "supabase",
  "pg",
  "sql",
]);

const FETCH_ROOTS: ReadonlySet<string> = new Set(["fetch", "axios"]);

const VALIDATOR_NAMES: ReadonlySet<string> = new Set([
  "zValidator",
  "vValidator",
  "validator",
  "tbValidator",
  "arkValidator",
]);

export class HonoInlineAnalyzer {
  /**
   * Analyze a handler/middleware body. The caller (HonoExtractor) owns the
   * file path — line numbers here are node-relative (1-based), file-agnostic.
   *
   * The Hono context parameter name is extracted from the first function
   * parameter, so handlers written as `(ctx) => ...` or `(context) => ...`
   * are recognized as well as the canonical `(c) => ...`.
   */
  analyze(handlerNode: Parser.SyntaxNode): InlineHandlerAnalysis {
    const result: InlineHandlerAnalysis = {
      responses: [],
      errors: [],
      db_calls: [],
      fetch_calls: [],
      context_access: [],
      validators_inline: [],
      has_try_catch: false,
      truncated: false,
    };

    if (!isFunctionLike(handlerNode)) {
      return result;
    }

    const ctxBinding = firstParamName(handlerNode) ?? "c";
    const validatorsSet = new Set<string>();
    const cursor = handlerNode.walk();
    const state = { truncated: false };
    walk(cursor, state, (node) => {
      switch (node.type) {
        case "try_statement": {
          if (hasCatchClause(node)) result.has_try_catch = true;
          return;
        }
        case "throw_statement": {
          const err = extractThrownError(node);
          if (err) result.errors.push(err);
          return;
        }
        case "call_expression": {
          const resp = extractResponseEmission(node, ctxBinding);
          if (resp) {
            result.responses.push(resp);
            return;
          }
          const ext = extractExternalCall(node);
          if (ext) {
            if (ext.kind === "db") result.db_calls.push(ext);
            else if (ext.kind === "fetch") result.fetch_calls.push(ext);
            return;
          }
          const ctx = extractContextCall(node, ctxBinding);
          if (ctx) {
            result.context_access.push(ctx);
            return;
          }
          const validator = extractValidatorRef(node);
          if (validator) validatorsSet.add(validator);
          return;
        }
        case "member_expression": {
          // ctx.var.X / ctx.env.X — handled as member access, not call
          const ctx = extractContextMember(node, ctxBinding);
          if (ctx) result.context_access.push(ctx);
          return;
        }
        default:
          return;
      }
    });

    result.validators_inline = [...validatorsSet];
    result.truncated = state.truncated;
    return result;
  }
}

/* ======================================================================
 * Pure functions — extraction helpers. Kept private (not exported) to
 * preserve encapsulation and avoid coupling from tool files.
 * ====================================================================== */

function isFunctionLike(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function_declaration" ||
    node.type === "function" ||
    node.type === "method_definition"
  );
}

/**
 * Extract the first formal parameter name from a function-like node. Returns
 * null for parameterless functions or destructured/complex parameters.
 * Used to resolve the Hono context binding (`c` / `ctx` / `context`).
 */
function firstParamName(fnNode: Parser.SyntaxNode): string | null {
  const params = fnNode.childForFieldName("parameters");
  if (!params) {
    // Arrow with single bare param: (c) => ... — tree-sitter uses "parameter" field
    const singleParam = fnNode.childForFieldName("parameter");
    if (singleParam?.type === "identifier") return singleParam.text;
    return null;
  }
  const first = params.namedChildren[0];
  if (!first) return null;
  if (first.type === "identifier") return first.text;
  // `required_parameter` wraps the pattern in TS; dig one level
  if (first.type === "required_parameter" || first.type === "optional_parameter") {
    const pattern = first.childForFieldName("pattern");
    if (pattern?.type === "identifier") return pattern.text;
  }
  return null;
}

function hasCatchClause(tryNode: Parser.SyntaxNode): boolean {
  for (let i = 0; i < tryNode.childCount; i++) {
    const c = tryNode.child(i);
    if (c?.type === "catch_clause") return true;
  }
  return false;
}

function extractResponseEmission(
  node: Parser.SyntaxNode,
  ctxBinding: string,
): ResponseEmission | null {
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  if (obj?.text !== ctxBinding || !prop) return null;
  const methodName = prop.text;
  if (!isResponseMethod(methodName)) return null;

  const args = node.childForFieldName("arguments");
  const firstArg = args?.namedChildren[0];
  const secondArg = args?.namedChildren[1];
  const status = parseStatusArg(secondArg ?? null, methodName);
  const shape = shapeHintOf(firstArg ?? null);
  const emission: ResponseEmission = {
    kind: methodName,
    status,
    line: node.startPosition.row + 1,
  };
  if (shape !== null) emission.shape_hint = shape;
  return emission;
}

function isResponseMethod(
  name: string,
): name is ResponseEmission["kind"] {
  return RESPONSE_METHODS.has(name as ResponseEmission["kind"]);
}

function parseStatusArg(
  node: Parser.SyntaxNode | null,
  method: string,
): number {
  if (!node) {
    return method === "redirect"
      ? REDIRECT_DEFAULT_STATUS
      : RESPONSE_DEFAULT_STATUS;
  }
  if (node.type === "number") {
    const n = Number(node.text);
    if (Number.isFinite(n)) return n;
  }
  // Fall back to default when status arg is an identifier/expression we can't statically resolve.
  return method === "redirect"
    ? REDIRECT_DEFAULT_STATUS
    : RESPONSE_DEFAULT_STATUS;
}

function shapeHintOf(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  const text = node.text;
  if (!text) return null;
  return text.length > MAX_SHAPE_HINT_LEN
    ? text.slice(0, MAX_SHAPE_HINT_LEN)
    : text;
}

function extractThrownError(
  node: Parser.SyntaxNode,
): ErrorEmission | null {
  // throw_statement → contains new_expression as first child, OR an arbitrary
  // expression (throw err / throw getError() / throw await f()). The former
  // yields a structured emission; the latter produces an "UnknownThrow" entry
  // so error-path analysis isn't blind to rethrows.
  let newExpr: Parser.SyntaxNode | null = null;
  let firstNamedChild: Parser.SyntaxNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || !c.isNamed) continue;
    if (!firstNamedChild) firstNamedChild = c;
    if (c.type === "new_expression") {
      newExpr = c;
      break;
    }
  }

  if (!newExpr) {
    if (!firstNamedChild) return null;
    const emission: ErrorEmission = {
      status: GENERIC_ERROR_STATUS,
      exception_class: "UnknownThrow",
      line: node.startPosition.row + 1,
    };
    const hint = shapeHintOf(firstNamedChild);
    if (hint !== null) emission.message_hint = hint;
    return emission;
  }

  const constructor = newExpr.childForFieldName("constructor");
  const className = constructor?.text ?? "Error";
  const args = newExpr.childForFieldName("arguments");
  const firstArg = args?.namedChildren[0];
  const secondArg = args?.namedChildren[1];

  // HTTPException(status, options) — first arg is status
  if (className === "HTTPException") {
    const status =
      firstArg?.type === "number" && Number.isFinite(Number(firstArg.text))
        ? Number(firstArg.text)
        : GENERIC_ERROR_STATUS;
    const emission: ErrorEmission = {
      status,
      exception_class: className,
      line: node.startPosition.row + 1,
    };
    const hint = shapeHintOf(secondArg ?? null);
    if (hint !== null) emission.message_hint = hint;
    return emission;
  }

  const emission: ErrorEmission = {
    status: GENERIC_ERROR_STATUS,
    exception_class: className,
    line: node.startPosition.row + 1,
  };
  const hint = shapeHintOf(firstArg ?? null);
  if (hint !== null) emission.message_hint = hint;
  return emission;
}

function extractExternalCall(
  node: Parser.SyntaxNode,
): ExternalCall | null {
  const fn = node.childForFieldName("function");
  if (!fn) return null;

  // fetch() / axios() — bare identifier
  if (fn.type === "identifier") {
    const name = fn.text;
    if (FETCH_ROOTS.has(name)) {
      return {
        callee: name,
        line: node.startPosition.row + 1,
        kind: "fetch",
      };
    }
    return null;
  }

  if (fn.type === "member_expression") {
    const chain = memberChain(fn);
    if (chain.length === 0) return null;
    const root = chain[0];
    if (root && FETCH_ROOTS.has(root)) {
      return {
        callee: chain.join("."),
        line: node.startPosition.row + 1,
        kind: "fetch",
      };
    }
    if (root && DB_ROOT_IDENTIFIERS.has(root)) {
      return {
        callee: chain.join("."),
        line: node.startPosition.row + 1,
        kind: "db",
      };
    }
  }
  return null;
}

/**
 * Walk a member_expression chain left-to-right. For `prisma.user.findMany`
 * returns `["prisma", "user", "findMany"]`. Returns empty array when the
 * chain contains non-identifier nodes (e.g. computed access `obj[key]`).
 */
function memberChain(node: Parser.SyntaxNode): string[] {
  const parts: string[] = [];
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "member_expression") {
      const prop = current.childForFieldName("property");
      if (prop?.type === "property_identifier" || prop?.type === "identifier") {
        parts.unshift(prop.text);
      } else {
        return [];
      }
      current = current.childForFieldName("object");
    } else if (current.type === "identifier") {
      parts.unshift(current.text);
      current = null;
    } else {
      return [];
    }
  }
  return parts;
}

function extractContextCall(
  node: Parser.SyntaxNode,
  ctxBinding: string,
): ContextAccess | null {
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  if (obj?.text !== ctxBinding || !prop) return null;

  if (prop.text === "set" || prop.text === "get") {
    const args = node.childForFieldName("arguments");
    const key = args?.namedChildren[0];
    const keyText = key ? stringOrTemplateValue(key) : null;
    if (keyText !== null) {
      return {
        type: prop.text,
        key: keyText,
        line: node.startPosition.row + 1,
      };
    }
  }
  return null;
}

function extractContextMember(
  node: Parser.SyntaxNode,
  ctxBinding: string,
): ContextAccess | null {
  // ctx.var.X  →  (ctx.var).X
  // ctx.env.X  →  (ctx.env).X
  const obj = node.childForFieldName("object");
  const prop = node.childForFieldName("property");
  if (!prop || obj?.type !== "member_expression") return null;
  const innerObj = obj.childForFieldName("object");
  const innerProp = obj.childForFieldName("property");
  if (innerObj?.text !== ctxBinding || !innerProp) return null;
  if (innerProp.text === "var") {
    return {
      type: "var",
      key: prop.text,
      line: node.startPosition.row + 1,
    };
  }
  if (innerProp.text === "env") {
    return {
      type: "env",
      key: prop.text,
      line: node.startPosition.row + 1,
    };
  }
  return null;
}

function extractValidatorRef(
  node: Parser.SyntaxNode,
): string | null {
  const fn = node.childForFieldName("function");
  if (fn?.type === "identifier" && VALIDATOR_NAMES.has(fn.text)) {
    return fn.text;
  }
  return null;
}

/**
 * Extracts the underlying string value of a literal argument. Handles both
 * plain strings (`"key"`) and no-substitution template literals (`` `key` ``).
 * Returns `"<dynamic>"` for interpolated templates so analyzers still record
 * that a context access happened at an unknown key.
 */
function stringOrTemplateValue(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const raw = node.text;
    return raw.length < 2 ? null : raw.slice(1, -1);
  }
  if (node.type === "template_string") {
    // No interpolations → return the literal text; else flag as dynamic
    const hasSubstitution = (() => {
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === "template_substitution") return true;
      }
      return false;
    })();
    if (hasSubstitution) return "<dynamic>";
    const raw = node.text;
    return raw.length < 2 ? null : raw.slice(1, -1);
  }
  return null;
}

type WalkState = { truncated: boolean };
type CursorVisitor = (node: Parser.SyntaxNode) => void;

function walk(
  cursor: Parser.TreeCursor,
  state: WalkState,
  visit: CursorVisitor,
  depth = 0,
): void {
  if (depth > MAX_WALK_DEPTH) {
    state.truncated = true;
    return;
  }
  visit(cursor.currentNode);
  if (cursor.gotoFirstChild()) {
    do {
      walk(cursor, state, visit, depth + 1);
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
}
