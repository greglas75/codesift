import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { denyTool, isCurrentRepoIndexed } from "./shared.js";
import { EMPTY_INPUT, parseHookInput, readRawInput } from "./input.js";
import { findRepoRootFromDir, logWikiEvent, tryLoadProjectOverview } from "./wiki.js";

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
    try {
      unlinkSync(sentinel);
    } catch {
      // not present
    }

    let additionalContext =
      "CodeSift MCP is available (mcp__codesift__* tools). " +
      "Before searching code with built-in Grep/Glob/Read, prefer CodeSift tools: " +
      "search_text, get_file_tree, search_symbols, plan_turn. " +
      "Repo auto-resolves from CWD — no need for list_repos.";

    if (process.env.CODESIFT_WIKI_OVERVIEW !== "0") {
      const repoRoot = findRepoRootFromDir(process.cwd());
      if (repoRoot) {
        const overview = tryLoadProjectOverview(repoRoot);
        if (overview) {
          additionalContext += overview;
          logWikiEvent("wiki_overview_injected", repoRoot, {
            chars: overview.length,
            modules: (overview.match(/^  - /gm) || []).length,
          }, Math.ceil(overview.length / 4), sessionId);
        }
      }
    }

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
    if (!raw) {
      process.exit(0);
      return;
    }

    const { toolName, sessionId } = parseHookInput(raw);
    if (!toolName) {
      process.exit(0);
      return;
    }

    if (toolName.startsWith("mcp__codesift__")) {
      process.exit(0);
      return;
    }

    if (SESSION_GATE_ALLOWLIST.has(toolName)) {
      process.exit(0);
      return;
    }

    if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__codesift__")) {
      process.exit(0);
      return;
    }

    const sentinel = getSessionSentinelPath(sessionId);
    if (existsSync(sentinel)) {
      process.exit(0);
      return;
    }

    denyTool(
      `CodeSift session not initialized. Call one of these first:\n` +
        `  mcp__codesift__index_status() — check if repo is indexed\n` +
        `  mcp__codesift__plan_turn(query="...") — natural-language tool router\n` +
        `  mcp__codesift__get_file_tree() — list repo files\n` +
        `Then '${toolName}' will be allowed.`,
    );
  } catch {
    process.exit(0);
  }
}

export async function handleSentinelWriter(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { sessionId } = parseHookInput(raw);
    const sentinel = getSessionSentinelPath(sessionId);
    try {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, String(Date.now()), "utf-8");
    } catch {
      // best-effort
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

const CODESIFT_TOOL_KEYWORDS = [
  "search_text", "search_symbols", "get_file_tree", "get_file_outline",
  "index_file", "get_symbol", "get_symbols", "find_references", "trace_call_chain",
  "trace_route", "codebase_retrieval", "assemble_context", "plan_turn",
  "search_all_conversations", "find_dead_code", "scan_secrets", "review_diff", "audit_scan",
  "detect_communities", "analyze_complexity", "analyze_hotspots",
  "impact_analysis", "find_and_show", "discover_tools", "describe_tools",
  "codesift", "CodeSift",
];

export async function handlePrecheckAgent(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.exit(0);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      process.exit(0);
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const ti = obj["tool_input"] as Record<string, unknown> | undefined;
    if (!ti) {
      process.exit(0);
      return;
    }

    const subagentType = typeof ti["subagent_type"] === "string" ? ti["subagent_type"] : "";
    const prompt = typeof ti["prompt"] === "string" ? ti["prompt"] : "";

    if (!isCurrentRepoIndexed()) {
      process.exit(0);
      return;
    }

    if (subagentType !== "Explore" && subagentType !== "general-purpose" && subagentType !== "Plan") {
      process.exit(0);
      return;
    }

    const lower = prompt.toLowerCase();
    if (CODESIFT_TOOL_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      process.exit(0);
      return;
    }

    const codeSearchIntent = /\b(find|search|investigate|trace|explore|locate|grep|look\s+for|where\s+is|how\s+does|what\s+calls)\b.*\b(code|file|function|class|module|component|symbol|import|method|hook|route|endpoint|service|handler|in\s+the\s+(codebase|project|repo))\b/i;
    if (codeSearchIntent.test(prompt)) {
      // Code search detected without CodeSift keywords: block below.
    } else if (prompt.length < 200) {
      process.exit(0);
      return;
    }

    denyTool(
      `Subagent '${subagentType}' prompt does not mention any CodeSift tool.\n` +
        `Explore subagent does NOT have access to mcp__codesift__* tools — it will use Grep/Glob/Read.\n` +
        `Either:\n` +
        `  1. Add CodeSift tool names to the subagent prompt (search_text, get_file_tree, etc.)\n` +
        `  2. Do the work yourself using mcp__codesift__* tools — usually faster and cheaper`,
    );
  } catch {
    process.exit(0);
  }
}
