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
 *
 * This file is the orchestrator. AST reader helpers (`applyClassificationTable`,
 * `detectSignals`, `confirmDirectiveFromTree`, `classifyFile`) live in
 * `nextjs-component-readers.ts` and are re-exported from here for backward
 * compatibility.
 */

import { readFile } from "node:fs/promises";
import { relative, join } from "node:path";
import { cachedParseFile as parseFile } from "../utils/nextjs-audit-cache.js";
import { scanDirective, discoverWorkspaces } from "../utils/nextjs.js";
import { cachedWalkDirectory as walkDirectory } from "../utils/nextjs-audit-cache.js";
import { getCodeIndex } from "./index-tools.js";
import {
  MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_FILES,
  PARSE_CONCURRENCY,
  applyClassificationTable,
  detectSignals,
  confirmDirectiveFromTree,
} from "./nextjs-component-readers.js";
import type {
  ComponentSignals,
  NextjsComponentEntry,
  NextjsComponentsCounts,
} from "./nextjs-component-readers.js";

// Re-export reader APIs so existing consumers continue to import from this file.
export {
  MAX_FILE_SIZE_BYTES,
  DEFAULT_MAX_FILES,
  PARSE_CONCURRENCY,
  CLIENT_HOOKS_EXCLUDE,
  EVENT_HANDLER_ATTRS,
  BROWSER_GLOBALS,
  HOOK_NAME_RE,
  applyClassificationTable,
  detectSignals,
  confirmDirectiveFromTree,
  classifyFile,
} from "./nextjs-component-readers.js";
export type {
  ComponentClassification,
  SignalLocation,
  ComponentSignals,
  NextjsComponentEntry,
  NextjsComponentsCounts,
} from "./nextjs-component-readers.js";

// ---------------------------------------------------------------------------
// Orchestrator-specific types
// ---------------------------------------------------------------------------

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
// Orchestrator
// ---------------------------------------------------------------------------

/** Extensions we consider candidates for classification. */
const COMPONENT_EXTS = new Set([".tsx", ".jsx"]);

/**
 * Analyze a Next.js repository for Server/Client component classification.
 *
 * Flow:
 *   1. Kill switch check (`CODESIFT_DISABLE_TOOLS`)
 *   2. Resolve project root via `getCodeIndex(repo).root`
 *   3. Determine workspaces: explicit `workspace` param, `discoverWorkspaces()`,
 *      or single root.
 *   4. For each workspace, walk `app/` for `.tsx`/`.jsx` files.
 *   5. Process in batches of `PARSE_CONCURRENCY` — for each file:
 *        a. `classifyFile` for directive
 *        b. `detectSignals` on the parsed tree (re-parses — acceptable for v1)
 *        c. `applyClassificationTable` to finalize classification + violations
 *   6. Aggregate counts; honor `max_files`.
 */
export async function analyzeNextjsComponents(
  repo: string,
  options?: AnalyzeNextjsComponentsOptions,
): Promise<NextjsComponentsResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("analyze_nextjs_components")) {
    throw new Error("analyze_nextjs_components is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  // Resolve workspaces
  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0
      ? discovered.map((w) => w.root)
      : [projectRoot];
  }

  const maxFiles = options?.max_files ?? DEFAULT_MAX_FILES;
  const files: NextjsComponentEntry[] = [];
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];
  let truncated = false;
  let truncated_at: number | undefined;

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);

    // Walk app/ and src/app/ subtrees
    const candidates: string[] = [];
    for (const appDir of ["app", "src/app"]) {
      const fullAppDir = join(workspace, appDir);
      try {
        const walked = await walkDirectory(fullAppDir, {
          followSymlinks: true,
          fileFilter: (ext) => COMPONENT_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        candidates.push(...walked);
      } catch (err) {
        scan_errors.push(`${fullAppDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Apply max_files cap across all workspaces
    const remaining = maxFiles - files.length;
    const toProcess = candidates.slice(0, Math.max(0, remaining));
    if (candidates.length > remaining) {
      truncated = true;
      truncated_at = maxFiles;
    }

    // Batch process with concurrency
    for (let i = 0; i < toProcess.length; i += PARSE_CONCURRENCY) {
      const chunk = toProcess.slice(i, i + PARSE_CONCURRENCY);
      const entries = await Promise.all(
        chunk.map(async (filePath) => {
          try {
            return await classifyAndDetect(filePath, projectRoot);
          } catch (err) {
            const rel = relative(projectRoot, filePath);
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const entry of entries) {
        if (entry === null) continue;
        if (entry.classification === "ambiguous") {
          parse_failures.push(entry.path);
        }
        files.push(entry);
      }
    }
  }

  // Aggregate counts
  const counts: NextjsComponentsCounts = {
    total: files.length,
    server: 0,
    client_explicit: 0,
    client_inferred: 0,
    ambiguous: 0,
    unnecessary_use_client: 0,
  };
  for (const f of files) {
    counts[f.classification]++;
    if (f.violations.includes("unnecessary_use_client")) {
      counts.unnecessary_use_client++;
    }
  }

  const result: NextjsComponentsResult = {
    files,
    counts,
    parse_failures,
    scan_errors,
    truncated,
    workspaces_scanned,
    limitations: ["no transitive client boundary detection via barrel files"],
  };
  if (truncated_at !== undefined) {
    result.truncated_at = truncated_at;
  }
  return result;
}

/**
 * Run classifyFile, then (if we got a usable tree) re-parse for signals and
 * run the classification table. Factored out to keep the orchestrator clean.
 */
async function classifyAndDetect(
  filePath: string,
  repoRoot: string,
): Promise<NextjsComponentEntry> {
  const relPath = relative(repoRoot, filePath);
  const emptySig: ComponentSignals = {
    hooks: [],
    event_handlers: [],
    browser_globals: [],
    dynamic_ssr_false: false,
    signal_locations: [],
  };

  const directive = await scanDirective(filePath);

  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    return {
      path: relPath,
      classification: "ambiguous",
      directive: null,
      signals: emptySig,
      violations: [],
    };
  }

  const tree = await parseFile(filePath, source);
  if (!tree) {
    return {
      path: relPath,
      classification: "ambiguous",
      directive: null,
      signals: emptySig,
      violations: [],
    };
  }

  // Confirm directive via AST
  const confirmedDirective = directive !== null
    ? confirmDirectiveFromTree(tree)
    : null;

  const signals = detectSignals(tree, source);
  const { classification, violations } = applyClassificationTable(confirmedDirective, signals);

  // Q1 — populate actionable suggested_fix for remediable states.
  let suggested_fix: string | undefined;
  if (violations.includes("unnecessary_use_client")) {
    suggested_fix = "Remove 'use client' directive (no client signals detected)";
  } else if (classification === "client_inferred") {
    suggested_fix = "Add 'use client' directive at top of file";
  }

  const entry: NextjsComponentEntry = {
    path: relPath,
    classification,
    directive: confirmedDirective,
    signals,
    violations,
  };
  if (suggested_fix !== undefined) {
    entry.suggested_fix = suggested_fix;
  }
  return entry;
}
