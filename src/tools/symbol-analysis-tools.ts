import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol, SymbolKind } from "../types.js";
import {
  detectFrameworks,
  isFrameworkEntryPoint,
} from "../utils/framework-detect.js";
import { isTestFileStrict as isTestFile } from "../utils/test-file.js";
import { requireCodeIndex } from "./symbol-tool-internals.js";

const MAX_DEAD_CODE_RESULTS = 100;

export interface DeadCodeCandidate {
  name: string;
  kind: SymbolKind;
  file: string;
  start_line: number;
  end_line: number;
  reason: string;
}

export interface DeadCodeResult {
  candidates: DeadCodeCandidate[];
  scanned_symbols: number;
  scanned_files: number;
  /**
   * The RESULT LIST was cut short — there are more dead-looking symbols than are shown.
   * The listed candidates are still as trustworthy as `coverage` says; there are just more.
   */
  truncated?: boolean;
  /**
   * Whether the reference scan actually saw the whole repository.
   *
   * This is the field that decides whether a candidate may be deleted. "Dead" here means
   * "no reference found in the files I read" — if some files were never read, a symbol used
   * only from those files looks exactly like a genuinely unused one. `truncated` used to carry
   * this meaning as well as the list-length one; an agent reading a single boolean naturally
   * takes the harmless reading ("the list is cut off") and acts on the candidates, which is
   * the wrong call precisely when the scan was short.
   *
   * `complete` is the only status under which an empty or short candidate list is evidence
   * about the code rather than about the scan.
   */
  coverage: {
    status: "complete" | "partial";
    files_indexed: number;
    files_read: number;
    /** Files the scan stopped before reaching (MAX_SCAN_FILES cap). */
    files_skipped_by_cap?: number;
    /** Files that were indexed but could not be read now (deleted, permissions, races). */
    files_unreadable?: number;
    detail?: string;
  };
}

// Kinds that are typically exported and should have external references
const EXPORTABLE_KINDS = new Set<SymbolKind>([
  "function", "class", "interface", "type", "variable", "constant", "enum",
  "component", "hook",
]);

/**
 * Collect top-level symbols of exportable kinds, filtered by test/pattern options.
 */
function collectExportedSymbols(
  symbols: CodeSymbol[],
  options: { includeTests: boolean; filePattern?: string | undefined },
): CodeSymbol[] {
  return symbols.filter((s) => {
    if (!EXPORTABLE_KINDS.has(s.kind)) return false;
    if (s.parent) return false;
    if (!options.includeTests && isTestFile(s.file)) return false;
    if (options.filePattern && !s.file.includes(options.filePattern)) return false;
    if (s.name.length < 3) return false;
    if (s.kind === "variable" && s.name === "default") return false;
    return true;
  });
}

// Bumped from 2000 → 5000 (F14: prior cap silently dropped references in
// medium-large repos, producing false-positive dead-code candidates whose
// real callers lived in unscanned files). Memory cost: roughly one file
// content string per entry — at 5K average-sized source files this is on
// the order of 50–200 MB peak, well within limits for analysis flows.
const MAX_SCAN_FILES = 5000;

/**
 * Resolve a relative import path against a source file's directory. Handles
 * the standard TS/Node extensions plus barrel-style `index` resolution.
 * Returns the candidate file path that exists in `allFiles`, or null.
 *
 * Intentionally narrow: only resolves `./` and `../` paths. Aliased imports
 * (tsconfig paths, package-json `imports`) are out of scope here — they show
 * up textually in scanned content anyway, so they don't drive false positives.
 */
function resolveRelativeImport(
  fromFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  if (!importPath.startsWith(".")) return null;
  const lastSlash = fromFile.lastIndexOf("/");
  const fromDir = lastSlash >= 0 ? fromFile.slice(0, lastSlash) : "";
  const segments = (fromDir + "/" + importPath).split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const base = stack.join("/");
  if (allFiles.has(base)) return base;
  // TS allows `import './x.js'` to resolve to `x.ts` — strip then re-extend.
  const stripped = base.replace(/\.(m?js|jsx)$/, "");
  const candidates = [
    stripped + ".ts",
    stripped + ".tsx",
    stripped + ".mjs",
    stripped + ".js",
    stripped + ".jsx",
    stripped + "/index.ts",
    stripped + "/index.tsx",
    stripped + "/index.js",
    stripped + "/index.jsx",
  ];
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return null;
}

/**
 * Pre-scan content for re-export edges. A symbol re-exported from another
 * file isn't textually referenced in the barrel — without this pass barrel
 * patterns like `export * from './foo'` cause every symbol in `./foo` to be
 * misclassified as dead.
 *
 * Returns a set of file paths that are reached via at least one re-export
 * (named or star). Callers treat any candidate whose defining file lands in
 * this set as live.
 */
function collectReExportedFiles(
  fileContents: Map<string, string>,
  allFiles: Set<string>,
): Set<string> {
  const reExported = new Set<string>();
  // Matches:  export * from "./x";   export { A, B } from "./x";   export type { T } from "./x";
  // Anchor dropped (`^\s*` removed) so block-comment-prefixed exports
  // (`/** doc */ export { Y } from "./x"`) and continuation-line exports
  // (`...; export * from "./x"`) are detected too.
  const RE = /\bexport\s+(?:\*|type\s+\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;
  for (const [filePath, content] of fileContents) {
    RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(content)) !== null) {
      const target = resolveRelativeImport(filePath, m[1]!, allFiles);
      if (target) reExported.add(target);
    }
  }
  return reExported;
}

/**
 * Find potentially dead code: exported symbols with 0 references outside their own file.
 * Scans all indexed files for word-boundary matches of each exported symbol name.
 *
 * F14 fixes (2026-05-05):
 *   - Test files are now ALWAYS scanned for references regardless of
 *     `include_tests`. The flag now gates only candidate selection (whether
 *     test-internal exports can themselves be flagged dead). Symbols used
 *     only in tests are no longer false-positive dead.
 *   - Re-exports via `export * from './x'` and `export { Y } from './x'`
 *     now mark `./x` as live; previously the lack of textual mention in the
 *     barrel made every barrel-forwarded symbol look dead.
 *   - MAX_SCAN_FILES raised 2000 → 5000; truncation now surfaces in the
 *     `truncated` field so callers can react.
 */
export async function findDeadCode(
  repo: string,
  options?: {
    file_pattern?: string | undefined;
    include_tests?: boolean | undefined;
  },
): Promise<DeadCodeResult> {
  const index = await requireCodeIndex(repo);
  const includeTests = options?.include_tests ?? false;
  const filePattern = options?.file_pattern;

  const exportedSymbols = collectExportedSymbols(index.symbols, { includeTests, filePattern });
  const frameworks = detectFrameworks(index);

  // Read EVERY indexed file (incl. tests) for reference scanning. The previous
  // version honored `includeTests` here, which meant a symbol referenced only
  // from tests was misclassified as dead. Candidate selection still uses
  // `includeTests` (above) so test-only helpers don't appear in the result list.
  const fileContents = new Map<string, string>();
  let scanTruncated = false;
  let filesSkippedByCap = 0;
  let filesUnreadable = 0;
  for (const file of index.files) {
    if (fileContents.size >= MAX_SCAN_FILES) {
      scanTruncated = true;
      filesSkippedByCap = index.files.length - fileContents.size - filesUnreadable;
      break;
    }
    try {
      fileContents.set(file.path, await readFile(join(index.root, file.path), "utf-8"));
    } catch {
      // Deleted, unreadable, or raced with a write. Counted rather than merely skipped: a
      // reference living only in a file we could not read is invisible to the scan below, and
      // the symbol it points at then looks dead.
      filesUnreadable++;
    }
  }

  // Build set of files that are forwarded via re-exports (barrel chains).
  // Symbols defined in such files are reachable even without textual mention.
  const allFilePaths = new Set(fileContents.keys());
  const reExportedFiles = collectReExportedFiles(fileContents, allFilePaths);

  // Reference index, built in ONE pass over file contents. Previously this scan
  // was O(exportedSymbols x files): a `\b<name>\b` regex over every file's full
  // text for every exported symbol. On a healthy repo (few dead symbols) the
  // early-exit never fires, so the full product ran — telemetry (2026-07-20)
  // measured a 1,066,401 ms (~17.8 min) p95 for find_dead_code.
  //
  // Tokenising on [^A-Za-z0-9_]+ mirrors the \b\w boundary semantics of the old
  // regex. Per token we only need "is it mentioned outside its defining file",
  // so we keep the first file that mentioned it plus a multi-file flag — O(1)
  // memory per unique token instead of a file set, and O(1) lookup per symbol.
  const tokenIndex = new Map<string, { first: string; multi: boolean }>();
  for (const [filePath, content] of fileContents) {
    for (const token of new Set(content.split(/[^A-Za-z0-9_]+/))) {
      if (!token) continue;
      const entry = tokenIndex.get(token);
      if (!entry) tokenIndex.set(token, { first: filePath, multi: false });
      else if (!entry.multi && entry.first !== filePath) entry.multi = true;
    }
  }

  const candidates: DeadCodeCandidate[] = [];

  for (const sym of exportedSymbols) {
    if (candidates.length >= MAX_DEAD_CODE_RESULTS) break;
    if (isFrameworkEntryPoint(sym, frameworks)) continue;
    // Re-export reachability — barrel forwards skip the textual-mention check.
    if (reExportedFiles.has(sym.file)) continue;

    // Mentioned in any file other than the one defining it => not dead.
    const seen = tokenIndex.get(sym.name);
    const hasExternalRef = !!seen && (seen.multi || seen.first !== sym.file);

    if (!hasExternalRef) {
      candidates.push({
        name: sym.name,
        kind: sym.kind,
        file: sym.file,
        start_line: sym.start_line,
        end_line: sym.end_line,
        reason: "exported but no references found outside defining file",
      });
    }
  }

  const scanComplete = !scanTruncated && filesUnreadable === 0;
  const coverage: DeadCodeResult["coverage"] = {
    status: scanComplete ? "complete" : "partial",
    files_indexed: index.files.length,
    files_read: fileContents.size,
    ...(filesSkippedByCap > 0 ? { files_skipped_by_cap: filesSkippedByCap } : {}),
    ...(filesUnreadable > 0 ? { files_unreadable: filesUnreadable } : {}),
    ...(scanComplete
      ? {}
      : {
          detail:
            `reference scan read ${fileContents.size} of ${index.files.length} indexed files` +
            (filesSkippedByCap > 0 ? ` (${filesSkippedByCap} beyond the ${MAX_SCAN_FILES}-file cap)` : "") +
            (filesUnreadable > 0 ? ` (${filesUnreadable} unreadable)` : "") +
            " — a symbol referenced only from an unread file is indistinguishable from a dead one," +
            " so do NOT delete on this result alone; narrow with file_pattern to get a complete scan",
        }),
  };

  return {
    candidates,
    scanned_symbols: exportedSymbols.length,
    scanned_files: fileContents.size,
    // Deliberately ONLY about list length now. Scan completeness lives in `coverage`, because
    // the two have opposite implications: a cut-off list means "there are more", a short scan
    // means "these may be wrong".
    ...(candidates.length >= MAX_DEAD_CODE_RESULTS ? { truncated: true } : {}),
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Unused import detection
// ---------------------------------------------------------------------------

const MAX_UNUSED_IMPORTS = 200;

export interface UnusedImport {
  file: string;
  line: number;
  import_text: string;
  imported_name: string;
}

export interface UnusedImportsResult {
  unused: UnusedImport[];
  scanned_files: number;
  truncated?: boolean;
}

/**
 * Find imports whose imported names are never referenced in the file body.
 * Supports ES module named imports: import { A, B } from '...'
 */
export async function findUnusedImports(
  repo: string,
  options?: { file_pattern?: string; include_tests?: boolean },
): Promise<UnusedImportsResult> {
  const index = await requireCodeIndex(repo);
  const includeTests = options?.include_tests ?? false;

  const unused: UnusedImport[] = [];
  let scannedFiles = 0;

  for (const file of index.files) {
    if (unused.length >= MAX_UNUSED_IMPORTS) break;
    if (!includeTests && isTestFile(file.path)) continue;
    if (options?.file_pattern && !file.path.includes(options.file_pattern)) continue;

    // Only analyze JS/TS/Kotlin files
    if (!/\.(ts|tsx|js|jsx|mjs|kt|kts)$/.test(file.path)) continue;

    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }
    scannedFiles++;

    const lines = source.split("\n");

    // Find named import lines: import { A, B, C } from '...'
    // Also: import A from '...'  and  import * as A from '...'
    const importRegex = /^import\s+(?:type\s+)?(?:\{([^}]+)\}|(\*\s+as\s+\w+)|(\w+)).*from\s+['"][^'"]+['"]/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line.startsWith("import ")) continue;
      // Stop scanning imports when we hit non-import code
      if (i > 0 && !line.startsWith("import") && !line.startsWith("//") && !line.startsWith("/*") && line.length > 0 && !lines[i]!.trim().startsWith("*") && !lines[i]!.trim().startsWith("}")) {
        // Could be multi-line import continuation, keep going
      }

      const match = importRegex.exec(line);
      if (!match) continue;

      const names: string[] = [];
      if (match[1]) {
        // Named imports: { A, B as C, type D }
        for (const part of match[1].split(",")) {
          const trimmed = part.trim().replace(/^type\s+/, "");
          if (!trimmed) continue;
          // Handle "A as B" — the local name is B
          const asMatch = /(\w+)\s+as\s+(\w+)/.exec(trimmed);
          names.push(asMatch ? asMatch[2]! : trimmed);
        }
      } else if (match[2]) {
        // Namespace import: * as A
        const nsMatch = /\*\s+as\s+(\w+)/.exec(match[2]);
        if (nsMatch) names.push(nsMatch[1]!);
      } else if (match[3]) {
        // Default import: import A
        names.push(match[3]);
      }

      // Check each imported name against rest of file
      const bodyAfterImports = lines.slice(i + 1).join("\n");
      for (const name of names) {
        if (name.length < 2) continue;
        const nameRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!nameRegex.test(bodyAfterImports)) {
          unused.push({
            file: file.path,
            line: i + 1,
            import_text: line,
            imported_name: name,
          });
          if (unused.length >= MAX_UNUSED_IMPORTS) break;
        }
      }
    }
  }

  return {
    unused,
    scanned_files: scannedFiles,
    ...(unused.length >= MAX_UNUSED_IMPORTS ? { truncated: true } : {}),
  };
}
