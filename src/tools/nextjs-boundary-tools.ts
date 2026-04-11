/**
 * Next.js client boundary analyzer (T4).
 *
 * Walks `app/**\/*.{tsx,jsx}` files marked with `"use client"` and computes
 * a deterministic ranking score per file from cheap signals (LOC, import
 * counts, dynamic imports, third-party imports). Per design D5 the score
 * is signal-based — no actual bundle bytes are estimated.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type Parser from "web-tree-sitter";
import { discoverWorkspaces, scanDirective } from "../utils/nextjs.js";
import { cachedParseFile as parseFile } from "../utils/nextjs-audit-cache.js";
import { cachedWalkDirectory as walkDirectory } from "../utils/nextjs-audit-cache.js";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComponentSignals {
  loc: number;
  import_count: number;
  dynamic_import_count: number;
  third_party_imports: string[];
}

export interface BoundaryEntry {
  rank: number;
  path: string;
  signals: ComponentSignals;
  score: number;
}

export interface NextjsBoundaryResult {
  entries: BoundaryEntry[];
  client_count: number;
  total_client_loc: number;
  largest_offender: BoundaryEntry | null;
  workspaces_scanned: string[];
  parse_failures: string[];
  scan_errors: string[];
  limitations: string[];
}

export interface NextjsBoundaryOptions {
  workspace?: string | undefined;
  top_n?: number | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers (Tasks 27, 28)
// ---------------------------------------------------------------------------

function isLocalImport(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("@/") || spec.startsWith("~/");
}

export function extractComponentSignals(
  _filePath: string,
  source: string,
  tree: Parser.Tree,
): ComponentSignals {
  const loc = source.split("\n").length;
  let import_count = 0;
  let dynamic_import_count = 0;
  const third_party = new Set<string>();

  const root = tree.rootNode;
  for (const imp of root.descendantsOfType("import_statement")) {
    import_count++;
    // The module source is a string literal child
    for (const child of imp.namedChildren) {
      if (child.type === "string") {
        const frag = child.namedChildren.find((c) => c.type === "string_fragment");
        const text = frag?.text ?? child.text.slice(1, -1);
        if (!isLocalImport(text)) {
          third_party.add(text);
        }
      }
    }
  }

  // Walk for dynamic(...) calls (next/dynamic) — treat as proxy for code-split modules.
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function") ?? call.namedChild(0);
    if (fn?.type === "identifier" && fn.text === "dynamic") {
      dynamic_import_count++;
    }
  }

  return {
    loc,
    import_count,
    dynamic_import_count,
    third_party_imports: [...third_party],
  };
}

export function rankingScore(signals: ComponentSignals): number {
  // Formula per D5: loc + (imports * 20) + (dynamic * -30) + (third_party * 15)
  return (
    signals.loc +
    signals.import_count * 20 +
    signals.dynamic_import_count * -30 +
    signals.third_party_imports.length * 15
  );
}

// ---------------------------------------------------------------------------
// Orchestrator (Task 29)
// ---------------------------------------------------------------------------

const COMPONENT_EXTS = new Set([".tsx", ".jsx"]);
const PARSE_CONCURRENCY = 10;
const MAX_FILE_SIZE_BYTES = 2_097_152;
const DEFAULT_TOP_N = 20;

export async function nextjsBoundaryAnalyzer(
  repo: string,
  options?: NextjsBoundaryOptions,
): Promise<NextjsBoundaryResult> {
  if (process.env.CODESIFT_DISABLE_TOOLS?.includes("nextjs_boundary_analyzer")) {
    throw new Error("nextjs_boundary_analyzer is disabled via CODESIFT_DISABLE_TOOLS");
  }

  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}. Run index_folder first.`);
  }
  const projectRoot = index.root;

  let workspaces: string[];
  if (options?.workspace) {
    workspaces = [join(projectRoot, options.workspace)];
  } else {
    const discovered = await discoverWorkspaces(projectRoot);
    workspaces = discovered.length > 0 ? discovered.map((w) => w.root) : [projectRoot];
  }

  const top_n = options?.top_n ?? DEFAULT_TOP_N;
  const allEntries: BoundaryEntry[] = [];
  const parse_failures: string[] = [];
  const scan_errors: string[] = [];
  const workspaces_scanned: string[] = [];

  for (const workspace of workspaces) {
    workspaces_scanned.push(workspace);
    const candidates: string[] = [];
    for (const dir of ["app", "src/app"]) {
      const fullDir = join(workspace, dir);
      try {
        const walked = await walkDirectory(fullDir, {
          followSymlinks: true,
          fileFilter: (ext) => COMPONENT_EXTS.has(ext),
          maxFileSize: MAX_FILE_SIZE_BYTES,
        });
        candidates.push(...walked);
      } catch (err) {
        scan_errors.push(`${fullDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (let i = 0; i < candidates.length; i += PARSE_CONCURRENCY) {
      const chunk = candidates.slice(i, i + PARSE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (filePath) => {
          const rel = relative(projectRoot, filePath);
          try {
            const directive = await scanDirective(filePath);
            if (directive !== "use client") return null;
            const source = await readFile(filePath, "utf8");
            const tree = await parseFile(filePath, source);
            if (!tree) {
              parse_failures.push(rel);
              return null;
            }
            const signals = extractComponentSignals(rel, source, tree);
            const score = rankingScore(signals);
            return { rank: 0, path: rel, signals, score } satisfies BoundaryEntry;
          } catch (err) {
            parse_failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      for (const r of results) if (r) allEntries.push(r);
    }
  }

  allEntries.sort((a, b) => b.score - a.score);
  const top = allEntries.slice(0, top_n).map((e, i) => ({ ...e, rank: i + 1 }));

  const total_client_loc = allEntries.reduce((sum, e) => sum + e.signals.loc, 0);

  return {
    entries: top,
    client_count: allEntries.length,
    total_client_loc,
    largest_offender: top[0] ?? null,
    workspaces_scanned,
    parse_failures,
    scan_errors,
    limitations: [
      "score is signal-based — no actual bundle bytes estimated",
      "transitive client boundaries via barrel files not detected",
    ],
  };
}
