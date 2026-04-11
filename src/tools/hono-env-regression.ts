/**
 * detect_middleware_env_regression — static check for the Issue #3587 pattern:
 * in a chain of 3+ middleware, intermediate entries declared with plain
 * `createMiddleware(...)` (no Env generic) reset the accumulated Env type
 * back to BlankEnv. Downstream middleware then can't see the custom bindings.
 *
 * Best-effort heuristic — regex over middleware declaration files, not a
 * real type checker. Flags candidates for manual review rather than hard
 * assertions, and documents this in the result `note` field.
 *
 * Spec: docs/specs/2026-04-11-hono-phase-2-plan.md (T10)
 */

import { getCodeIndex } from "./index-tools.js";
import { honoCache } from "../cache/hono-cache.js";
import { HonoExtractor } from "../parser/extractors/hono.js";
import { resolveHonoEntryFile } from "./hono-entry-resolver.js";
import { detectFrameworks } from "../utils/framework-detect.js";
import { join, dirname, resolve as pathResolve } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface EnvRegressionFinding {
  chain_scope: string;
  chain_length: number;
  middleware_name: string;
  file: string;
  /** First line in the file where the plain createMiddleware( call occurs. */
  line: number;
  reason: "plain_createMiddleware_no_generic";
}

export interface EnvRegressionResult {
  findings?: EnvRegressionFinding[];
  total?: number;
  note?: string;
  error?: string;
}

const HEURISTIC_NOTE =
  "Heuristic regex scan; false positives possible when middleware factories wrap createMiddleware or re-export it under a different name. Review each finding before typing changes.";

/**
 * Regex explanation:
 *   \bcreateMiddleware   → word-boundary before the token
 *   (?!\s*<)             → negative lookahead — NOT followed by `<` (generic arg)
 *   \s*\(                → open paren of the call
 *
 * Matches:  createMiddleware(async (c, next) => ...)
 *           createMiddleware  (async (c, next) => ...)
 * Does not match:  createMiddleware<AppEnv>(...)
 *                  createMiddleware< { Bindings: ... } >(...)
 */
const PLAIN_CREATE_MIDDLEWARE = /\bcreateMiddleware(?!\s*<)\s*\(/g;

export async function detectMiddlewareEnvRegression(
  repo: string,
): Promise<EnvRegressionResult> {
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

  const findings: EnvRegressionFinding[] = [];
  // Cache file scans so a middleware file shared across chains is only read once.
  const fileScanCache = new Map<string, Array<{ line: number }>>();

  for (const chain of model.middleware_chains) {
    if (chain.entries.length < 3) continue;
    // Intermediate entries: exclude first + last (those are endpoints of the chain).
    // We only suspect regression on entries that sit between custom-typed middleware.
    const intermediates = chain.entries.slice(1, -1);
    for (const entry of intermediates) {
      if (entry.is_third_party) continue;
      if (entry.inline) continue;
      // Resolve the DEFINITION file — entry.file is the caller (app.use site).
      // If the entry was imported from a relative path, resolve it; otherwise
      // fall back to scanning the caller file (local definitions).
      const definitionFile = resolveDefinitionFile(entry.file, entry.imported_from);
      if (!definitionFile) continue;
      let hits = fileScanCache.get(definitionFile);
      if (!hits) {
        hits = await scanFileForPlainCreateMiddleware(definitionFile);
        fileScanCache.set(definitionFile, hits);
      }
      if (hits.length === 0) continue;
      // Report the first hit — a file may contain many, but the chain-level
      // signal is "this middleware file has at least one regression candidate".
      const first = hits[0];
      if (!first) continue;
      findings.push({
        chain_scope: chain.scope,
        chain_length: chain.entries.length,
        middleware_name: entry.name,
        file: definitionFile,
        line: first.line,
        reason: "plain_createMiddleware_no_generic",
      });
    }
  }

  return {
    findings,
    total: findings.length,
    note: HEURISTIC_NOTE,
  };
}

/**
 * Resolve the file that defines a middleware based on the caller file and
 * the optional import specifier. Returns the absolute path, or null if the
 * import specifier is third-party (bare module) or can't be resolved on disk.
 */
function resolveDefinitionFile(
  callerFile: string,
  importSpec: string | undefined,
): string | null {
  if (!importSpec) {
    // No import record — middleware is defined in the same file as the caller.
    return existsSync(callerFile) ? callerFile : null;
  }
  if (!importSpec.startsWith(".")) {
    // Bare module specifier — third-party, nothing to scan.
    return null;
  }
  const base = pathResolve(dirname(callerFile), importSpec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
    join(base, "index.jsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function scanFileForPlainCreateMiddleware(
  file: string,
): Promise<Array<{ line: number }>> {
  let source: string;
  try {
    source = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  const hits: Array<{ line: number }> = [];
  // Reset regex state per scan (global flag retains lastIndex).
  PLAIN_CREATE_MIDDLEWARE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLAIN_CREATE_MIDDLEWARE.exec(source)) !== null) {
    const line = source.slice(0, m.index).split("\n").length;
    hits.push({ line });
  }
  return hits;
}