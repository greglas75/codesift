import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { CODE_EXTENSIONS, DEFAULT_MIN_LINES, denyTool, isCurrentRepoIndexed } from "./shared.js";
import { parseHookInput, readRawInput } from "./input.js";
import { tryLoadWikiSummary } from "./wiki.js";

export async function handlePrecheckRead(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { filePath } = parseHookInput(raw);
    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    if (!isCurrentRepoIndexed()) {
      process.exit(0);
      return;
    }

    try {
      const ti = (JSON.parse(raw) as { tool_input?: Record<string, unknown> }).tool_input;
      if (ti && (typeof ti["offset"] === "number" || typeof ti["limit"] === "number")) {
        process.exit(0);
        return;
      }
    } catch {
      // malformed input falls through to the size check
    }

    const minLinesEnv = process.env["CODESIFT_READ_HOOK_MIN_LINES"];
    const parsed_min = minLinesEnv ? parseInt(minLinesEnv, 10) : NaN;
    const minLines = Number.isNaN(parsed_min) ? DEFAULT_MIN_LINES : parsed_min;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      process.exit(0);
      return;
    }

    const lineCount = content.split("\n").length;
    if (lineCount >= minLines) {
      const relPath = filePath.split("/").slice(-3).join("/");
      const reason =
        `File ${relPath} has ${lineCount} lines. Use CodeSift tools instead:\n` +
        `  get_file_outline(repo, "${relPath}") for structure\n` +
        `  search_text(repo, "query", file_pattern="${relPath}") for specific content\n` +
        `  get_symbol(repo, "symbol_id") for a specific function\n` +
        `  To EDIT this file: Read a bounded range (pass offset+limit) — bounded reads are always allowed.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
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
    /\bgrep\b.*(?:\s-\w*[rR]\w*\s|--recursive)/.test(cmd) && !/\bgit\s+grep\b/.test(cmd);
  const hasRg = /(?:^|[\s;&|])rg\s/.test(cmd);
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

    if (!isCurrentRepoIndexed()) {
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
    denyTool(
      `CodeSift is available. Use CodeSift instead of Grep:\n` +
        `  search_text(query="pattern", file_pattern="*.ts") — BM25-ranked full-text search\n` +
        `  search_symbols(query="name", include_source=true) — find functions/classes`,
    );
  } catch {
    process.exit(0);
  }
}
