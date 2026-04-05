// ---------------------------------------------------------------------------
// CLI hooks — Claude Code PreToolUse / PostToolUse hook handlers
// ---------------------------------------------------------------------------
// Exit codes: 0 = allow, 2 = deny (with redirect message on stdout)
// The hook command receives tool input via HOOK_TOOL_INPUT env var as JSON.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { extname } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".vue",
  ".svelte",
]);

const DEFAULT_MIN_LINES = 200;

// ---------------------------------------------------------------------------
// handlePrecheckRead
//
// PreToolUse hook for the Read tool. When the agent attempts to read a large
// code file, deny the read and redirect to CodeSift tools instead.
//
// Env vars:
//   HOOK_TOOL_INPUT               — JSON string with tool_input.file_path
//   CODESIFT_READ_HOOK_MIN_LINES  — override the line threshold (default: 200)
// ---------------------------------------------------------------------------

export async function handlePrecheckRead(): Promise<void> {
  try {
    const input = process.env["HOOK_TOOL_INPUT"];
    if (!input) {
      process.exit(0);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      // Malformed JSON — allow (never block the agent on hook errors)
      process.exit(0);
      return;
    }

    const filePath =
      parsed !== null &&
      typeof parsed === "object" &&
      "tool_input" in parsed &&
      parsed.tool_input !== null &&
      typeof parsed.tool_input === "object" &&
      "file_path" in parsed.tool_input &&
      typeof (parsed.tool_input as Record<string, unknown>).file_path === "string"
        ? ((parsed.tool_input as Record<string, unknown>).file_path as string)
        : null;

    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    const minLinesEnv = process.env["CODESIFT_READ_HOOK_MIN_LINES"];
    const parsed_min = minLinesEnv ? parseInt(minLinesEnv, 10) : NaN;
    const minLines = Number.isNaN(parsed_min) ? DEFAULT_MIN_LINES : parsed_min;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      // File not found or unreadable — allow
      process.exit(0);
      return;
    }

    const lineCount = content.split("\n").length;
    if (lineCount >= minLines) {
      const relPath = filePath.split("/").slice(-3).join("/");
      process.stdout.write(
        `File ${relPath} has ${lineCount} lines. Use CodeSift tools instead:\n` +
          `  get_file_outline(repo, "${relPath}") for structure\n` +
          `  search_text(repo, "query", file_pattern="${relPath}") for specific content\n` +
          `  get_symbol(repo, "symbol_id") for a specific function\n`,
      );
      process.exit(2);
      return;
    }

    process.exit(0);
  } catch {
    // CQ8: never crash — always fall back to allow so the agent is not blocked
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePostindexFile — placeholder for Task 9
// ---------------------------------------------------------------------------

export async function handlePostindexFile(): Promise<void> {
  process.exit(0);
}
