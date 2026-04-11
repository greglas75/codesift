import type Parser from "web-tree-sitter";
import { readStringLiteral } from "./nextjs-metadata-readers.js";

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

// ---------------------------------------------------------------------------
// Link/href extraction (T5 helper)
// ---------------------------------------------------------------------------

export type LinkRefKind = "link" | "router_push" | "router_replace";

export interface LinkRef {
  /** Literal href value when isDynamic=false; raw expression text otherwise. */
  href: string;
  /** True if the href is a template literal with substitutions or a non-literal expression. */
  isDynamic: boolean;
  /** 1-indexed line number of the attribute / call site. */
  line: number;
  /** The kind of navigation source. */
  kind: LinkRefKind;
}

/**
 * Extract navigation target references from a parsed tree:
 *   - `<Link href="/path">` JSX components
 *   - `router.push("/path")` / `router.replace("/path")` call sites
 *
 * Literal string values populate `href` with the unquoted content and
 * `isDynamic: false`. Template literals with substitutions and identifier
 * references populate `href` with the raw expression text and `isDynamic: true`.
 */
export function extractLinkHrefs(tree: Parser.Tree, _source: string): LinkRef[] {
  const refs: LinkRef[] = [];
  const root = tree.rootNode;

  // <Link href="...">
  for (const opening of root.descendantsOfType("jsx_opening_element")) {
    const name = opening.childForFieldName("name") ?? opening.namedChild(0);
    if (name?.type !== "identifier" || name.text !== "Link") continue;
    for (const attr of opening.namedChildren) {
      if (attr.type !== "jsx_attribute") continue;
      const attrName = attr.namedChild(0);
      if (!attrName) continue;
      const attrNameText =
        attrName.type === "property_identifier" || attrName.type === "identifier"
          ? attrName.text
          : null;
      if (attrNameText !== "href") continue;
      const value = attr.namedChild(1);
      if (!value) continue;
      const line = attr.startPosition.row + 1;

      if (value.type === "string") {
        const s = readStringLiteral(value);
        refs.push({
          href: s ?? value.text,
          isDynamic: false,
          line,
          kind: "link",
        });
      } else if (value.type === "jsx_expression") {
        const inner = value.namedChildren[0];
        if (!inner) continue;
        if (inner.type === "string") {
          const s = readStringLiteral(inner);
          refs.push({ href: s ?? inner.text, isDynamic: false, line, kind: "link" });
        } else if (inner.type === "template_string") {
          // template literal — dynamic unless fully literal
          const hasSubs = inner.namedChildren.some((c) => c.type === "template_substitution");
          if (!hasSubs) {
            const literal = readStringLiteral(inner);
            refs.push({
              href: literal ?? inner.text,
              isDynamic: false,
              line,
              kind: "link",
            });
          } else {
            refs.push({ href: inner.text, isDynamic: true, line, kind: "link" });
          }
        } else {
          // identifier, call, etc. — dynamic
          refs.push({ href: inner.text, isDynamic: true, line, kind: "link" });
        }
      }
    }
  }

  // router.push(...) / router.replace(...)
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function") ?? call.namedChild(0);
    if (!fn || fn.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object") ?? fn.namedChild(0);
    const prop = fn.childForFieldName("property") ?? fn.namedChild(1);
    if (obj?.type !== "identifier" || obj.text !== "router") continue;
    if (prop?.type !== "property_identifier") continue;
    const method = prop.text;
    if (method !== "push" && method !== "replace") continue;

    const args = call.childForFieldName("arguments") ?? call.namedChild(1);
    const firstArg = args?.namedChildren[0];
    if (!firstArg) continue;
    const line = call.startPosition.row + 1;
    const kind: LinkRefKind = method === "push" ? "router_push" : "router_replace";

    if (firstArg.type === "string") {
      const s = readStringLiteral(firstArg);
      refs.push({
        href: s ?? firstArg.text,
        isDynamic: false,
        line,
        kind,
      });
    } else if (firstArg.type === "template_string") {
      const hasSubs = firstArg.namedChildren.some((c) => c.type === "template_substitution");
      if (!hasSubs) {
        const literal = readStringLiteral(firstArg);
        refs.push({ href: literal ?? firstArg.text, isDynamic: false, line, kind });
      } else {
        refs.push({ href: firstArg.text, isDynamic: true, line, kind });
      }
    } else {
      refs.push({ href: firstArg.text, isDynamic: true, line, kind });
    }
  }

  return refs;
}
