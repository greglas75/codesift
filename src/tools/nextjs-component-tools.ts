/**
 * Next.js component classifier: AST-based Server/Client component detection.
 *
 * Uses a two-stage directive detection strategy:
 *   1. Fast-reject: scan first 512 bytes for "use client"/"use server" substring
 *   2. AST confirm: verify directive is `Program.body[0]` ExpressionStatement
 *
 * Then walks the AST for client-component signals (hooks, JSX event handlers,
 * browser globals, `next/dynamic({ ssr: false })`) and classifies each file
 * per the 8-row decision table.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type Parser from "web-tree-sitter";
import { parseFile } from "../parser/parser-manager.js";
import { scanDirective } from "../utils/nextjs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComponentClassification =
  | "server"
  | "client_explicit" // has "use client" directive
  | "client_inferred" // no directive but uses hooks/events/browser APIs
  | "ambiguous";

export interface ComponentSignals {
  hooks: string[];
  event_handlers: string[];
  browser_globals: string[];
  dynamic_ssr_false: boolean;
}

export interface NextjsComponentEntry {
  path: string;
  classification: ComponentClassification;
  directive: "use client" | "use server" | null;
  signals: ComponentSignals;
  violations: string[];
}

export interface NextjsComponentsCounts {
  total: number;
  server: number;
  client_explicit: number;
  client_inferred: number;
  ambiguous: number;
  unnecessary_use_client: number;
}

export interface NextjsComponentsResult {
  files: NextjsComponentEntry[];
  counts: NextjsComponentsCounts;
  parse_failures: string[];
  scan_errors: string[];
  truncated: boolean;
  truncated_at?: number;
  workspaces_scanned: string[];
  limitations: string[];
}

export interface AnalyzeNextjsComponentsOptions {
  workspace?: string | undefined;
  file_pattern?: string | undefined;
  max_files?: number | undefined;
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

// ---------------------------------------------------------------------------
// Orchestrator (stub for Task 19)
// ---------------------------------------------------------------------------

/**
 * Analyze a Next.js repository for Server/Client component classification.
 * Stub — real implementation arrives in Task 23.
 */
export async function analyzeNextjsComponents(
  _repo: string,
  _options?: AnalyzeNextjsComponentsOptions,
): Promise<NextjsComponentsResult> {
  throw new Error("analyzeNextjsComponents: not implemented");
}
