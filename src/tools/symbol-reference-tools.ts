import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findReferencesLsp } from "../lsp/lsp-tools.js";
import type { Reference } from "../types.js";
import {
  isNoisePath,
  MAX_CONTEXT_LENGTH,
  MAX_REFERENCES,
  requireCodeIndex,
  wordBoundaryPattern,
} from "./symbol-tool-internals.js";

/**
 * What a reference scan actually looked at.
 *
 * `find_references` returning `[]` is the input to "nobody uses this, safe to rename or delete".
 * That inference is only valid if the scan saw everywhere a reference could be. It routinely does
 * not: generated and vendored paths are skipped by default, files can be unreadable, and per
 * symbol the collection stops at MAX_REFERENCES. None of that was visible in the result.
 *
 * Filled through a caller-supplied sink so the `Record<string, Reference[]>` return shape — which
 * several call sites slice and re-key — stays untouched.
 */
export interface ReferenceScanCoverage {
  /** `unknown` is the honest default when the scan did not report — never assume `complete`. */
  status: "complete" | "partial" | "unknown";
  files_indexed: number;
  files_scanned: number;
  /** Generated/vendored paths skipped because no file_pattern was given. */
  files_skipped_noise?: number;
  files_unreadable?: number;
  /** Symbols whose reference list hit MAX_REFERENCES — their counts are floors, not totals. */
  capped_symbols?: string[];
  detail?: string;
}

export interface ReferenceScanSink {
  coverage?: ReferenceScanCoverage;
}

/**
 * Batch find references for multiple symbols in one pass.
 * Reads each file once instead of N times — critical for large repos.
 */
export async function findReferencesBatch(
  repo: string,
  symbolNames: string[],
  filePattern?: string,
  sink?: ReferenceScanSink,
): Promise<Record<string, Reference[]>> {
  const index = await requireCodeIndex(repo);
  const patterns = symbolNames.map((name) => ({
    name,
    regex: wordBoundaryPattern(name),
  }));

  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const result: Record<string, Reference[]> = {};
  for (const name of symbolNames) result[name] = [];

  let filesScanned = 0;
  let filesSkippedNoise = 0;
  let filesUnreadable = 0;

  for (const fileEntry of index.files) {
    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;
    if (!filePattern && isNoisePath(fileEntry.path)) {
      // Sensible default — but it means "no references" really means "none outside generated
      // and vendored code", and the caller could not tell that scoping had happened.
      filesSkippedNoise++;
      continue;
    }

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
      filesScanned++;
    } catch {
      // A reference living only in a file we could not read is invisible here, and the symbol
      // then looks unused.
      filesUnreadable++;
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      for (const { name, regex } of patterns) {
        const refs = result[name]!;
        if (refs.length >= MAX_REFERENCES) continue;
        const match = regex.exec(line);
        if (match) {
          const rawContext = line.trimEnd();
          refs.push({
            file: fileEntry.path,
            line: i + 1,
            col: match.index + 1,
            context: rawContext.length > MAX_CONTEXT_LENGTH
              ? rawContext.slice(0, MAX_CONTEXT_LENGTH) + "..."
              : rawContext,
          });
        }
      }
    }
  }

  if (sink) {
    const capped = symbolNames.filter((n) => (result[n]?.length ?? 0) >= MAX_REFERENCES);
    const complete = filesSkippedNoise === 0 && filesUnreadable === 0 && capped.length === 0;
    const reasons: string[] = [];
    if (filesSkippedNoise > 0) {
      reasons.push(`${filesSkippedNoise} generated/vendored files skipped (pass file_pattern to include them)`);
    }
    if (filesUnreadable > 0) reasons.push(`${filesUnreadable} files could not be read`);
    if (capped.length > 0) reasons.push(`${capped.length} symbol(s) hit the ${MAX_REFERENCES}-reference cap`);
    sink.coverage = {
      status: complete ? "complete" : "partial",
      files_indexed: index.files.length,
      files_scanned: filesScanned,
      ...(filesSkippedNoise > 0 ? { files_skipped_noise: filesSkippedNoise } : {}),
      ...(filesUnreadable > 0 ? { files_unreadable: filesUnreadable } : {}),
      ...(capped.length > 0 ? { capped_symbols: capped } : {}),
      ...(complete
        ? {}
        : {
            detail:
              `${reasons.join("; ")} — an empty or short result is about what was scanned, ` +
              `not proof the symbol is unused`,
          }),
    };
  }

  return result;
}

const SEARCH_TIMEOUT_MS = 30_000;

/** Directories to exclude from ripgrep reference search */
const RG_EXCLUDE_DIRS = [
  "node_modules", ".git", ".next", "dist", ".codesift", "coverage",
  ".playwright-mcp", "__pycache__", "__snapshots__",
];

/** Detect whether `rg` (ripgrep) is available. Cached at module level. */
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/**
 * Find references using ripgrep with word-boundary matching.
 * Returns compact `file:line: context` string when results ≤ threshold.
 */
function findReferencesWithRipgrep(
  root: string,
  symbolName: string,
  maxResults: number,
  filePattern?: string,
): Reference[] | string {
  const args: string[] = [
    "-n", "--no-heading", "-w",
    "--max-columns", String(MAX_CONTEXT_LENGTH),
    "--max-columns-preview",
    "--max-count", String(Math.min(maxResults * 2, 5000)),
  ];

  // Exclude noise dirs
  for (const dir of RG_EXCLUDE_DIRS) {
    args.push("--glob", `!${dir}`);
  }
  // Exclude noise extensions
  for (const ext of [".snap", ".lock", ".map", ".svg", ".png", ".jpg", ".ico", ".woff", ".woff2", ".md", ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".html"]) {
    args.push("--glob", `!*${ext}`);
  }

  if (filePattern) {
    args.push("--glob", filePattern);
  } else {
    // Default to code files only (matches what agent would grep for)
    args.push("--type-add", "code:*.{ts,tsx,js,jsx,py,go,rs,java,kt,kts,rb,php,vue,svelte}");
    args.push("--type", "code");
  }

  args.push("--", symbolName, root);

  let stdout: string;
  try {
    stdout = execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: SEARCH_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      if ((err as { status: number }).status === 1) return []; // no matches
      if ("stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
        stdout = (err as { stdout: string }).stdout;
        if (!stdout) return [];
      } else {
        return [];
      }
    } else {
      return [];
    }
  }

  const rootPrefix = root.endsWith("/") ? root : root + "/";
  const lines = stdout.split("\n").filter(Boolean);
  const refs: Reference[] = [];

  for (const rawLine of lines) {
    if (refs.length >= maxResults) break;

    const match = rawLine.match(/^(.+?):(\d+):(.*)/);
    if (!match || !match[1] || !match[2] || match[3] === undefined) continue;

    const absPath = match[1];
    const relPath = absPath.startsWith(rootPrefix) ? absPath.slice(rootPrefix.length) : absPath;
    if (isNoisePath(relPath)) continue;

    refs.push({
      file: relPath,
      line: parseInt(match[2], 10),
      context: match[3].length > MAX_CONTEXT_LENGTH ? match[3].slice(0, MAX_CONTEXT_LENGTH) + "..." : match[3],
    });
  }

  return refs;
}

/**
 * Find references to a symbol name across indexed files.
 * Matches whole words only using word-boundary regex.
 */
export async function findReferences(
  repo: string,
  symbolName: string,
  filePattern?: string,
): Promise<Reference[]> {
  // Try LSP first (type-safe, no false positives)
  const lspRefs = await findReferencesLsp(repo, symbolName);
  if (lspRefs !== null) return lspRefs;

  // Use ripgrep when available (10x+ faster than Node.js file walk)
  if (hasRipgrep()) {
    const index = await requireCodeIndex(repo);
    const result = findReferencesWithRipgrep(index.root, symbolName, MAX_REFERENCES, filePattern);
    // ripgrep helper may return compact string; convert back to Reference[]
    if (typeof result === "string") {
      return result.split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(.+?):(\d+): (.*)/);
        return m ? { file: m[1]!, line: parseInt(m[2]!, 10), context: m[3]! } : { file: "", line: 0, context: line };
      });
    }
    return result;
  }

  // Node.js fallback
  const index = await requireCodeIndex(repo);
  const pattern = wordBoundaryPattern(symbolName);
  const searchStart = Date.now();

  const fileFilter = filePattern
    ? new RegExp(filePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"))
    : null;

  const refs: Reference[] = [];

  for (const fileEntry of index.files) {
    if (refs.length >= MAX_REFERENCES) break;
    if (Date.now() - searchStart > SEARCH_TIMEOUT_MS) break;

    if (fileFilter && !fileFilter.test(fileEntry.path)) continue;
    if (!filePattern && isNoisePath(fileEntry.path)) continue;

    let content: string;
    try {
      content = await readFile(join(index.root, fileEntry.path), "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (refs.length >= MAX_REFERENCES) break;

      const line = lines[i];
      if (line === undefined) continue;
      const match = pattern.exec(line);
      if (match) {
        const rawContext = line.trimEnd();
        refs.push({
          file: fileEntry.path,
          line: i + 1,
          context: rawContext.length > MAX_CONTEXT_LENGTH
            ? rawContext.slice(0, MAX_CONTEXT_LENGTH) + "..."
            : rawContext,
        });
      }
    }
  }

  return refs;
}
