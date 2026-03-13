import { execSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import { validateGitRef } from "../utils/git-validation.js";
import type { CodeSymbol } from "../types.js";

export interface DiffOutlineResult {
  added: CodeSymbol[];
  modified: CodeSymbol[];
  deleted: string[];
}

export interface ChangedFileSymbols {
  file: string;
  symbols: string[];
}

interface DiffHunk {
  file: string;
  startLine: number;
  lineCount: number;
}

/**
 * Parse unified diff output to extract changed file paths and line ranges.
 */
function parseDiffHunks(diffOutput: string): { hunks: DiffHunk[]; newFiles: string[]; deletedFiles: string[] } {
  const hunks: DiffHunk[] = [];
  const newFiles: string[] = [];
  const deletedFiles: string[] = [];

  let currentFile: string | null = null;
  let isNewFile = false;
  let isDeletedFile = false;

  for (const line of diffOutput.split("\n")) {
    // Detect file header: diff --git a/path b/path
    if (line.startsWith("diff --git")) {
      const match = /diff --git a\/.+ b\/(.+)/.exec(line);
      if (match?.[1]) {
        currentFile = match[1];
        isNewFile = false;
        isDeletedFile = false;
      }
      continue;
    }

    // Detect new file
    if (line.startsWith("new file mode")) {
      isNewFile = true;
      if (currentFile) {
        newFiles.push(currentFile);
      }
      continue;
    }

    // Detect deleted file
    if (line.startsWith("deleted file mode")) {
      isDeletedFile = true;
      if (currentFile) {
        deletedFiles.push(currentFile);
      }
      continue;
    }

    // Parse hunk headers: @@ -old,count +new,count @@
    if (line.startsWith("@@") && currentFile && !isNewFile && !isDeletedFile) {
      const hunkMatch = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunkMatch?.[1]) {
        const startLine = parseInt(hunkMatch[1], 10);
        const lineCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        hunks.push({ file: currentFile, startLine, lineCount });
      }
    }
  }

  return { hunks, newFiles, deletedFiles };
}

/**
 * Check if a symbol overlaps with any of the changed line ranges.
 */
function symbolOverlapsHunks(symbol: CodeSymbol, hunks: DiffHunk[]): boolean {
  for (const hunk of hunks) {
    if (hunk.file !== symbol.file) continue;

    const hunkEnd = hunk.startLine + hunk.lineCount - 1;
    // Overlap: symbol range intersects hunk range
    if (symbol.start_line <= hunkEnd && symbol.end_line >= hunk.startLine) {
      return true;
    }
  }
  return false;
}

/**
 * Run git diff and return the raw output.
 */
function runGitDiff(repoRoot: string, since: string, until: string, nameOnly: boolean): string {
  validateGitRef(since);
  validateGitRef(until);

  const flag = nameOnly ? "--name-only" : "";
  const cmd = `git diff ${flag} ${since}..${until}`.trim();
  try {
    return execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Git diff failed: ${message}`);
  }
}

/**
 * Outline of changes between two git refs.
 * Classifies symbols as added (in new files), modified (overlapping changed hunks),
 * or deleted (in removed files).
 */
export async function diffOutline(
  repo: string,
  since: string,
  until?: string,
): Promise<DiffOutlineResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const untilRef = until ?? "HEAD";
  const diffOutput = runGitDiff(index.root, since, untilRef, false);
  const { hunks, newFiles, deletedFiles } = parseDiffHunks(diffOutput);

  const newFileSet = new Set(newFiles);
  const deletedFileSet = new Set(deletedFiles);

  const added: CodeSymbol[] = [];
  const modified: CodeSymbol[] = [];

  for (const sym of index.symbols) {
    // Symbols in new files are "added"
    if (newFileSet.has(sym.file)) {
      added.push(sym);
      continue;
    }

    // Skip symbols in deleted files (they won't be in the index anyway,
    // but guard just in case)
    if (deletedFileSet.has(sym.file)) continue;

    // Check if symbol overlaps with any changed hunk
    if (symbolOverlapsHunks(sym, hunks)) {
      modified.push(sym);
    }
  }

  return {
    added,
    modified,
    deleted: deletedFiles,
  };
}

/**
 * List all symbol names in each changed file.
 * Simplified version of diffOutline that only reports symbol names per file.
 */
export async function changedSymbols(
  repo: string,
  since: string,
  until?: string,
): Promise<ChangedFileSymbols[]> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const untilRef = until ?? "HEAD";
  const output = runGitDiff(index.root, since, untilRef, true);

  const changedFiles = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changedFileSet = new Set(changedFiles);

  // Group symbols by file
  const symbolsByFile = new Map<string, string[]>();
  for (const sym of index.symbols) {
    if (!changedFileSet.has(sym.file)) continue;

    const existing = symbolsByFile.get(sym.file);
    if (existing) {
      existing.push(sym.name);
    } else {
      symbolsByFile.set(sym.file, [sym.name]);
    }
  }

  const result: ChangedFileSymbols[] = [];
  for (const file of changedFiles) {
    const symbols = symbolsByFile.get(file);
    if (symbols && symbols.length > 0) {
      result.push({ file, symbols });
    }
  }

  return result;
}
