/**
 * Astro middleware audit. Parses src/middleware.{ts,js,mjs} and reports:
 *   MW00 parse-failure        — file present but tree-sitter cannot parse
 *   MW01 no-onRequest-export  — file exists but does not export onRequest
 *   MW02 sequence-ambiguous   — sequence(...) called but args are non-identifiers
 *   MW03 guard-without-effect — a guarding `if` body that does not redirect/throw/return Response
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { getParser } from "../parser/parser-manager.js";
import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex } from "../types.js";

export interface MiddlewareIssue {
  code: "MW00" | "MW01" | "MW02" | "MW03";
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
}

export interface MiddlewareAuditResult {
  middleware_file: string | null;
  handlers: string[];
  sequence: string[];
  routes_protected_count: number;
  issues: MiddlewareIssue[];
  summary: { handlers_total: number; issues_total: number };
}

const CANDIDATES = ["src/middleware.ts", "src/middleware.js", "src/middleware.mjs"];

function findMiddlewareFile(root: string): { abs: string; rel: string } | null {
  for (const rel of CANDIDATES) {
    const abs = join(root, rel);
    if (existsSync(abs)) return { abs, rel };
  }
  return null;
}

function parseMiddleware(
  parser: Parser,
  source: string,
): { handlers: string[]; sequence: string[]; guardsWithoutEffect: number; parseOk: boolean } {
  let tree: Parser.Tree;
  try { tree = parser.parse(source); } catch { return { handlers: [], sequence: [], guardsWithoutEffect: 0, parseOk: false }; }
  const root = tree.rootNode;
  if (root.hasError) {
    // tolerate partial parse but flag overall result
  }

  const handlers: string[] = [];
  const sequence: string[] = [];
  let guardsWithoutEffect = 0;

  // 1. find `export const onRequest = ...`
  for (const decl of root.descendantsOfType("export_statement")) {
    const lex = decl.descendantsOfType("lexical_declaration")[0];
    if (!lex) continue;
    for (const v of lex.descendantsOfType("variable_declarator")) {
      const name = v.childForFieldName("name");
      if (name && name.text === "onRequest") {
        handlers.push("onRequest");
        const value = v.childForFieldName("value");
        if (value && value.type === "call_expression") {
          const fn = value.childForFieldName("function");
          if (fn && fn.text === "sequence") {
            const args = value.childForFieldName("arguments");
            if (args) {
              for (const arg of args.namedChildren) {
                if (arg.type === "identifier") sequence.push(arg.text);
              }
            }
          }
        }
      }
    }
  }

  // 2. heuristic: count guard `if` blocks lacking redirect/throw/return Response
  for (const ifStmt of root.descendantsOfType("if_statement")) {
    const consequence = ifStmt.childForFieldName("consequence");
    if (!consequence) continue;
    const body = consequence.text;
    const hasEffect = /\b(return\s+(?:new\s+Response|context\.redirect|Astro\.redirect|next\(\))|throw\b|redirect\(|context\.rewrite)/.test(body);
    if (!hasEffect && /context\.|locals\.|user|auth|session|cookies/i.test(ifStmt.text)) guardsWithoutEffect++;
  }

  return { handlers, sequence, guardsWithoutEffect, parseOk: !root.hasError };
}

export async function auditAstroMiddlewareFromRoot(
  root: string,
): Promise<MiddlewareAuditResult> {
  const found = findMiddlewareFile(root);
  if (!found) {
    return { middleware_file: null, handlers: [], sequence: [], routes_protected_count: 0, issues: [], summary: { handlers_total: 0, issues_total: 0 } };
  }
  let source: string;
  try { source = readFileSync(found.abs, "utf-8"); } catch {
    return { middleware_file: found.rel, handlers: [], sequence: [], routes_protected_count: 0, issues: [{ code: "MW00", severity: "error", message: `Cannot read ${found.rel}`, file: found.rel, line: 1 }], summary: { handlers_total: 0, issues_total: 1 } };
  }
  const parser = await getParser("typescript");
  if (!parser) return { middleware_file: found.rel, handlers: [], sequence: [], routes_protected_count: 0, issues: [{ code: "MW00", severity: "error", message: "TypeScript parser unavailable", file: found.rel, line: 1 }], summary: { handlers_total: 0, issues_total: 1 } };

  const parsed = parseMiddleware(parser, source);
  const issues: MiddlewareIssue[] = [];
  if (!parsed.parseOk) issues.push({ code: "MW00", severity: "error", message: `Parse error in ${found.rel}`, file: found.rel, line: 1 });
  if (parsed.handlers.length === 0) issues.push({ code: "MW01", severity: "error", message: `${found.rel} does not export onRequest`, file: found.rel, line: 1 });
  if (parsed.sequence.length === 0 && /\bsequence\s*\(/.test(source) && parsed.handlers.length > 0) {
    issues.push({ code: "MW02", severity: "warning", message: "sequence(...) called with non-identifier args — order is ambiguous", file: found.rel, line: 1 });
  }
  for (let i = 0; i < parsed.guardsWithoutEffect; i++) {
    issues.push({ code: "MW03", severity: "warning", message: "Guarding if-block without redirect/throw/return — falls through", file: found.rel, line: 1 });
  }

  return {
    middleware_file: found.rel,
    handlers: parsed.handlers,
    sequence: parsed.sequence,
    routes_protected_count: parsed.handlers.length > 0 ? 1 : 0,
    issues,
    summary: { handlers_total: parsed.handlers.length, issues_total: issues.length },
  };
}

export async function auditAstroMiddlewareFromIndex(
  index: CodeIndex,
): Promise<MiddlewareAuditResult> {
  return auditAstroMiddlewareFromRoot(index.root);
}

export async function astroMiddlewareAudit(
  args: { project_root?: string; repo?: string },
): Promise<MiddlewareAuditResult> {
  if (args.project_root) return auditAstroMiddlewareFromRoot(args.project_root);
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) return { middleware_file: null, handlers: [], sequence: [], routes_protected_count: 0, issues: [], summary: { handlers_total: 0, issues_total: 0 } };
  return auditAstroMiddlewareFromIndex(index);
}
