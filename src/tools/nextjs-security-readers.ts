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
      // const x = async () => { ... }
      for (const decl of exp.descendantsOfType("variable_declarator")) {
        const name = decl.childForFieldName("name")?.text;
        const value = decl.childForFieldName("value");
        if (!name || !value) continue;
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

export function detectAuthGuard(_fn: ServerActionFn): AuthGuardInfo {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Input validation detection (Task 16)
// ---------------------------------------------------------------------------

export function detectInputValidation(
  _fn: ServerActionFn,
  _tree: Parser.Tree,
  _source: string,
): InputValidationInfo {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// Rate limiting detection (Task 16)
// ---------------------------------------------------------------------------

export function detectRateLimiting(
  _fn: ServerActionFn,
  _tree: Parser.Tree,
  _source: string,
): RateLimitingInfo {
  throw new Error("not implemented");
}
