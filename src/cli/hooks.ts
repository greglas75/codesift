// ---------------------------------------------------------------------------
// CLI hooks — Cross-platform PreToolUse / PostToolUse hook handlers
// ---------------------------------------------------------------------------
// Supports Claude Code, Codex, Gemini CLI, and Cline.
//
// Input sources:
//   Claude Code / Codex: HOOK_TOOL_INPUT env var (JSON)
//   Gemini CLI / Cline:  stdin (JSON), triggered by --stdin flag
//
// Exit codes: 0 = allow, 2 = deny (with redirect message on stdout)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Cross-platform input parsing
// ---------------------------------------------------------------------------

/**
 * Read raw hook input from env var (Claude/Codex) or stdin (Gemini/Cline).
 */
function readRawInput(): string | null {
  const envInput = process.env["HOOK_TOOL_INPUT"];
  if (envInput) return envInput;

  if (process.argv.includes("--stdin")) {
    try {
      return readFileSync(0, "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}

interface HookInput {
  filePath: string | null;
  sessionId: string | null;
  command: string | null;
}

const EMPTY_INPUT: HookInput = Object.freeze({ filePath: null, sessionId: null, command: null });

/**
 * Parse hook input JSON once, extracting all fields across all platforms.
 *
 * Supported formats:
 *   Claude Code / Codex: { tool_input: { file_path, command }, session_id }
 *   Gemini CLI:          { tool: { input: { path|file_path, command } }, sessionId }
 *   Cline:               { preToolUse|postToolUse: { args: { file_path } } }
 */
function parseHookInput(raw: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_INPUT;
  }
  if (parsed === null || typeof parsed !== "object") return EMPTY_INPUT;
  const obj = parsed as Record<string, unknown>;

  let filePath: string | null = null;
  let command: string | null = null;

  // Claude Code / Codex: { tool_input: { file_path, command } }
  if (obj["tool_input"] && typeof obj["tool_input"] === "object") {
    const ti = obj["tool_input"] as Record<string, unknown>;
    if (typeof ti["file_path"] === "string") filePath = ti["file_path"];
    if (typeof ti["command"] === "string") command = ti["command"];
  }

  // Gemini CLI: { tool: { input: { path|file_path, command } } }
  if (obj["tool"] && typeof obj["tool"] === "object") {
    const tool = obj["tool"] as Record<string, unknown>;
    if (tool["input"] && typeof tool["input"] === "object") {
      const input = tool["input"] as Record<string, unknown>;
      if (filePath === null) {
        if (typeof input["path"] === "string") filePath = input["path"];
        else if (typeof input["file_path"] === "string") filePath = input["file_path"];
      }
      if (command === null && typeof input["command"] === "string") command = input["command"];
    }
  }

  // Cline: { preToolUse|postToolUse: { args: { file_path } } }
  if (filePath === null) {
    for (const key of ["preToolUse", "postToolUse"]) {
      if (obj[key] && typeof obj[key] === "object") {
        const hook = obj[key] as Record<string, unknown>;
        if (hook["args"] && typeof hook["args"] === "object") {
          const args = hook["args"] as Record<string, unknown>;
          if (typeof args["file_path"] === "string") {
            filePath = args["file_path"];
            break;
          }
        }
      }
    }
  }

  // Session ID: top-level { session_id } or { sessionId }
  let sessionId: string | null = null;
  if (typeof obj["session_id"] === "string") sessionId = obj["session_id"];
  else if (typeof obj["sessionId"] === "string") sessionId = obj["sessionId"];

  return { filePath, sessionId, command };
}

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

const WIKI_MANIFEST_REL = join(".codesift", "wiki", "wiki-manifest.json");
const WIKI_SUMMARY_MAX_CHARS = 2000;

/**
 * Walk up from `filePath` looking for `.codesift/wiki/wiki-manifest.json`.
 * Returns the repo root directory if found, otherwise null.
 */
function findRepoRoot(filePath: string): string | null {
  let dir = dirname(filePath);
  while (true) {
    try {
      readFileSync(join(dir, WIKI_MANIFEST_REL));
      return dir;
    } catch {
      // manifest not found at this level
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Try to load the wiki community summary for `filePath`.
 * Returns the summary string (truncated to WIKI_SUMMARY_MAX_CHARS) if found,
 * or null if any step fails (missing manifest, file not mapped, missing .md, etc.).
 *
 * ALL reads are synchronous — the hook must exit fast.
 * ALL errors are caught — never crash the hook (CQ8).
 */
function tryLoadWikiSummary(filePath: string): string | null {
  try {
    const repoRoot = findRepoRoot(filePath);
    if (!repoRoot) return null;

    const manifestPath = join(repoRoot, WIKI_MANIFEST_REL);
    let manifestRaw: string;
    try {
      manifestRaw = readFileSync(manifestPath, "utf-8");
    } catch {
      return null;
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const fileToComm = manifest["file_to_community"];
    if (!fileToComm || typeof fileToComm !== "object") return null;
    const map = fileToComm as Record<string, unknown>;

    // Resolve the file path relative to the repo root for lookup
    // Normalize to forward slashes for cross-platform compatibility (manifest uses POSIX paths)
    const relPath = relative(repoRoot, filePath).split("\\").join("/");
    const communitySlug = map[relPath];
    if (typeof communitySlug !== "string") return null;

    // Validate slug format (defense-in-depth: prevent path traversal via crafted manifest)
    if (!/^[a-z0-9-]+$/.test(communitySlug)) return null;

    const summaryPath = join(repoRoot, ".codesift", "wiki", `${communitySlug}.summary.md`);
    let summary: string;
    try {
      summary = readFileSync(summaryPath, "utf-8");
    } catch {
      return null;
    }

    return summary.length > WIKI_SUMMARY_MAX_CHARS
      ? summary.slice(0, WIKI_SUMMARY_MAX_CHARS)
      : summary;
  } catch {
    // CQ8: never crash the hook
    return null;
  }
}

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

    // Wiki context injection — only fires for small files (not redirected above)
    const wikiSummary = tryLoadWikiSummary(filePath);
    if (wikiSummary) {
      process.stdout.write(wikiSummary);
    }
    process.exit(0);
  } catch {
    // CQ8: never crash — always fall back to allow so the agent is not blocked
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckBash
//
// PreToolUse hook for the Bash tool. When the agent attempts to run file-
// finding (find ... -name) or content-searching (grep -r, rg) commands,
// deny and redirect to CodeSift tools instead.
//
// This ensures sub-agents (Explore, Plan, etc.) use the CodeSift index
// rather than raw shell commands, even when they don't have CodeSift rules
// in their context.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.command
// ---------------------------------------------------------------------------

function isFileFindCommand(cmd: string): boolean {
  const hasFind = /\bfind\s/.test(cmd);
  const hasNameFilter = /\s-i?name\s/.test(cmd);
  // Don't intercept destructive operations
  const hasDestructive = /\s-(?:exec|delete|ok)\b|\brm\s|\bmv\s/.test(cmd);
  return hasFind && hasNameFilter && !hasDestructive;
}

function isContentGrepCommand(cmd: string): boolean {
  // grep -r/-R/--recursive (but not git grep)
  const hasRecursiveGrep =
    /\bgrep\b.*(?:\s-\w*[rR]\w*\s|--recursive)/.test(cmd) && !/\bgit\s+grep\b/.test(cmd);
  // standalone rg (not as part of another word like "org")
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

    if (isFileFindCommand(command)) {
      process.stdout.write(
        `CodeSift has repos pre-indexed. Use CodeSift MCP tools instead of find:\n` +
          `  list_repos() — get repo identifier (call once)\n` +
          `  get_file_tree(repo="local/<name>", compact=true, name_pattern="*.ts")\n` +
          `  search_symbols(repo="local/<name>", query="test", kind="function")\n`,
      );
      process.exit(2);
      return;
    }

    if (isContentGrepCommand(command)) {
      process.stdout.write(
        `CodeSift has repos pre-indexed. Use CodeSift MCP tools instead of grep/rg:\n` +
          `  list_repos() — get repo identifier (call once)\n` +
          `  search_text(repo="local/<name>", query="pattern", file_pattern="*.ts")\n` +
          `  search_symbols(repo="local/<name>", query="name", include_source=true)\n`,
      );
      process.exit(2);
      return;
    }

    process.exit(0);
  } catch {
    // CQ8: never crash — always fall back to allow
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckGlob
//
// PreToolUse hook for the Glob tool. Redirects file-finding operations to
// CodeSift's get_file_tree which uses the pre-built index.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.pattern
// ---------------------------------------------------------------------------

export async function handlePrecheckGlob(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    // Glob is always a file-finding operation — redirect to CodeSift
    process.stdout.write(
      `CodeSift is available and repos are pre-indexed. Use CodeSift MCP tools instead of Glob:\n` +
        `  get_file_tree(compact=true, name_pattern="*.ts") — find files by pattern\n` +
        `  search_symbols(query="name", kind="function") — find symbols by name\n` +
        `Repo auto-resolves from CWD — no need to call list_repos first.\n`,
    );
    process.exit(2);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckGrep
//
// PreToolUse hook for the Grep tool. Redirects content-searching operations
// to CodeSift's search_text which uses the pre-built BM25 index.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.pattern
// ---------------------------------------------------------------------------

export async function handlePrecheckGrep(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    // Grep is always a content-search operation — redirect to CodeSift
    process.stdout.write(
      `CodeSift is available and repos are pre-indexed. Use CodeSift MCP tools instead of Grep:\n` +
        `  search_text(query="pattern", file_pattern="*.ts") — full-text search with BM25 ranking\n` +
        `  search_symbols(query="name", include_source=true) — find functions/classes by name\n` +
        `Repo auto-resolves from CWD — no need to call list_repos first.\n`,
    );
    process.exit(2);
  } catch {
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
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { sessionId } = parseHookInput(raw);

    if (!sessionId || !/^[a-f0-9-]+$/i.test(sessionId)) {
      process.exit(0);
      return;
    }

    // Read sidecar file
    const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
    const sidecarPath = join(dataDir, `session-${sessionId}.json`);

    let sidecarData: Record<string, unknown>;
    try {
      const content = readFileSync(sidecarPath, "utf-8");
      sidecarData = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Sidecar missing or invalid — exit gracefully
      process.exit(0);
      return;
    }

    // Deserialize and format snapshot
    const { deserializeState, formatSnapshot } = await import("../storage/session-state.js");
    const sessionState = deserializeState(sidecarData);
    const snapshot = formatSnapshot(sessionState);

    if (snapshot) {
      process.stdout.write(snapshot, () => process.exit(0));
      return;
    }

    process.exit(0);
  } catch {
    // CQ8: never crash — never block compaction
    process.exit(0);
  }
}
