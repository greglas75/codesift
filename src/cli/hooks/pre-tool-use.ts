import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { CODE_EXTENSIONS, DEFAULT_MIN_LINES, denyTool, isCodesiftServerRunning, isCurrentRepoIndexed } from "./shared.js";
import { parseHookInput, readRawInput } from "./input.js";
import { tryLoadWikiSummary } from "./wiki.js";

const DEFAULT_MAX_BYTES = 20_000;
const MAX_READ_HOOK_MAX_BYTES = 1_000_000;

function readHookMaxBytes(): number {
  const raw = process.env["CODESIFT_READ_HOOK_MAX_BYTES"];
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(parsed, MAX_READ_HOOK_MAX_BYTES);
}

function safeRelPath(filePath: string): string {
  return filePath
    .split(/[/\\]/)
    .slice(-3)
    .join("/")
    .replace(/[\u0000-\u001f\u007f]/g, "?");
}

function readRedirectReason(filePath: string, lineCount: number | null, sizeBytes: number | null): string {
  const relPath = safeRelPath(filePath);
  const quotedRelPath = JSON.stringify(relPath);
  const sizeReason = sizeBytes !== null ? ` and ${sizeBytes} bytes` : "";
  const fileStats = lineCount === null ? `is ${sizeBytes} bytes` : `has ${lineCount} lines${sizeReason}`;
  return (
    `File ${quotedRelPath} ${fileStats}. Use CodeSift tools instead:\n` +
    `  get_file_outline(repo, ${quotedRelPath}) for structure\n` +
    `  search_text(repo, "query", file_pattern=${quotedRelPath}) for specific content\n` +
    `  get_symbol(repo, "symbol_id") for a specific function\n` +
    `  To EDIT this file: Read a bounded range (pass offset+limit) — bounded reads are always allowed.`
  );
}

function unsupportedReadReason(filePath: string): string {
  const quotedRelPath = JSON.stringify(safeRelPath(filePath));
  return `File ${quotedRelPath} is not a regular file. Use CodeSift tools for indexed source files instead of reading special files.`;
}

function inspectFileWithCaps(filePath: string, maxBytes: number, minLines: number): {
  lineCount: number | null;
  bytesRead: number;
  sizeBytes: number;
  unsupported: boolean;
} {
  const pathStat = statSync(filePath);
  if (!pathStat.isFile()) {
    return { lineCount: null, bytesRead: 0, sizeBytes: pathStat.size, unsupported: true };
  }

  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) {
      return { lineCount: null, bytesRead: 0, sizeBytes: 0, unsupported: true };
    }
    const sizeBytes = fileStat.size;
    if (sizeBytes > maxBytes) {
      return { lineCount: null, bytesRead: 0, sizeBytes, unsupported: false };
    }

    const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1));
    let bytesReadTotal = 0;
    let lineCount = sizeBytes === 0 ? 0 : 1;

    while (bytesReadTotal <= maxBytes && lineCount < minLines) {
      const bytesToRead = Math.min(buffer.length, maxBytes + 1 - bytesReadTotal);
      if (bytesToRead <= 0) break;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, null);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 10) lineCount += 1;
      }
    }

    return { lineCount, bytesRead: bytesReadTotal, sizeBytes, unsupported: false };
  } finally {
    closeSync(fd);
  }
}

export async function handlePrecheckRead(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { filePath, hasBoundedRange } = parseHookInput(raw);
    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    if (!isCurrentRepoIndexed() || !isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }

    if (hasBoundedRange) {
      process.exit(0);
      return;
    }

    const minLinesEnv = process.env["CODESIFT_READ_HOOK_MIN_LINES"];
    const parsed_min = minLinesEnv ? parseInt(minLinesEnv, 10) : NaN;
    const minLines = Number.isNaN(parsed_min) ? DEFAULT_MIN_LINES : parsed_min;
    const maxBytes = readHookMaxBytes();

    let readResult: { lineCount: number | null; bytesRead: number; sizeBytes: number; unsupported: boolean };
    try {
      readResult = inspectFileWithCaps(filePath, maxBytes, minLines);
    } catch {
      process.exit(0);
      return;
    }

    if (readResult.unsupported) {
      denyTool(unsupportedReadReason(filePath));
      return;
    }

    if (readResult.sizeBytes > maxBytes) {
      denyTool(readRedirectReason(filePath, null, readResult.sizeBytes));
      return;
    }

    const lineCount = readResult.lineCount ?? 1;
    const contentBytes = Math.max(readResult.sizeBytes, readResult.bytesRead);
    if (lineCount >= minLines || contentBytes > maxBytes) {
      denyTool(readRedirectReason(filePath, lineCount, contentBytes));
      return;
    }

    const wikiSummary = tryLoadWikiSummary(filePath);
    if (wikiSummary) {
      process.stdout.write(wikiSummary);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

function isFileFindCommand(cmd: string): boolean {
  const hasFind = /\bfind\s/.test(cmd);
  const hasNameFilter = /\s-i?name\s/.test(cmd);
  const hasDestructive = /\s-(?:exec|delete|ok)\b|\brm\s|\bmv\s/.test(cmd);
  return hasFind && hasNameFilter && !hasDestructive;
}

function isContentGrepCommand(cmd: string): boolean {
  const hasRecursiveGrep =
    /\bgrep\b.*(?:\s-\w*[rR]\w*(?:\s|$)|--recursive(?:\s|$))/.test(cmd) && !/\bgit\s+grep\b/.test(cmd);
  const hasRg = /(?:^|[\s;&|"'`])(?:[./\w-]+\/)?rg(?=$|[\s;&|"'`])/.test(cmd);
  return hasRecursiveGrep || hasRg;
}

export async function handlePrecheckBash(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { command } = parseHookInput(raw);
    if (!command) {
      process.exit(0);
      return;
    }

    const shouldIntercept = isFileFindCommand(command) || isContentGrepCommand(command);
    if (!shouldIntercept) {
      process.exit(0);
      return;
    }

    if (!isCurrentRepoIndexed() || !isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }

    if (isFileFindCommand(command)) {
      denyTool(
        `Current repo is indexed by CodeSift. Use CodeSift MCP tools instead of find:\n` +
          `  get_file_tree(compact=true, name_pattern="*.ts")\n` +
          `  search_symbols(query="test", kind="function")`,
      );
    }

    if (isContentGrepCommand(command)) {
      denyTool(
        `Current repo is indexed by CodeSift. Use CodeSift MCP tools instead of grep/rg:\n` +
          `  search_text(query="pattern", file_pattern="*.ts")\n` +
          `  search_symbols(query="name", include_source=true)`,
      );
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

export async function handlePrecheckGlob(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }
    // "CodeSift is available" must be true before we say it. This denied
    // unconditionally, so a dead server left callers with neither Glob nor the
    // tools it advertised.
    if (!isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }
    denyTool(
      `CodeSift is available. Use CodeSift instead of Glob:\n` +
        `  get_file_tree(compact=true, name_pattern="*.ts") — find files\n` +
        `  search_symbols(query="name", kind="function") — find symbols`,
    );
  } catch {
    process.exit(0);
  }
}

export async function handlePrecheckGrep(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }
    // Same as Glob above: never redirect to tools the caller cannot reach.
    if (!isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }
    denyTool(
      `CodeSift is available. Use CodeSift instead of Grep:\n` +
        `  search_text(query="pattern", file_pattern="*.ts") — BM25-ranked full-text search\n` +
        `  search_symbols(query="name", include_source=true) — find functions/classes`,
    );
  } catch {
    process.exit(0);
  }
}
