/**
 * AST readers for Next.js Server Actions security audit (T2).
 *
 * Each reader is a focused, pure function that extracts a specific signal
 * from a parsed tree-sitter Tree. The orchestrator in `nextjs-security-tools.ts`
 * composes them into a per-action audit.
 */

import type Parser from "web-tree-sitter";
import { extractZodSchema } from "../utils/nextjs.js";
import type {
  AuthGuardInfo,
  InputValidationInfo,
  RateLimitingInfo,
} from "./nextjs-security-tools.js";

/** Determine if a tree-sitter program has a file-scope `"use server"` directive. */
function hasFileScopeUseServer(tree: Parser.Tree): boolean {
  const root = tree.rootNode;
  const first = root.namedChildren[0];
  if (!first) return false;
  if (first.type !== "expression_statement") return false;
  const inner = first.namedChildren[0];
  if (!inner) return false;
  if (inner.type !== "string") return false;
  const text = inner.text.length >= 2 ? inner.text.slice(1, -1) : inner.text;
  return text === "use server";
}

/** Returns true if the function body's first statement is `"use server"` directive. */
function hasInlineUseServer(body: Parser.SyntaxNode): boolean {
  if (body.type !== "statement_block") return false;
  const first = body.namedChildren[0];
  if (!first) return false;
  if (first.type !== "expression_statement") return false;
  const inner = first.namedChildren[0];
  if (!inner || inner.type !== "string") return false;
  const text = inner.text.length >= 2 ? inner.text.slice(1, -1) : inner.text;
  return text === "use server";
}

// ---------------------------------------------------------------------------
// Server action enumeration (Task 14)
// ---------------------------------------------------------------------------

export interface ServerActionFn {
  name: string;
  file: string;
  line: number;
  isAsync: boolean;
  bodyNode: Parser.SyntaxNode | null;
  fnNode: Parser.SyntaxNode;
}

export function extractServerActionFunctions(
  tree: Parser.Tree,
  _source: string,
  file: string,
): ServerActionFn[] {
  const out: ServerActionFn[] = [];
  const root = tree.rootNode;

  const fileScope = hasFileScopeUseServer(tree);

  if (fileScope) {
    // All exported functions in this file are server actions.
    for (const exp of root.descendantsOfType("export_statement")) {
      // function_declaration form
      for (const fn of exp.descendantsOfType("function_declaration")) {
        // Skip nested function declarations
        if (fn.parent?.id !== exp.id && fn.parent?.parent?.id !== exp.id) continue;
        const name = fn.childForFieldName("name")?.text ?? "<anon>";
        const isAsync = /\basync\b/.test(exp.text.split("function")[0] ?? "");
        const body = fn.childForFieldName("body");
        out.push({
          name,
          file,
          line: fn.startPosition.row + 1,
          isAsync,
          bodyNode: body ?? null,
          fnNode: fn,
        });
      }
      // const x = async () => { ... }   OR   const x = wrap(async () => { ... })
      for (const decl of exp.descendantsOfType("variable_declarator")) {
        const name = decl.childForFieldName("name")?.text;
        const value = decl.childForFieldName("value");
        if (!name || !value) continue;
        // Direct arrow / function_expression
        if (value.type === "arrow_function" || value.type === "function_expression") {
          const isAsync = /^\s*async\b/.test(value.text);
          const body = value.childForFieldName("body");
          out.push({
            name,
            file,
            line: decl.startPosition.row + 1,
            isAsync,
            bodyNode: body ?? null,
            fnNode: value,
          });
        } else if (value.type === "call_expression") {
          // HOC wrapper: find the inner arrow/function expression argument.
          const args = value.childForFieldName("arguments") ?? value.namedChild(1);
          if (!args) continue;
          for (const arg of args.namedChildren) {
            if (arg.type === "arrow_function" || arg.type === "function_expression") {
              const isAsync = /^\s*async\b/.test(arg.text);
              const body = arg.childForFieldName("body");
              out.push({
                name,
                file,
                line: decl.startPosition.row + 1,
                isAsync,
                bodyNode: body && body.type === "statement_block" ? body : null,
                fnNode: arg,
              });
              break;
            }
          }
        }
      }
    }
    return out;
  }

  // No file-scope directive: walk all functions and find inline `"use server"`.
  const allFns: Parser.SyntaxNode[] = [
    ...root.descendantsOfType("function_declaration"),
    ...root.descendantsOfType("arrow_function"),
    ...root.descendantsOfType("function_expression"),
  ];
  for (const fn of allFns) {
    const body = fn.childForFieldName("body");
    if (!body || body.type !== "statement_block") continue;
    if (!hasInlineUseServer(body)) continue;

    let name = "<anon>";
    if (fn.type === "function_declaration") {
      name = fn.childForFieldName("name")?.text ?? "<anon>";
    } else {
      // Try to find enclosing variable_declarator for name
      let p: Parser.SyntaxNode | null = fn.parent;
      while (p) {
        if (p.type === "variable_declarator") {
          name = p.childForFieldName("name")?.text ?? "<anon>";
          break;
        }
        p = p.parent;
      }
    }
    const isAsync = /^\s*async\b/.test(fn.text);
    out.push({
      name,
      file,
      line: fn.startPosition.row + 1,
      isAsync,
      bodyNode: body,
      fnNode: fn,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Auth guard detection (Task 15)
// ---------------------------------------------------------------------------

/** Default identifier set for auth detection. */
const AUTH_CALL_NAMES = new Set([
  "auth",
  "getSession",
  "getServerSession",
  "currentUser",
  "validateRequest",
  "getAuth",
  "getUser",
]);

const AUTH_HOC_NAMES = new Set(["withAuth", "requireAuth", "withSession"]);

export function detectAuthGuard(fn: ServerActionFn): AuthGuardInfo {
  const body = fn.bodyNode;

  // 0) HOC wrapper detection — if the function node is the argument of a known HOC wrapper.
  let p: Parser.SyntaxNode | null = fn.fnNode.parent;
  while (p) {
    if (p.type === "call_expression") {
      const callee = p.childForFieldName("function") ?? p.namedChild(0);
      if (callee?.type === "identifier" && AUTH_HOC_NAMES.has(callee.text)) {
        return { confidence: "medium", pattern: "hoc" };
      }
    }
    p = p.parent;
  }

  if (!body) {
    return { confidence: "none", pattern: "none" };
  }

  // 1) Look for direct auth call expressions inside body.
  let firstAuthCall: { name: string; line: number; node: Parser.SyntaxNode } | null = null;
  for (const call of body.descendantsOfType("call_expression")) {
    const callee = call.childForFieldName("function") ?? call.namedChild(0);
    if (callee?.type === "identifier" && AUTH_CALL_NAMES.has(callee.text)) {
      firstAuthCall = { name: callee.text, line: call.startPosition.row + 1, node: call };
      break;
    }
    // Member access like auth.protect()
    if (callee?.type === "member_expression") {
      const obj = callee.childForFieldName("object") ?? callee.namedChild(0);
      const prop = callee.childForFieldName("property") ?? callee.namedChild(1);
      if (obj?.type === "identifier" && AUTH_CALL_NAMES.has(obj.text)) {
        firstAuthCall = {
          name: `${obj.text}.${prop?.text ?? ""}`,
          line: call.startPosition.row + 1,
          node: call,
        };
        break;
      }
    }
  }

  if (firstAuthCall) {
    // Walk forward in body looking for if(!result)/throw/return within the next 5 statements.
    const callLine = firstAuthCall.line;
    const callIndex = firstAuthCall.node.endIndex;
    let resultChecked = false;
    for (const ifStmt of body.descendantsOfType("if_statement")) {
      if (ifStmt.startIndex >= callIndex && ifStmt.startPosition.row <= callLine + 5) {
        // Heuristic: any if-throw/return after the auth call counts as "checked"
        const inner = ifStmt.text;
        if (/throw|return\s|redirect/.test(inner)) {
          resultChecked = true;
          break;
        }
      }
    }
    // Also handle assignment + checked condition: if (!session) { ... }
    if (!resultChecked) {
      // Look for any assignment storing the call result, then a usage in if-condition
      for (const decl of body.descendantsOfType("variable_declarator")) {
        const value = decl.childForFieldName("value");
        if (!value) continue;
        // Skip assignments before the auth call
        if (decl.startIndex < firstAuthCall.node.startIndex) continue;
        const varName = decl.childForFieldName("name")?.text;
        if (!varName) continue;
        // Check for usage in subsequent if condition
        for (const ifStmt of body.descendantsOfType("if_statement")) {
          if (ifStmt.startIndex < decl.endIndex) continue;
          const cond = ifStmt.childForFieldName("condition") ?? ifStmt.namedChild(0);
          if (cond && new RegExp(`\\b${varName}\\b`).test(cond.text)) {
            const inner = ifStmt.text;
            if (/throw|return\s|redirect/.test(inner)) {
              resultChecked = true;
              break;
            }
          }
        }
        if (resultChecked) break;
      }
    }

    return {
      confidence: resultChecked ? "high" : "medium",
      pattern: "direct",
      callsite: { name: firstAuthCall.name, line: firstAuthCall.line },
    };
  }

  // 2) Comment-only mention as fallback (low).
  const bodyText = body.text;
  if (/(?:\/\/|\/\*)\s*[^*]*\b(auth|session|user|permission)/i.test(bodyText)) {
    return { confidence: "low", pattern: "none" };
  }

  return { confidence: "none", pattern: "none" };
}

// ---------------------------------------------------------------------------
// Input validation detection (Task 16)
// ---------------------------------------------------------------------------

export function detectInputValidation(
  fn: ServerActionFn,
  tree: Parser.Tree,
  source: string,
): InputValidationInfo {
  const body = fn.bodyNode;
  if (!body) return { lib: "none", confidence: "high" };

  // 1) Look for `.parse()` or `.safeParse()` call expressions on a Zod schema.
  for (const call of body.descendantsOfType("call_expression")) {
    const callee = call.childForFieldName("function") ?? call.namedChild(0);
    if (callee?.type !== "member_expression") continue;
    const prop = callee.childForFieldName("property") ?? callee.namedChild(1);
    if (prop?.type !== "property_identifier") continue;
    if (prop.text !== "parse" && prop.text !== "safeParse") continue;

    // Disambiguate Zod from other libs by inspecting the file for a Zod schema.
    const zodShape = extractZodSchema(tree, source);
    if (zodShape) {
      return { lib: "zod", confidence: "high" };
    }
    // Fallback: at least the .parse() call indicates structured validation.
    return { lib: "manual", confidence: "medium" };
  }

  // 2) Manual validation: count if-throw statements in the first 5 statements.
  let manualCount = 0;
  const stmts = body.namedChildren.slice(0, 5);
  for (const s of stmts) {
    if (s.type !== "if_statement") continue;
    if (/throw\b/.test(s.text)) manualCount++;
  }
  if (manualCount >= 1) {
    return { lib: "manual", confidence: "medium" };
  }

  return { lib: "none", confidence: "high" };
}

// ---------------------------------------------------------------------------
// Rate limiting detection (Task 16)
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS: Array<{ regex: RegExp; lib: RateLimitingInfo["lib"] }> = [
  { regex: /\bratelimit\.limit\s*\(/, lib: "upstash" },
  { regex: /\@upstash\/ratelimit/, lib: "upstash" },
  { regex: /\bcreateRateLimiter\s*\(/, lib: "manual" },
  { regex: /\brateLimit\s*\(/, lib: "manual" },
  { regex: /\bnext\/rate-limit/, lib: "vercel" },
];

export function detectRateLimiting(
  fn: ServerActionFn,
  _tree: Parser.Tree,
  _source: string,
): RateLimitingInfo {
  const body = fn.bodyNode;
  if (!body) return { lib: "none", confidence: "high" };
  const text = body.text;

  for (const { regex, lib } of RATE_LIMIT_PATTERNS) {
    if (regex.test(text)) {
      return { lib, confidence: "high" };
    }
  }
  return { lib: "none", confidence: "high" };
}
