/**
 * find_dead_hono_routes — heuristically flags server routes that are not
 * called by any Hono RPC client (`hc<AppType>(...).segment.$method(...)`)
 * in the repo. Useful in monorepos with colocated server + client code
 * during refactors: you can delete server routes that no client touches.
 *
 * HEURISTIC — best-effort. Does not follow dynamic path construction,
 * does not understand route aliases. Documented via `note` in the result;
 * callers should review before deleting.
 *
 * Spec: docs/specs/2026-04-11-hono-phase-2-plan.md (T12)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { walkDirectory } from "../utils/walk.js";

export interface DeadRouteFinding {
  route: string;
  file: string;
  line: number;
  reason: "no_rpc_client_caller_found";
}

export interface DeadRoutesResult {
  findings?: DeadRouteFinding[];
  total?: number;
  note?: string;
  error?: string;
}

const HEURISTIC_NOTE =
  "Heuristic grep-based scan. Flags routes whose path segments do not appear in any non-server .ts/.tsx/.js/.jsx source. False negatives are possible for dynamically-constructed paths; false positives are possible when route segments appear in unrelated code. Review before deleting.";

export async function findDeadHonoRoutes(
  repo: string,
): Promise<DeadRoutesResult> {
  const index = await getCodeIndex(repo);
  if (!index) return { error: `Repository "${repo}" not found` };

  const frameworks = detectFrameworks(index);
  if (!frameworks.has("hono")) return { error: "No Hono app detected" };

  const entryFile = resolveHonoEntryFile(index);
  if (!entryFile) return { error: "No Hono app entry file found" };

  let model;
  try {
    model = await honoCache.get(repo, entryFile, new HonoExtractor());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to parse: ${msg}` };
  }

  // Candidate client files: every .ts/.tsx/.js/.jsx in the repo that the
  // server parse didn't touch. Walk the filesystem directly — the symbol
  // index may not include every TS file (e.g., client-only stubs), and
  // we want full coverage of user code. Both sides are canonicalized via
  // realpath because model.files_used comes from HonoExtractor.canonicalize
  // while walkDirectory returns the raw path (mismatched on macOS where
  // /tmp is a symlink to /private/tmp).
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const serverFiles = new Set(model.files_used.map(canon));
  const allTsFiles = await walkDirectory(index.root, {
    fileFilter: (ext) => /\.(tsx?|jsx?)$/.test(ext),
  });
  const candidateFiles = allTsFiles
    .map(canon)
    .filter((f) => !serverFiles.has(f));

  const clientContents: string[] = [];
  for (const file of candidateFiles) {
    try {
      clientContents.push(await readFile(file, "utf-8"));
    } catch {
      // skip unreadable
    }
  }
  const joined = clientContents.join("\n");

  const findings: DeadRouteFinding[] = [];
  for (const route of model.routes) {
    // Extract significant segments (non-parameter, non-empty) from the path.
    // `/api/users/:id` → ["api", "users"]
    // `/:id` → []  (fully-dynamic path — can't reliably detect usage, skip)
    const significantSegments = route.path
      .split("/")
      .filter((s) => s.length > 0 && !s.startsWith(":"));
    if (significantSegments.length === 0) continue;

    // "Used" = every significant segment appears somewhere in the joined
    // candidate source. Loose on purpose — we want high recall (fewer false
    // positives of "this is dead") at the cost of false negatives.
    const allSegmentsPresent = significantSegments.every((seg) =>
      joined.includes(seg),
    );
    if (allSegmentsPresent) continue;

    findings.push({
      route: `${route.method} ${route.path}`,
      file: relative(index.root, route.file),
      line: route.line,
      reason: "no_rpc_client_caller_found",
    });
  }

  return {
    findings,
    total: findings.length,
    note: HEURISTIC_NOTE,
  };
}

function resolveHonoEntryFile(index: {
  symbols: Array<{ source?: string | undefined; file: string }>;
  root: string;
}): string | null {
  for (const sym of index.symbols) {
    if (sym.source && /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(sym.source)) {
      return join(index.root, sym.file);
    }
  }
  return null;
}
