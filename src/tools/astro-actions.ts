/**
 * Astro Actions audit (6 AA detectors with A/B/C/D scoring).
 *
 * Analyses `src/actions/index.{ts,js,mjs}` to extract the set of defined
 * actions (via `defineAction({...})` calls) and cross-references how those
 * actions are invoked throughout the project (.astro frontmatter + .tsx/.jsx
 * client components).
 *
 * Detectors:
 *   AA01 missing-handler-return       — error
 *   AA02 refine-on-top-level-schema   — error (Astro issue #11641)
 *   AA03 passthrough-ignored          — warning (Astro issue #11693)
 *   AA04 file-without-multipart       — error
 *   AA05 action-called-from-server    — warning
 *   AA06 client-calls-unknown-action  — error
 *
 * Exports:
 *   - `auditAstroActionsFromIndex(index, severity?)` — testable core
 *   - `astroActionsAudit(args)` — MCP tool handler
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { getParser, initParser } from "../parser/parser-manager.js";
import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ActionDescriptor {
  name: string;
  file: string;
  line: number;
  accept?: "json" | "form";
  has_input_schema: boolean;
  input_fields: string[];
}

export interface ActionsAuditIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  file: string;
  line: number;
  action?: string;
  fix: string;
}

export interface ActionsAuditResult {
  actions: ActionDescriptor[];
  issues: ActionsAuditIssue[];
  anti_patterns_checked: string[];
  summary: {
    total_actions: number;
    total_issues: number;
    score: "A" | "B" | "C" | "D";
  };
}

// ---------------------------------------------------------------------------
// Internal state captured from the actions file
// ---------------------------------------------------------------------------

interface ExtractedAction extends ActionDescriptor {
  /** Flag set when the handler body has no top-level return statement. */
  handler_missing_return: boolean;
  /** Flag set when the input schema has a `.refine(...)` applied to the outer z.object(). */
  refine_on_top_level: boolean;
  /** Line where the `.refine(` call lives (for AA02 reporting). */
  refine_line?: number;
  /** Flag set when `.passthrough()` is called on the input schema. */
  has_passthrough: boolean;
  /** Line where the `.passthrough(` call lives (for AA03 reporting). */
  passthrough_line?: number;
  /** Whether any field in the input schema is declared via z.instanceof(File). */
  has_file_field: boolean;
  /** Line where a z.instanceof(File) field is declared (for AA04 reporting). */
  file_field_line?: number;
}

const ALL_CODES = ["AA01", "AA02", "AA03", "AA04", "AA05", "AA06"];

const ACTIONS_FILE_CANDIDATES = [
  "src/actions/index.ts",
  "src/actions/index.js",
  "src/actions/index.mjs",
];

const EXPECT_TS_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".jsx": "javascript",
};

function pickLang(filePath: string): string {
  for (const [ext, lang] of Object.entries(EXPECT_TS_EXTENSION)) {
    if (filePath.endsWith(ext)) return lang;
  }
  return "typescript";
}

// ---------------------------------------------------------------------------
// AST helpers (shared shapes with astro-config.ts)
// ---------------------------------------------------------------------------

function stripQuotes(s: string): string {
  return (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] ? s.slice(1, -1) : s;
}

function getProperty(obj: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const k = p.childForFieldName("key");
    if (!k) continue;
    const keyText = stripQuotes(k.text);
    if (keyText === name) return p.childForFieldName("value") ?? null;
  }
  return null;
}

/** Walk every descendant of `node` and run `visit`. Depth-capped to avoid runaways. */
function walkAll(
  node: Parser.SyntaxNode,
  visit: (n: Parser.SyntaxNode) => void,
  depth = 0,
): void {
  if (depth > 400) return;
  visit(node);
  for (const child of node.namedChildren) walkAll(child, visit, depth + 1);
}

/** Descend a chained call expression to find the innermost receiver.
 *  e.g. `z.object({...}).refine(...)` → returns the `z.object({...})` call. */
function receiverOfCall(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "member_expression") {
    const obj = fn.childForFieldName("object");
    return obj;
  }
  return null;
}

/** Return the method name of a `foo.bar(...)` call, or null. */
function methodName(call: Parser.SyntaxNode): string | null {
  const fn = call.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return null;
  const prop = fn.childForFieldName("property");
  return prop?.text ?? null;
}

/** Strip a chain of `.refine(...)`, `.superRefine(...)`, `.passthrough(...)`,
 *  `.strict(...)`, `.strip(...)` calls to find the underlying z.object(...)
 *  call (or null if the chain does not end in one). */
function unwrapZodChain(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur && cur.type === "call_expression") {
    const name = methodName(cur);
    if (name == null) {
      // Not a member-call — could be the z.object(...) call itself.
      const fn = cur.childForFieldName("function");
      if (fn && fn.type === "member_expression") {
        const prop = fn.childForFieldName("property");
        if (prop?.text === "object") return cur;
      }
      return null;
    }
    if (name === "object") return cur;
    // Chainable modifier — step into receiver
    cur = receiverOfCall(cur);
  }
  return null;
}

/** Returns true if `call` is syntactically `z.object(...)`. */
function isZObjectCall(call: Parser.SyntaxNode): boolean {
  if (call.type !== "call_expression") return false;
  const fn = call.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return false;
  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  return obj?.text === "z" && prop?.text === "object";
}

/** Extract the keys of the object literal passed to a z.object({...}) call. */
function extractZodObjectFields(zCall: Parser.SyntaxNode): {
  fields: string[];
  fileFieldLine: number | null;
} {
  const fields: string[] = [];
  let fileFieldLine: number | null = null;
  const args = zCall.childForFieldName("arguments");
  if (!args) return { fields, fileFieldLine };
  const obj = args.namedChildren.find((n) => n.type === "object");
  if (!obj) return { fields, fileFieldLine };

  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const k = p.childForFieldName("key");
    const v = p.childForFieldName("value");
    if (!k) continue;
    const keyText = stripQuotes(k.text);
    fields.push(keyText);

    if (v) {
      // Walk the value looking for z.instanceof(File)
      let found = false;
      walkAll(v, (n) => {
        if (found) return;
        if (n.type !== "call_expression") return;
        const fn = n.childForFieldName("function");
        if (!fn || fn.type !== "member_expression") return;
        const zid = fn.childForFieldName("object");
        const prop = fn.childForFieldName("property");
        if (zid?.text !== "z" || prop?.text !== "instanceof") return;
        const a = n.childForFieldName("arguments");
        if (!a) return;
        const first = a.namedChildren[0];
        if (first && first.text === "File") {
          found = true;
          fileFieldLine = p.startPosition.row + 1;
        }
      });
    }
  }
  return { fields, fileFieldLine };
}

/** Walk a handler function body, returning true iff a `return` statement
 *  is found at the *direct* function level (not nested inside another
 *  function). This avoids flagging handlers whose only return lives inside
 *  a callback. */
function handlerHasTopLevelReturn(fn: Parser.SyntaxNode): boolean {
  const body = fn.childForFieldName("body");
  if (!body) return false;
  let found = false;
  function scan(n: Parser.SyntaxNode): void {
    if (found) return;
    if (n.type === "return_statement") { found = true; return; }
    // Do not descend into nested function/arrow/method definitions.
    if (
      n.type === "function_declaration" ||
      n.type === "function_expression" ||
      n.type === "arrow_function" ||
      n.type === "method_definition"
    ) {
      return;
    }
    for (const c of n.namedChildren) scan(c);
  }
  scan(body);
  // Arrow functions with an expression body (no block) are implicit returns.
  if (!found && body.type !== "statement_block") return true;
  return found;
}

// ---------------------------------------------------------------------------
// Parse src/actions/index.{ts,js,mjs}
// ---------------------------------------------------------------------------

interface ActionsFileExtraction {
  file: string;
  actions: ExtractedAction[];
}

async function parseActionsFile(
  root: string,
): Promise<ActionsFileExtraction | null> {
  let source: string | null = null;
  let relPath: string | null = null;
  for (const rel of ACTIONS_FILE_CANDIDATES) {
    try {
      source = readFileSync(join(root, rel), "utf-8");
      relPath = rel;
      break;
    } catch { /* next candidate */ }
  }
  if (source == null || relPath == null) return null;

  await initParser();
  const parser = await getParser(pickLang(relPath));
  if (!parser) return { file: relPath, actions: [] };

  let tree: Parser.Tree;
  try { tree = parser.parse(source); } catch { return { file: relPath, actions: [] }; }

  const actions: ExtractedAction[] = [];

  /** Handle a single `defineAction({...})` call with the action name bound. */
  function handleDefineAction(
    name: string,
    call: Parser.SyntaxNode,
  ): void {
    const args = call.childForFieldName("arguments");
    const obj = args?.namedChildren.find((n) => n.type === "object");
    const descriptor: ExtractedAction = {
      name,
      file: relPath!,
      line: call.startPosition.row + 1,
      has_input_schema: false,
      input_fields: [],
      handler_missing_return: false,
      refine_on_top_level: false,
      has_passthrough: false,
      has_file_field: false,
    };

    if (!obj) { actions.push(descriptor); return; }

    // --- accept ---
    const acceptNode = getProperty(obj, "accept");
    if (acceptNode && (acceptNode.type === "string")) {
      const val = stripQuotes(acceptNode.text);
      if (val === "json" || val === "form") descriptor.accept = val;
    }

    // --- input schema ---
    const inputNode = getProperty(obj, "input");
    if (inputNode) {
      descriptor.has_input_schema = true;

      // Top-level refine? If the *outer* expression is a call to `.refine`
      // on something whose innermost receiver is z.object({...}), flag it.
      if (inputNode.type === "call_expression") {
        const outerName = methodName(inputNode);
        if (outerName === "refine" || outerName === "superRefine") {
          const recv = receiverOfCall(inputNode);
          if (recv && recv.type === "call_expression" && isZObjectCall(recv)) {
            descriptor.refine_on_top_level = true;
            descriptor.refine_line = inputNode.startPosition.row + 1;
          }
        }
      }

      // Passthrough anywhere in the chain.
      walkAll(inputNode, (n) => {
        if (n.type !== "call_expression") return;
        const mn = methodName(n);
        if (mn === "passthrough") {
          descriptor.has_passthrough = true;
          descriptor.passthrough_line = n.startPosition.row + 1;
        }
      });

      // Resolve to an underlying z.object({...}) call to extract fields.
      const zObj = unwrapZodChain(inputNode);
      if (zObj) {
        const { fields, fileFieldLine } = extractZodObjectFields(zObj);
        descriptor.input_fields = fields;
        if (fileFieldLine != null) {
          descriptor.has_file_field = true;
          descriptor.file_field_line = fileFieldLine;
        }
      }
    }

    // --- handler ---
    const handlerNode = getProperty(obj, "handler");
    if (handlerNode && (
      handlerNode.type === "arrow_function" ||
      handlerNode.type === "function_expression" ||
      handlerNode.type === "function"
    )) {
      descriptor.handler_missing_return = !handlerHasTopLevelReturn(handlerNode);
    }

    actions.push(descriptor);
  }

  /** Recursively collect `defineAction({...})` calls under an assignment.
   *  Handles both `foo: defineAction({...})` in a server object literal and
   *  bare `defineAction({...})` calls bound to a named variable. */
  function collectUnder(name: string, node: Parser.SyntaxNode): void {
    walkAll(node, (n) => {
      if (n.type !== "call_expression") return;
      const fn = n.childForFieldName("function");
      if (!fn || fn.text !== "defineAction") return;
      // Skip nested defineAction inside another defineAction — the outer
      // traversal already produced its descriptor.
      handleDefineAction(name, n);
    });
  }

  // Walk top-level declarations. The canonical Astro shape is
  //   export const server = { foo: defineAction({...}), bar: defineAction({...}) }
  // but we also support
  //   export const foo = defineAction({...})
  walkAll(tree.rootNode, (node) => {
    if (node.type !== "variable_declarator") return;
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) return;

    // Case A: `const foo = defineAction({...})`
    if (valueNode.type === "call_expression") {
      const fn = valueNode.childForFieldName("function");
      if (fn?.text === "defineAction") {
        handleDefineAction(nameNode.text, valueNode);
        return;
      }
    }

    // Case B: `const server = { foo: defineAction({...}) }`
    if (valueNode.type === "object") {
      for (const p of valueNode.namedChildren) {
        if (p.type !== "pair") continue;
        const k = p.childForFieldName("key");
        const v = p.childForFieldName("value");
        if (!k || !v) continue;
        const actionName = stripQuotes(k.text);
        if (v.type === "call_expression") {
          const fn = v.childForFieldName("function");
          if (fn?.text === "defineAction") {
            handleDefineAction(actionName, v);
          }
        } else {
          // Nested one level — e.g. wrapped in a helper; still scan descendants.
          collectUnder(actionName, v);
        }
      }
    }
  });

  return { file: relPath, actions };
}

// ---------------------------------------------------------------------------
// Caller scan (AA05 + AA06)
// ---------------------------------------------------------------------------

interface CallerMatch {
  file: string;
  line: number;
  action: string;
  is_server_side: boolean;
  enclosing_line_context: string;
}

const ACTIONS_CALL_RE = /actions\.([A-Za-z_$][\w$]*)\s*\(/g;

/** Locate calls to `actions.<name>(` in source, returning their line and
 *  whether the call lives in a server-side context (Astro frontmatter). */
function findActionCalls(file: string, source: string): CallerMatch[] {
  const matches: CallerMatch[] = [];
  const isAstro = file.endsWith(".astro");
  let frontmatterEnd = -1;
  if (isAstro) {
    const fm = source.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (fm) frontmatterEnd = fm[0].length;
  }

  const lines = source.split("\n");
  ACTIONS_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACTIONS_CALL_RE.exec(source)) !== null) {
    const idx = m.index;
    const lineNum = source.slice(0, idx).split("\n").length;
    const lineText = lines[lineNum - 1] ?? "";
    // Server-side if we are inside Astro frontmatter.
    const isServerSide = isAstro && frontmatterEnd > 0 && idx < frontmatterEnd;
    matches.push({
      file,
      line: lineNum,
      action: m[1]!,
      is_server_side: isServerSide,
      enclosing_line_context: lineText.trim(),
    });
  }
  return matches;
}

/** Return the `<form ...>` opening tag that (textually) encloses the given
 *  offset, or null if none. Regex-based — good enough for audit heuristics. */
function findEnclosingFormTag(source: string, offset: number): string | null {
  const upTo = source.slice(0, offset);
  const lastOpen = upTo.lastIndexOf("<form");
  if (lastOpen === -1) return null;
  const afterOpen = source.slice(lastOpen);
  const firstClose = afterOpen.indexOf(">");
  if (firstClose === -1) return null;
  // Make sure a matching </form> exists after our offset.
  const closeTag = source.indexOf("</form>", offset);
  if (closeTag === -1) return null;
  return afterOpen.slice(0, firstClose + 1);
}

// ---------------------------------------------------------------------------
// Detector application
// ---------------------------------------------------------------------------

function issue(
  code: string,
  severity: ActionsAuditIssue["severity"],
  message: string,
  file: string,
  line: number,
  fix: string,
  action?: string,
): ActionsAuditIssue {
  const out: ActionsAuditIssue = { code, severity, message, file, line, fix };
  if (action) out.action = action;
  return out;
}

function computeScore(issues: ActionsAuditIssue[]): "A" | "B" | "C" | "D" {
  const e = issues.filter((i) => i.severity === "error").length;
  const w = issues.filter((i) => i.severity === "warning").length;
  if (e >= 3) return "D";
  if (e >= 1 || w >= 6) return "C";
  if (w >= 3) return "B";
  return "A";
}

// ---------------------------------------------------------------------------
// Testable core + MCP handler
// ---------------------------------------------------------------------------

export async function auditAstroActionsFromIndex(
  index: CodeIndex,
  severity?: "all" | "warnings" | "errors",
): Promise<ActionsAuditResult> {
  const parseResult = await parseActionsFile(index.root);

  if (!parseResult) {
    // No actions file: return empty result (still exposes the checked codes).
    return {
      actions: [],
      issues: [],
      anti_patterns_checked: ALL_CODES,
      summary: { total_actions: 0, total_issues: 0, score: "A" },
    };
  }

  const { file: actionsFile, actions: extracted } = parseResult;
  const issues: ActionsAuditIssue[] = [];
  const actionNameSet = new Set(extracted.map((a) => a.name));

  // --- AA01/AA02/AA03/AA04 pass (per-action) ---
  for (const act of extracted) {
    if (act.handler_missing_return) {
      issues.push(issue(
        "AA01",
        "error",
        `Action "${act.name}" handler never returns a value — callers will receive undefined`,
        actionsFile,
        act.line,
        "Return the handler result explicitly (e.g. `return { ok: true }`)",
        act.name,
      ));
    }

    if (act.refine_on_top_level) {
      issues.push(issue(
        "AA02",
        "error",
        `Action "${act.name}" input uses .refine() on top-level z.object() — Astro issue #11641 makes this silently fail`,
        actionsFile,
        act.refine_line ?? act.line,
        "Move .refine() inside a nested z.object() field, or validate inside the handler",
        act.name,
      ));
    }

    if (act.has_passthrough) {
      issues.push(issue(
        "AA03",
        "warning",
        `Action "${act.name}" uses .passthrough() — Astro strips extra fields regardless (issue #11693)`,
        actionsFile,
        act.passthrough_line ?? act.line,
        "Declare every expected field in the schema explicitly — .passthrough() is ignored by Astro Actions",
        act.name,
      ));
    }
  }

  // --- Build caller map (scan .astro / .tsx / .jsx files) ---
  const callerFiles = index.files.filter((f) => {
    const p = f.path;
    return p.endsWith(".astro") || p.endsWith(".tsx") || p.endsWith(".jsx");
  });

  // Per-action caller info for AA04
  type CallerInfo = { file: string; line: number; formTag: string | null; is_server_side: boolean };
  const callersByAction = new Map<string, CallerInfo[]>();

  for (const f of callerFiles) {
    let source: string;
    try { source = readFileSync(join(index.root, f.path), "utf-8"); } catch { continue; }

    const calls = findActionCalls(f.path, source);
    for (const call of calls) {
      // AA06: client-side call to unknown action (errors only on client
      // calls — server-side unknown refs are caught by AA05 anyway and we
      // don't want to double-flag).
      if (!actionNameSet.has(call.action)) {
        if (!call.is_server_side) {
          issues.push(issue(
            "AA06",
            "error",
            `Client-side code calls unknown action "${call.action}"`,
            call.file,
            call.line,
            `Define "${call.action}" in src/actions/index.ts or remove the call`,
            call.action,
          ));
        }
        continue;
      }

      // AA05: calling `actions.xxx()` from an .astro frontmatter is a
      // common mistake — on the server you should import the action
      // function directly.
      if (call.is_server_side) {
        issues.push(issue(
          "AA05",
          "warning",
          `Action "${call.action}" called from .astro frontmatter — prefer Astro.callAction() or a direct import`,
          call.file,
          call.line,
          `Use Astro.callAction(actions.${call.action}, input) in server code`,
          call.action,
        ));
      }

      // Track callers for AA04 follow-up (only client-side matters).
      if (!call.is_server_side) {
        // Locate byte offset of this call in source for form-tag lookup.
        const lines = source.split("\n");
        let offset = 0;
        for (let i = 0; i < call.line - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
        const formTag = findEnclosingFormTag(source, offset);
        const bucket = callersByAction.get(call.action) ?? [];
        bucket.push({ file: call.file, line: call.line, formTag, is_server_side: false });
        callersByAction.set(call.action, bucket);
      }
    }
  }

  // --- AA04 pass (file schema + caller form enctype) ---
  for (const act of extracted) {
    if (!act.has_file_field) continue;
    const callers = callersByAction.get(act.name) ?? [];
    for (const c of callers) {
      // If the caller sits inside a <form> tag, that tag must have
      // enctype="multipart/form-data". If there is no form tag at all, we
      // cannot reason about the caller and stay silent.
      if (c.formTag == null) continue;
      if (!/enctype\s*=\s*["']multipart\/form-data["']/i.test(c.formTag)) {
        issues.push(issue(
          "AA04",
          "error",
          `Action "${act.name}" expects a File but caller form lacks enctype="multipart/form-data"`,
          c.file,
          c.line,
          `Add enctype="multipart/form-data" to the <form> tag, or switch the schema off z.instanceof(File)`,
          act.name,
        ));
      }
    }
  }

  // --- Severity filter ---
  let filtered = issues;
  if (severity === "errors") filtered = issues.filter((i) => i.severity === "error");
  else if (severity === "warnings") filtered = issues.filter((i) => i.severity !== "info");

  const descriptors: ActionDescriptor[] = extracted.map((a) => {
    const d: ActionDescriptor = {
      name: a.name,
      file: a.file,
      line: a.line,
      has_input_schema: a.has_input_schema,
      input_fields: a.input_fields,
    };
    if (a.accept !== undefined) d.accept = a.accept;
    return d;
  });

  return {
    actions: descriptors,
    issues: filtered,
    anti_patterns_checked: ALL_CODES,
    summary: {
      total_actions: descriptors.length,
      total_issues: filtered.length,
      score: computeScore(filtered),
    },
  };
}

export async function astroActionsAudit(args: {
  repo?: string;
  severity?: "all" | "warnings" | "errors";
}): Promise<ActionsAuditResult> {
  const index = await getCodeIndex(args.repo ?? "");
  if (!index) {
    return {
      actions: [],
      issues: [],
      anti_patterns_checked: ALL_CODES,
      summary: { total_actions: 0, total_issues: 0, score: "A" },
    };
  }
  return auditAstroActionsFromIndex(index, args.severity);
}
