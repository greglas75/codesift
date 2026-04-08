// ---------------------------------------------------------------------------
// CLI hooks — Claude Code PreToolUse / PostToolUse hook handlers
// ---------------------------------------------------------------------------
// Exit codes: 0 = allow, 2 = deny (with redirect message on stdout)
// The hook command receives tool input via HOOK_TOOL_INPUT env var as JSON.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";

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
// handlePostindexFile
//
// PostToolUse hook for Write/Edit tools. When the agent writes or edits a
// code file, re-index that file so the CodeSift index stays up to date.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.file_path
//
// Always exits 0 (fire-and-forget — never block the agent on hook errors).
// ---------------------------------------------------------------------------

export async function handlePostindexFile(): Promise<void> {
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

    try {
      const { indexFile } = await import("../tools/index-tools.js");
      await indexFile(filePath);
    } catch {
      // CQ8: fire-and-forget — never crash, never block the agent
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecompactSnapshot
//
// PreCompact hook for Claude Code. Reads the sidecar JSON file written by
// the MCP server process, formats a compact snapshot, and writes it to stdout.
// Claude Code injects stdout content into context before compaction.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with session_id
//
// Always exits 0 — never blocks compaction.
// ---------------------------------------------------------------------------

export async function handlePrecompactSnapshot(): Promise<void> {
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
      process.exit(0);
      return;
    }

    // Extract session_id from hook input
    const sessionId =
      parsed !== null &&
      typeof parsed === "object" &&
      "session_id" in parsed &&
      typeof (parsed as Record<string, unknown>).session_id === "string"
        ? ((parsed as Record<string, unknown>).session_id as string)
        : null;

    if (!sessionId) {
      process.exit(0);
      return;
    }

    // Read sidecar file
    const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
    const sidecarPath = join(dataDir, `session-${sessionId}.json`);

    let raw: Record<string, unknown>;
    try {
      const content = readFileSync(sidecarPath, "utf-8");
      raw = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Sidecar missing or invalid — exit gracefully
      process.exit(0);
      return;
    }

    // Deserialize and format snapshot
    const { deserializeState, formatSnapshot } = await import("../storage/session-state.js");
    const sessionState = deserializeState(raw);
    const snapshot = formatSnapshot(sessionState);

    if (snapshot) {
      process.stdout.write(snapshot);
    }

    process.exit(0);
  } catch {
    // CQ8: never crash — never block compaction
    process.exit(0);
  }
}
