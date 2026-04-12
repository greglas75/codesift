/**
 * Next.js component classifier readers: directive detection, signal walking,
 * per-file classification logic, and the decision table.
 *
 * These readers are pure helpers with no orchestration logic. They are used by
 * `nextjs-component-tools.ts` (orchestrator) and re-exported from it for
 * backward compatibility with existing consumers and tests. Split follows the
 * T2/T3 reader + orchestrator precedent.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type Parser from "web-tree-sitter";
import { cachedParseFile as parseFile } from "../utils/nextjs-audit-cache.js";
import { scanDirective } from "../utils/nextjs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComponentClassification =
  | "server"
  | "client_explicit" // has "use client" directive
  | "client_inferred" // no directive but uses hooks/events/browser APIs
  | "ambiguous";

export interface SignalLocation {
  name: string;
  line: number;
  column: number;
}

export interface ComponentSignals {
  hooks: string[];
  event_handlers: string[];
  browser_globals: string[];
  dynamic_ssr_false: boolean;
  /**
   * Precise source locations for each detected signal. Agents use this to
   * jump directly to the fix site without re-parsing the file. Populated
   * for hooks, event_handlers, and browser_globals. dynamic_ssr_false is
   * file-level so no location is tracked.
   */
  signal_locations: SignalLocation[];
}

export interface NextjsComponentEntry {
  path: string;
  classification: ComponentClassification;
  directive: "use client" | "use server" | null;
  signals: ComponentSignals;
  violations: string[];
  /**
   * Actionable remediation text for classification violations.
   * Set when the entry has `unnecessary_use_client` violation or
   * `client_inferred` classification; omitted otherwise.
   */
  suggested_fix?: string;
}

export interface NextjsComponentsCounts {
  total: number;
  server: number;
  client_explicit: number;
  client_inferred: number;
  ambiguous: number;
  unnecessary_use_client: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE_BYTES = 2_097_152; // 2 MB hard cap per file
export const DEFAULT_MAX_FILES = 2000;
export const PARSE_CONCURRENCY = 10;

/** Hooks that are server-safe (or SSR-safe) and don't imply client component. */
export const CLIENT_HOOKS_EXCLUDE = new Set<string>(["useId"]);

/** JSX event attributes that imply client component. */
export const EVENT_HANDLER_ATTRS = new Set<string>([
  "onClick", "onChange", "onSubmit", "onInput", "onFocus", "onBlur",
  "onKeyDown", "onKeyUp", "onKeyPress",
  "onMouseDown", "onMouseUp", "onMouseMove", "onMouseEnter", "onMouseLeave", "onMouseOver", "onMouseOut",
  "onTouchStart", "onTouchEnd", "onTouchMove",
  "onDrag", "onDrop", "onDragOver", "onDragEnd", "onDragStart", "onDragLeave", "onDragEnter",
  "onScroll", "onWheel",
  "onAnimationStart", "onAnimationEnd", "onTransitionEnd",
  "onLoad", "onError",
  "onCopy", "onCut", "onPaste",
]);

/** Browser-only globals (detected in MemberExpressions like `window.foo`). */
export const BROWSER_GLOBALS = new Set<string>([
  "window", "document", "localStorage", "sessionStorage",
  "navigator", "location", "history",
]);

export const HOOK_NAME_RE = /^use[A-Z]\w*$/;

// ---------------------------------------------------------------------------
// Classification decision table
// ---------------------------------------------------------------------------

/**
 * Pure decision table for component classification. No I/O, no AST access.
 *
 * Rules (in priority order):
 *   - directive === "use client":
 *       has any signal     -> client_explicit
 *       no signals         -> client_explicit + violation "unnecessary_use_client"
 *   - directive === "use server" -> server
 *   - directive === null:
 *       has any signal     -> client_inferred
 *       no signals         -> server
 */
export function applyClassificationTable(
  directive: "use client" | "use server" | null,
  signals: ComponentSignals,
): { classification: ComponentClassification; violations: string[] } {
  const hasAnySignal =
    signals.hooks.length > 0 ||
    signals.event_handlers.length > 0 ||
    signals.browser_globals.length > 0 ||
    signals.dynamic_ssr_false;

  if (directive === "use client") {
    return {
      classification: "client_explicit",
      violations: hasAnySignal ? [] : ["unnecessary_use_client"],
    };
  }
  if (directive === "use server") {
    return { classification: "server", violations: [] };
  }
  // directive === null
  return {
    classification: hasAnySignal ? "client_inferred" : "server",
    violations: [],
  };
}

// ---------------------------------------------------------------------------
// Signal detection (hooks, JSX event handlers, browser globals, next/dynamic)
// ---------------------------------------------------------------------------

/**
 * Walk the AST to collect client-component signals:
 *   - hooks    — call_expression whose callee identifier matches /^use[A-Z]/
 *   - events   — jsx_attribute property_identifier in EVENT_HANDLER_ATTRS
 *   - globals  — member_expression object identifier in BROWSER_GLOBALS
 *   - next/dynamic({ ssr: false }) — import from "next/dynamic" + call with ssr:false
 */
export function detectSignals(
  tree: Parser.Tree,
  _source: string,
): ComponentSignals {
  const hooks = new Set<string>();
  const event_handlers = new Set<string>();
  const browser_globals = new Set<string>();
  const signal_locations: SignalLocation[] = [];
  let dynamic_ssr_false = false;

  const root = tree.rootNode;

  // Hooks: call_expression with identifier callee matching /^use[A-Z]/
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function") ?? call.namedChild(0);
    if (fn?.type === "identifier") {
      const name = fn.text;
      if (HOOK_NAME_RE.test(name) && !CLIENT_HOOKS_EXCLUDE.has(name)) {
        hooks.add(name);
        signal_locations.push({
          name,
          line: fn.startPosition.row + 1,
          column: fn.startPosition.column + 1,
        });
      }
    }
  }

  // JSX event handlers
  for (const attr of root.descendantsOfType("jsx_attribute")) {
    const nameNode = attr.namedChild(0);
    if (nameNode?.type === "property_identifier" || nameNode?.type === "identifier") {
      const name = nameNode.text;
      if (EVENT_HANDLER_ATTRS.has(name)) {
        event_handlers.add(name);
        signal_locations.push({
          name,
          line: nameNode.startPosition.row + 1,
          column: nameNode.startPosition.column + 1,
        });
      }
    }
  }

  // Browser globals via member_expression (e.g. window.location)
  for (const mem of root.descendantsOfType("member_expression")) {
    const obj = mem.childForFieldName("object") ?? mem.namedChild(0);
    if (obj?.type === "identifier" && BROWSER_GLOBALS.has(obj.text)) {
      browser_globals.add(obj.text);
      signal_locations.push({
        name: obj.text,
        line: obj.startPosition.row + 1,
        column: obj.startPosition.column + 1,
      });
    }
  }

  // next/dynamic with { ssr: false }
  // Only trust if there's an import from "next/dynamic". We then look for any
  // call expression with second argument containing { ssr: false }.
  const importsNextDynamic = root
    .descendantsOfType("import_statement")
    .some((imp) => {
      // The module source is a direct string child of import_statement
      for (const child of imp.namedChildren) {
        if (child.type === "string") {
          const frag = child.namedChild(0);
          const text = frag?.type === "string_fragment" ? frag.text : child.text.slice(1, -1);
          if (text === "next/dynamic") return true;
        }
      }
      return false;
    });

  if (importsNextDynamic) {
    for (const call of root.descendantsOfType("call_expression")) {
      const fn = call.childForFieldName("function") ?? call.namedChild(0);
      if (fn?.type !== "identifier" || fn.text !== "dynamic") continue;

      const args = call.childForFieldName("arguments") ?? call.namedChild(1);
      if (!args) continue;

      // Find the second argument (an object with ssr: false)
      const argChildren = args.namedChildren;
      if (argChildren.length < 2) continue;
      const opts = argChildren[1];
      if (!opts || opts.type !== "object") continue;

      // Iterate pairs that are direct named children of the options object.
      for (const pair of opts.namedChildren) {
        if (pair.type !== "pair") continue;
        const key = pair.childForFieldName("key") ?? pair.namedChild(0);
        if (!key) continue;
        const keyText = key.type === "property_identifier" || key.type === "identifier"
          ? key.text
          : key.type === "string"
            ? key.text.slice(1, -1)
            : null;
        if (keyText !== "ssr") continue;

        const value = pair.childForFieldName("value") ?? pair.namedChild(1);
        if (value?.type === "false") {
          dynamic_ssr_false = true;
          break;
        }
      }
    }
  }

  return {
    hooks: [...hooks],
    event_handlers: [...event_handlers],
    browser_globals: [...browser_globals],
    dynamic_ssr_false,
    signal_locations,
  };
}

// ---------------------------------------------------------------------------
// Two-stage directive detection
// ---------------------------------------------------------------------------

/**
 * Confirm a file-level directive by inspecting `Program.body[0]`.
 *
 * Tree-sitter's tsx/typescript grammars expose top-level directive strings as
 * an `expression_statement` whose first named child is a `string` literal
 * (a `"use client"` or `"use server"` token). Any other shape — including a
 * nested block, inline comment, or non-first statement — must return `null`.
 */
export function confirmDirectiveFromTree(
  tree: Parser.Tree,
): "use client" | "use server" | null {
  const root = tree.rootNode;
  const first = root.namedChildren[0];
  if (!first) return null;
  if (first.type !== "expression_statement") return null;

  const exprChild = first.namedChildren[0];
  if (!exprChild) return null;
  if (exprChild.type !== "string") return null;

  // tree-sitter `string` nodes have fragment children containing the text
  // between the quotes. Strip the surrounding quotes via .text and compare.
  const raw = exprChild.text;
  if (raw.length < 3) return null;
  const inner = raw.slice(1, -1);
  if (inner === "use client") return "use client";
  if (inner === "use server") return "use server";
  return null;
}

/**
 * Classify a single file. Returns a partial entry with the directive field
 * populated. Signal detection + final classification are added by the
 * orchestrator (Task 23) via `detectSignals` (Task 21) and
 * `applyClassificationTable` (Task 22).
 */
export async function classifyFile(
  filePath: string,
  repoRoot: string,
): Promise<NextjsComponentEntry> {
  const relPath = relative(repoRoot, filePath);
  const emptySignals: ComponentSignals = {
    hooks: [],
    event_handlers: [],
    browser_globals: [],
    dynamic_ssr_false: false,
  };

  // Stage 1: fast-reject via 512-byte window
  const stage1 = await scanDirective(filePath);

  // Stage 2: parse file via tree-sitter
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    return {
      path: relPath,
      classification: "ambiguous",
      directive: null,
      signals: emptySignals,
      violations: [],
    };
  }

  const tree = await parseFile(filePath, source);
  if (!tree) {
    return {
      path: relPath,
      classification: "ambiguous",
      directive: null,
      signals: emptySignals,
      violations: [],
    };
  }

  // Stage 3: confirm directive via AST (only if stage 1 matched)
  let directive: "use client" | "use server" | null = null;
  if (stage1 !== null) {
    directive = confirmDirectiveFromTree(tree);
  }

  // Note: signal detection and final classification are layered in by
  // Tasks 21-23. For now we return a stub classification — the orchestrator
  // rebuilds this via detectSignals + applyClassificationTable.
  return {
    path: relPath,
    classification: directive === "use client" ? "client_explicit" : "server",
    directive,
    signals: emptySignals,
    violations: [],
  };
}
