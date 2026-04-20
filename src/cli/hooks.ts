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

import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, posix as pathPosix } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";

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
  toolName: string | null;
}

const EMPTY_INPUT: HookInput = Object.freeze({ filePath: null, sessionId: null, command: null, toolName: null });

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

  // Tool name: top-level { tool_name } (Claude Code) or { tool: { name } } (Gemini)
  let toolName: string | null = null;
  if (typeof obj["tool_name"] === "string") toolName = obj["tool_name"];
  else if (obj["tool"] && typeof obj["tool"] === "object") {
    const t = obj["tool"] as Record<string, unknown>;
    if (typeof t["name"] === "string") toolName = t["name"];
  }

  return { filePath, sessionId, command, toolName };
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

const DEFAULT_MIN_LINES = 50;

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

    // Resolve the file path relative to the repo root for lookup.
    // Manifest keys are POSIX-style; normalize separators and collapse `./`, `//`
    // so that Windows backslashes and mixed slashes resolve to a single canonical key.
    const relPath = pathPosix.normalize(relative(repoRoot, filePath).split("\\").join("/"));
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

// ---------------------------------------------------------------------------
// SessionStart / SessionGate / SentinelWriter / Agent gate hooks
// Inspired by cmm-claude-code-setup (https://github.com/halindrome/cmm-claude-code-setup)
// ---------------------------------------------------------------------------

function getSessionSentinelPath(sessionId: string | null): string {
  const id = sessionId ?? "default";
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 16);
  return join(tmpdir(), `codesift-session-ready-${hash}`);
}

export async function handleSessionStart(): Promise<void> {
  try {
    const raw = readRawInput();
    const { sessionId } = raw ? parseHookInput(raw) : EMPTY_INPUT;
    const sentinel = getSessionSentinelPath(sessionId);
    try { unlinkSync(sentinel); } catch { /* not exist */ }

    // Inject context prompt
    const additionalContext =
      "CodeSift MCP is available (mcp__codesift__* tools). " +
      "Before searching code with built-in Grep/Glob/Read, prefer CodeSift tools: " +
      "search_text, get_file_tree, search_symbols, plan_turn. " +
      "Repo auto-resolves from CWD — no need for list_repos.";

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handleSessionGate
//
// PreToolUse hook with empty matcher (matches ALL tools). Blocks every tool
// EXCEPT the allow-list until a CodeSift tool has been called once
// (sentinel file). Inspired by cmm-claude-code-setup/session-gate.sh.
//
// Allow-list (always permitted):
//   - All mcp__codesift__* (so the agent CAN call them to release the gate)
//   - Agent (so subagents can spawn — they have their own gate)
//   - Skill, ToolSearch, SendMessage, TaskCreate, TaskUpdate, TaskList
//   - PushNotification, ScheduleWakeup
//
// Once any mcp__codesift__index_status / plan_turn / index_folder is called,
// the sentinel is created (by handleSentinelWriter PostToolUse) and all tools
// are unlocked for the rest of the session.
// ---------------------------------------------------------------------------

const SESSION_GATE_ALLOWLIST = new Set([
  "Agent", "Skill", "ToolSearch", "SendMessage",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "PushNotification", "ScheduleWakeup", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "Monitor", "CronCreate", "CronList", "CronDelete", "RemoteTrigger",
]);

export async function handleSessionGate(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    const { toolName, sessionId } = parseHookInput(raw);
    if (!toolName) { process.exit(0); return; }

    // Allow CodeSift tools (they release the gate)
    if (toolName.startsWith("mcp__codesift__")) {
      process.exit(0); return;
    }

    // Allow infrastructure tools
    if (SESSION_GATE_ALLOWLIST.has(toolName)) {
      process.exit(0); return;
    }

    // Allow other MCP tools (sentry, playwright, etc. — not our concern)
    if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__codesift__")) {
      process.exit(0); return;
    }

    // Check sentinel — has CodeSift been called yet?
    const sentinel = getSessionSentinelPath(sessionId);
    if (existsSync(sentinel)) {
      process.exit(0); return;
    }

    // Block — agent must call CodeSift first
    process.stdout.write(
      `CodeSift session not initialized. Call one of these first:\n` +
        `  mcp__codesift__index_status() — check if repo is indexed\n` +
        `  mcp__codesift__plan_turn(query="...") — natural-language tool router\n` +
        `  mcp__codesift__get_file_tree() — list repo files\n` +
        `Then '${toolName}' will be allowed.\n`,
    );
    process.exit(2);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handleSentinelWriter
//
// PostToolUse hook for mcp__codesift__* tools. Creates the session-ready
// sentinel so subsequent tool calls pass the SessionGate.
// ---------------------------------------------------------------------------

export async function handleSentinelWriter(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    const { sessionId } = parseHookInput(raw);
    const sentinel = getSessionSentinelPath(sessionId);
    try {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, String(Date.now()), "utf-8");
    } catch { /* best-effort */ }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckAgent
//
// PreToolUse hook for the Agent tool. Blocks Task/Explore subagent spawns
// whose prompt does NOT reference CodeSift tool names. Forces parent agent
// to either do the work itself with CodeSift, or pass CodeSift tool names
// in the subagent prompt. Inspired by cmm/agent-cmm-gate.sh.
// ---------------------------------------------------------------------------

const CODESIFT_TOOL_KEYWORDS = [
  "search_text", "search_symbols", "get_file_tree", "get_file_outline",
  "get_symbol", "get_symbols", "find_references", "trace_call_chain",
  "trace_route", "codebase_retrieval", "assemble_context", "plan_turn",
  "find_dead_code", "scan_secrets", "review_diff", "audit_scan",
  "detect_communities", "analyze_complexity", "analyze_hotspots",
  "impact_analysis", "find_and_show", "discover_tools", "describe_tools",
  "codesift", "CodeSift",
];

export async function handlePrecheckAgent(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { process.exit(0); return; }
    if (!parsed || typeof parsed !== "object") { process.exit(0); return; }

    const obj = parsed as Record<string, unknown>;
    const ti = obj["tool_input"] as Record<string, unknown> | undefined;
    if (!ti) { process.exit(0); return; }

    const subagentType = typeof ti["subagent_type"] === "string" ? ti["subagent_type"] : "";
    const prompt = typeof ti["prompt"] === "string" ? ti["prompt"] : "";

    // Only gate code-exploration subagents
    if (subagentType !== "Explore" && subagentType !== "general-purpose" && subagentType !== "Plan") {
      process.exit(0); return;
    }

    // Allow if prompt mentions any CodeSift keyword
    const lower = prompt.toLowerCase();
    if (CODESIFT_TOOL_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      process.exit(0); return;
    }

    // Detect code-search intent — block these
    const CODE_SEARCH_INTENT = /\b(find|search|investigate|trace|explore|locate|grep|look\s+for|where\s+is|how\s+does|what\s+calls)\b.*\b(code|file|function|class|module|component|symbol|import|method|hook|route|endpoint|service|handler|in\s+the\s+(codebase|project|repo))\b/i;
    if (CODE_SEARCH_INTENT.test(prompt)) {
      // Code search detected without CodeSift keywords — block
    } else if (prompt.length < 200) {
      // Non-code-search short prompt — allow
      process.exit(0); return;
    }

    // Block — subagent prompt should reference CodeSift tools
    process.stdout.write(
      `Subagent '${subagentType}' prompt does not mention any CodeSift tool.\n` +
        `Explore subagent does NOT have access to mcp__codesift__* tools — it will use Grep/Glob/Read.\n` +
        `Either:\n` +
        `  1. Add CodeSift tool names to the subagent prompt (search_text, get_file_tree, etc.)\n` +
        `  2. Do the work yourself using mcp__codesift__* tools — usually faster and cheaper\n`,
    );
    process.exit(2);
  } catch {
    process.exit(0);
  }
}
