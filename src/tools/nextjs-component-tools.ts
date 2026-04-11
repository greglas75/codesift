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
