// ---------------------------------------------------------------------------
// CLI setup command — configure codesift-mcp in AI coding tools
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { HookPlatform } from "./platform.js";
import { setupClineHooks } from "./shell-templates.js";
import { installGitHooks } from "./git-hooks-installer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SUPPORTED_PLATFORMS = ["codex", "claude", "cursor", "gemini", "antigravity"] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

export interface SetupResult {
  platform: string;
  config_path: string;
  status: "created" | "updated" | "already_configured";
  note?: string;
}

export interface InstallRulesResult {
  path: string;
  action: "created" | "updated" | "skipped" | "force-updated" | "error";
  warning?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Platform configs
// ---------------------------------------------------------------------------

// Strip [mcp_servers.codesift.tools.<name>] approval-mode overrides that Codex
// CLI persists when the user picks "Approve each time" on first tool call. They
// override any global trust policy, forcing a prompt per call. Safe to remove —
// tools fall back to the global approval policy after stripping.
export function stripCodesiftToolApprovalOverrides(
  content: string,
): { content: string; removed: number } {
  const re = /\[mcp_servers\.codesift\.tools\.[^\]]+\][\t ]*\r?\napproval_mode[\t ]*=[\t ]*"[^"]*"[\t ]*\r?\n?/g;
  const matches = content.match(re);
  if (!matches || matches.length === 0) {
    return { content, removed: 0 };
  }
  let stripped = content.replace(re, "");
  // Collapse runs of 3+ blank lines (left by removals) down to 2.
  stripped = stripped.replace(/\n{3,}/g, "\n\n");
  return { content: stripped, removed: matches.length };
}

// Codex Desktop may still prompt for MCP calls when the server default is
// missing; make the CodeSift setup explicit so trusted local tools are approved
// automatically by default after setup.
export function ensureCodesiftDefaultToolsApprovalAuto(
  content: string,
): { content: string; changed: boolean } {
  const header = "[mcp_servers.codesift]";
  const start = content.indexOf(header);
  if (start === -1) {
    return { content, changed: false };
  }

  const afterHeader = start + header.length;
  const nextTableOffset = content.slice(afterHeader).search(/\n\[[^\]]+\]/);
  const end = nextTableOffset === -1 ? content.length : afterHeader + nextTableOffset;
  const block = content.slice(start, end);
  const approvalRe = /^default_tools_approval_mode[\t ]*=[\t ]*"[^"]*"[\t ]*$/m;

  if (approvalRe.test(block)) {
    const updatedBlock = block.replace(approvalRe, 'default_tools_approval_mode = "auto"');
    if (updatedBlock === block) {
      return { content, changed: false };
    }
    return { content: content.slice(0, start) + updatedBlock + content.slice(end), changed: true };
  }

  const insertionPoint = block.endsWith("\n") ? end : end;
  const prefix = content.slice(0, insertionPoint).replace(/\n?$/, "\n");
  const suffix = content.slice(insertionPoint);
  return {
    content: `${prefix}default_tools_approval_mode = "auto"${suffix.startsWith("\n") || suffix === "" ? "" : "\n"}${suffix}`,
    changed: true,
  };
}

function getCodexTomlBlock(options?: SetupOptions): string {
  if (options?.http) {
    return `
[mcp_servers.codesift]
url = "${daemonHttpUrl(options.port)}"
tool_timeout_sec = 120
default_tools_approval_mode = "auto"
`;
  }
  const entry = resolveMcpServerEntry();
  const argsToml = entry.args.map((a) => `"${a}"`).join(", ");
  return `
[mcp_servers.codesift]
command = "${entry.command}"
args = [${argsToml}]
tool_timeout_sec = 120
default_tools_approval_mode = "auto"
`;
}

// Resolve MCP server entry — GUI apps (Antigravity, Claude Desktop) don't
// inherit shell PATH, so both "npx" and "node" fail. We resolve full paths
// and prefer direct node invocation when the package is globally installed.
function resolveMcpServerEntry(): { command: string; args: string[] } {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
    // Check if codesift-mcp is globally installed
    const serverPath = execSync("which codesift-mcp", { encoding: "utf-8" }).trim();
    if (nodePath && serverPath) {
      // Resolve symlink to actual server.js path
      const { realpathSync } = require("node:fs") as typeof import("node:fs");
      const realPath = realpathSync(serverPath);
      return { command: nodePath, args: [realPath] };
    }
  } catch { /* not globally installed — fall back to npx */ }
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const npxPath = execSync("which npx", { encoding: "utf-8" }).trim();
    if (npxPath) return { command: npxPath, args: ["-y", "codesift-mcp"] };
  } catch { /* fallback */ }
  return { command: "npx", args: ["-y", "codesift-mcp"] };
}

const MCP_SERVER_ENTRY = resolveMcpServerEntry();

interface JsonPlatformConfig {
  configDirName: string;
  configFileName: string;
}

const JSON_PLATFORM_CONFIGS: Record<string, JsonPlatformConfig> = {
  claude: { configDirName: ".claude", configFileName: "settings.json" },
  cursor: { configDirName: ".cursor", configFileName: "mcp.json" },
  gemini: { configDirName: ".gemini", configFileName: "settings.json" },
  antigravity: { configDirName: ".gemini/antigravity", configFileName: "mcp_config.json" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf-8");
  if (raw.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse ${path} as JSON. Fix the file and retry.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected an object in ${path}, got ${typeof parsed}.`);
  }
  return parsed as Record<string, unknown>;
}

async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// resolvePackageFile — find a file relative to the package root
// ---------------------------------------------------------------------------

function resolvePackageFile(relativePath: string): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Try dist/../<path> first, then src/../../<path>
  for (const base of [join(thisDir, ".."), join(thisDir, "..", "..")]) {
    const candidate = join(base, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve package file: ${relativePath}`);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// installRules — install platform-specific rules file
// ---------------------------------------------------------------------------

const RULES_FILES: Record<string, { source: string; targetDir: string; targetFile: string }> = {
  claude: { source: "rules/codesift.md", targetDir: ".claude/rules", targetFile: "codesift.md" },
  cursor: { source: "rules/codesift.mdc", targetDir: ".cursor/rules", targetFile: "codesift.mdc" },
};

// Append-mode platforms write a delimited block into a file in the cwd
const APPEND_MODE_PLATFORMS: Record<string, { source: string; targetFile: string }> = {
  codex: { source: "rules/codex.md", targetFile: "AGENTS.md" },
  gemini: { source: "rules/gemini.md", targetFile: "GEMINI.md" },
};

const DELIMITER_START = "<!-- codesift-rules-start -->";
const DELIMITER_END = "<!-- codesift-rules-end -->";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// installGlobalClaudeMd — inject a short CodeSift block into ~/.claude/CLAUDE.md
// This file has higher priority than rules/ files (loaded into every session).
// Idempotent via delimiters; respects user content outside the block.
// ---------------------------------------------------------------------------

const CLAUDE_MD_BLOCK = `## CodeSift MCP — code intelligence for this machine

CodeSift MCP is installed (\`mcp__codesift__*\` tools).

**If CodeSift tools appear in "deferred tools" list:** call this FIRST to load schemas:
\`ToolSearch(query="select:mcp__codesift__search_text,mcp__codesift__get_file_tree,mcp__codesift__search_symbols,mcp__codesift__get_symbol,mcp__codesift__plan_turn,mcp__codesift__index_status")\`

When working with code:
- **Use CodeSift tools as default for code search and navigation** — they query a pre-built index (BM25 + tree-sitter symbols + semantic) and return ranked, deduplicated results far cheaper than reading files.
- \`search_text\` instead of Grep for code search
- \`get_file_tree\` instead of Glob for finding files
- \`search_symbols\` / \`get_symbol\` for finding functions/classes
- \`plan_turn(query=...)\` when you don't know which tool fits
- The \`repo\` parameter auto-resolves from CWD — no need to list_repos first

Full rules: \`~/.claude/rules/codesift.md\`. Detailed tool catalog via \`discover_tools\`.`;

async function installGlobalClaudeMd(homeDir: string): Promise<InstallRulesResult> {
  const targetPath = join(homeDir, ".claude", "CLAUDE.md");
  const block = `${DELIMITER_START}\n${CLAUDE_MD_BLOCK}\n${DELIMITER_END}`;

  try {
    if (existsSync(targetPath)) {
      const existing = await readFile(targetPath, "utf-8");
      if (existing.includes(DELIMITER_START) && existing.includes(DELIMITER_END)) {
        const match = existing.match(
          new RegExp(`${escapeRegex(DELIMITER_START)}[\\s\\S]*?${escapeRegex(DELIMITER_END)}`),
        );
        if (match?.[0] === block) {
          return { path: targetPath, action: "skipped" };
        }
        const replaced = existing.replace(
          new RegExp(`${escapeRegex(DELIMITER_START)}[\\s\\S]*?${escapeRegex(DELIMITER_END)}`),
          block,
        );
        await writeFile(targetPath, replaced, "utf-8");
        return { path: targetPath, action: "updated" };
      }
      const newContent = existing.trimEnd() + "\n\n" + block + "\n";
      await writeFile(targetPath, newContent, "utf-8");
      return { path: targetPath, action: "updated" };
    }

    await ensureDir(join(homeDir, ".claude"));
    await writeFile(targetPath, block + "\n", "utf-8");
    return { path: targetPath, action: "created" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: targetPath, action: "error", error: msg };
  }
}

async function installRulesAppendMode(
  platform: string,
  _options?: SetupOptions,
): Promise<InstallRulesResult> {
  const config = APPEND_MODE_PLATFORMS[platform];
  if (!config) return { path: "", action: "error", error: `No append config for ${platform}` };
  const targetPath = join(process.cwd(), config.targetFile);

  try {
    const sourcePath = resolvePackageFile(config.source);
    const sourceContent = (await readFile(sourcePath, "utf-8")).trimEnd();

    const block = `${DELIMITER_START}\n${sourceContent}\n${DELIMITER_END}`;

    if (existsSync(targetPath)) {
      const existing = await readFile(targetPath, "utf-8");

      if (existing.includes(DELIMITER_START) && existing.includes(DELIMITER_END)) {
        const match = existing.match(
          new RegExp(
            `${escapeRegex(DELIMITER_START)}[\\s\\S]*?${escapeRegex(DELIMITER_END)}`,
          ),
        );
        if (match?.[0] === block) {
          return { path: targetPath, action: "skipped" };
        }
        // Replace the delimited block in-place
        const replaced = existing.replace(
          new RegExp(
            `${escapeRegex(DELIMITER_START)}[\\s\\S]*?${escapeRegex(DELIMITER_END)}`,
          ),
          block,
        );
        await writeFile(targetPath, replaced, "utf-8");
        return { path: targetPath, action: "updated" };
      }

      // Append block to existing content
      const newContent = existing.trimEnd() + "\n\n" + block + "\n";
      await writeFile(targetPath, newContent, "utf-8");
      return { path: targetPath, action: "updated" };
    }

    // Create new file with block
    await writeFile(targetPath, block + "\n", "utf-8");
    return { path: targetPath, action: "created" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: targetPath, action: "error", error: msg };
  }
}

const HEADER_REGEX = /^<!-- codesift-rules v([\d.]+) hash:(\w+) -->/;

export async function installRules(
  platform: string,
  homeDir: string,
  options?: SetupOptions,
): Promise<InstallRulesResult> {
  // Append-mode platforms (codex, gemini) write into cwd
  if (APPEND_MODE_PLATFORMS[platform]) {
    return installRulesAppendMode(platform, options);
  }

  const rulesConfig = RULES_FILES[platform];
  if (!rulesConfig) {
    return { path: "", action: "skipped" };
  }

  const targetPath = join(homeDir, rulesConfig.targetDir, rulesConfig.targetFile);

  try {
    // Resolve source file and read it
    const sourcePath = resolvePackageFile(rulesConfig.source);
    const sourceContent = await readFile(sourcePath, "utf-8");

    // Read version from package.json
    const pkgPath = resolvePackageFile("package.json");
    const pkgRaw = await readFile(pkgPath, "utf-8");
    const pkg: unknown = JSON.parse(pkgRaw);
    const version =
      typeof pkg === "object" && pkg !== null && "version" in pkg
        ? String((pkg as Record<string, unknown>)["version"])
        : "unknown";

    // Compute hash of the source content body (everything after the header line)
    const sourceBody = sourceContent.replace(HEADER_REGEX, "").trimStart();
    const sourceHash = sha256(sourceBody);

    // Build the new file content with updated header
    const header = `<!-- codesift-rules v${version} hash:${sourceHash} -->`;
    const newContent = header + "\n" + sourceBody;

    // Check if target already exists
    if (existsSync(targetPath)) {
      const existingContent = await readFile(targetPath, "utf-8");
      const firstLine = existingContent.split("\n")[0] ?? "";
      const match = HEADER_REGEX.exec(firstLine);

      if (match) {
        const existingBody = existingContent.replace(HEADER_REGEX, "").trimStart();
        const bodyUnmodified = sha256(existingBody) === sourceHash;

        if (bodyUnmodified) {
          if (match[1] === version && match[2] === sourceHash) {
            return { path: targetPath, action: "skipped" };
          }
          await writeFile(targetPath, newContent, "utf-8");
          return { path: targetPath, action: "updated" };
        }
      }

      // Body modified or no valid header — treat as user-owned file
      if (!options?.force) {
        return {
          path: targetPath,
          action: "skipped",
          warning: `Rules file has been modified by user. Use --force to overwrite.`,
        };
      }
      await writeFile(targetPath, newContent, "utf-8");
      return { path: targetPath, action: "force-updated" };
    }

    // Target doesn't exist — create dir and write
    const targetDir = join(homeDir, rulesConfig.targetDir);
    await ensureDir(targetDir);
    await writeFile(targetPath, newContent, "utf-8");
    return { path: targetPath, action: "created" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: targetPath, action: "error", error: msg };
  }
}

// ---------------------------------------------------------------------------
// Codex — ~/.codex/config.toml (unique TOML format)
// ---------------------------------------------------------------------------

async function setupCodex(options?: SetupOptions): Promise<SetupResult> {
  const configDir = join(homedir(), ".codex");
  const configPath = join(configDir, "config.toml");

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const original = await readFile(configPath, "utf-8");
    const { content: cleaned, removed } = stripCodesiftToolApprovalOverrides(original);
    const normalized = ensureCodesiftDefaultToolsApprovalAuto(cleaned);
    const content = normalized.content;
    const noteFields = removed > 0
      ? { note: `removed ${removed} per-tool approval override${removed === 1 ? "" : "s"} on mcp_servers.codesift` }
      : {};

    if (content.includes("[mcp_servers.codesift]")) {
      if (removed > 0 || normalized.changed) {
        await writeFile(configPath, content, "utf-8");
        return { platform: "codex", config_path: configPath, status: "updated", ...noteFields };
      }
      return { platform: "codex", config_path: configPath, status: "already_configured" };
    }
    // Append main block to existing file (using cleaned content)
    const newContent = content.trimEnd() + "\n" + getCodexTomlBlock(options);
    await writeFile(configPath, newContent, "utf-8");
    return { platform: "codex", config_path: configPath, status: "updated", ...noteFields };
  }

  // Create new file
  await writeFile(configPath, getCodexTomlBlock(options).trimStart(), "utf-8");
  return { platform: "codex", config_path: configPath, status: "created" };
}

// ---------------------------------------------------------------------------
// JSON-based platform setup (Claude, Cursor, Gemini)
// ---------------------------------------------------------------------------

/** Default shared-daemon port (mirrors DEFAULT_DAEMON_PORT in cli/commands.ts). */
const DEFAULT_DAEMON_PORT = 7077;

/** MCP HTTP endpoint URL for the shared daemon. */
export function daemonHttpUrl(port?: number): string {
  return `http://127.0.0.1:${port ?? DEFAULT_DAEMON_PORT}/mcp`;
}

/**
 * The `codesift` MCP client entry. Default = stdio (command/args). With
 * `options.http` = the shared-daemon HTTP client (`type`/`url`) so every editor
 * window connects to one `codesift serve` process instead of spawning its own.
 */
export function buildJsonServerEntry(options?: SetupOptions): Record<string, unknown> {
  if (options?.http) {
    return { type: "http", url: daemonHttpUrl(options.port) };
  }
  return { ...MCP_SERVER_ENTRY };
}

/** Transport kind of an existing/desired codesift entry: "http" vs stdio. */
function serverEntryKind(entry: unknown): "http" | "stdio" {
  if (entry && typeof entry === "object" && ((entry as Record<string, unknown>)["type"] === "http" || "url" in (entry as object))) {
    return "http";
  }
  return "stdio";
}

async function setupJsonPlatform(platform: string, options?: SetupOptions): Promise<SetupResult> {
  const config = JSON_PLATFORM_CONFIGS[platform];
  if (!config) throw new Error(`No JSON config for platform: ${platform}`);

  const configDir = join(homedir(), config.configDirName);
  const configPath = join(configDir, config.configFileName);
  const entry = buildJsonServerEntry(options);

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const settings = await readJsonFile(configPath);
    const mcpServers = settings["mcpServers"] as Record<string, unknown> | undefined;
    const existing = mcpServers?.["codesift"];
    // Same transport kind already present → leave it (don't churn env-varying
    // stdio paths). Switch only when going stdio↔http.
    if (existing && serverEntryKind(existing) === serverEntryKind(entry)) {
      return { platform, config_path: configPath, status: "already_configured" };
    }
    if (!settings["mcpServers"]) {
      settings["mcpServers"] = {};
    }
    (settings["mcpServers"] as Record<string, unknown>)["codesift"] = entry;
    await writeJsonFile(configPath, settings);
    return { platform, config_path: configPath, status: "updated" };
  }

  await writeJsonFile(configPath, { mcpServers: { codesift: entry } });
  return { platform, config_path: configPath, status: "created" };
}

// ---------------------------------------------------------------------------
// Hook helpers — shared patterns for idempotent hook installation
// ---------------------------------------------------------------------------

type HookEntry = { matcher: string; hooks: unknown[] };
type HooksSection = Record<string, HookEntry[]>;

/** Load or create a hooks section from a JSON config file. */
async function loadHooksSection(configPath: string): Promise<{ root: Record<string, unknown>; hooks: HooksSection }> {
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    root = await readJsonFile(configPath);
  }
  if (typeof root["hooks"] !== "object" || root["hooks"] === null || Array.isArray(root["hooks"])) {
    root["hooks"] = {};
  }
  return { root, hooks: root["hooks"] as HooksSection };
}

/** Idempotent: ensure hooks[event] array exists, add entry if matcher not present. */
function ensureHookEntry(hooks: HooksSection, event: string, entry: HookEntry): void {
  if (!Array.isArray(hooks[event])) {
    hooks[event] = [];
  }
  if (!hooks[event].some((h) => h.matcher === entry.matcher)) {
    hooks[event].push(entry);
  }
}

/** Check if any hook in entries has a codesift command (content-based dedup). */
function hasCodesiftHook(entries: HookEntry[]): boolean {
  return entries.some((h) =>
    (h.hooks as Array<Record<string, unknown>>)?.some?.((hk) =>
      typeof hk === "object" && hk !== null && typeof hk["command"] === "string" && (hk["command"] as string).includes("codesift"),
    ),
  );
}

// Codesift hook subcommands that read the payload from stdin and therefore
// REQUIRE `--stdin`. session-start is included: it resolves the repo from
// process.cwd() for the overview, but still needs the payload's session_id so
// wiki telemetry can be correlated to a session (without --stdin it logged the
// "hook" placeholder).
const STDIN_HOOK_SUBCOMMANDS = [
  "session-start", "session-gate", "precheck-read", "precheck-bash", "precheck-glob",
  "precheck-grep", "precheck-agent", "postindex-file", "sentinel-writer",
  "precompact-snapshot",
] as const;

/**
 * Remove hooks retired in 0.8.14 from existing installs: `session-gate`
 * (blocked the first tool of EVERY session — even in repos with no CodeSift
 * index — forcing a CodeSift call before any work) and `sentinel-writer`
 * (only existed to release that gate). Net friction with little value; the
 * SessionStart overview already primes CodeSift awareness.
 */
function removeRetiredClaudeHooks(hooks: HooksSection): void {
  const retired = (cmd: string): boolean =>
    cmd.includes("session-gate") || cmd.includes("sentinel-writer");
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      const list = (entry as HookEntry).hooks as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(list)) return true;
      return !list.some((hk) => typeof hk["command"] === "string" && retired(hk["command"] as string));
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
}

/**
 * Upgrade pre-existing codesift hook commands that read stdin to include
 * `--stdin`. setup ≤0.8.11 wrote them without the flag, so Claude Code's stdin
 * payload was never read and the hooks no-opped. ensureHookEntry() matches on
 * matcher alone and won't replace an existing entry, so this rewrites the
 * command in place. Idempotent: skips commands that already carry `--stdin`.
 */
function upgradeStdinHookCommands(hooks: HooksSection): void {
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const list = (entry as HookEntry).hooks as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(list)) continue;
      for (const hk of list) {
        const cmd = hk["command"];
        if (typeof cmd !== "string" || !cmd.includes("codesift") || cmd.includes("--stdin")) continue;
        if (STDIN_HOOK_SUBCOMMANDS.some((sub) => new RegExp(`(^|\\s)${sub}(\\s|$)`).test(cmd))) {
          hk["command"] = `${cmd} --stdin`;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Code hooks — ~/.claude/settings.json
//
// NOTE: must be settings.json, not settings.local.json. Claude Code only reads
// settings.local.json at the PROJECT level (<repo>/.claude/settings.local.json);
// a user-level ~/.claude/settings.local.json is silently ignored, which left
// every hook (session-start wiki overview, postindex auto-reindex, prechecks,
// precompact snapshot) dead. Versions ≤0.8.9 wrote to the ignored file —
// migrateLegacyClaudeHooks() cleans those entries up on the next setup run.
// ---------------------------------------------------------------------------

const CLAUDE_HOOKS: Record<string, HookEntry[]> = {
  // NOTE: every input-dependent hook MUST carry `--stdin`. Claude Code delivers
  // the hook payload (tool_input.file_path, session_id, …) on stdin and sets no
  // HOOK_TOOL_INPUT env var; readRawInput() only reads stdin when `--stdin` is
  // present, so a command without it gets null input and no-ops silently. This
  // previously left postindex-file (auto-reindex + wiki auto-regen), every
  // precheck, sentinel-writer, and precompact-snapshot dead — only session-start
  // worked because it resolves the repo from process.cwd() and needs no input.
  PreToolUse: [
    { matcher: "Read", hooks: [{ type: "command", command: "codesift precheck-read --stdin" }] },
    { matcher: "Bash", hooks: [{ type: "command", command: "codesift precheck-bash --stdin" }] },
    { matcher: "Glob", hooks: [{ type: "command", command: "codesift precheck-glob --stdin" }] },
    { matcher: "Grep", hooks: [{ type: "command", command: "codesift precheck-grep --stdin" }] },
    { matcher: "Agent", hooks: [{ type: "command", command: "codesift precheck-agent --stdin" }] },
  ],
  SessionStart: [
    { matcher: "", hooks: [{ type: "command", command: "codesift session-start --stdin" }] },
  ],
  PostToolUse: [
    { matcher: "Write|Edit", hooks: [{ type: "command", command: "codesift postindex-file --stdin" }] },
  ],
  PreCompact: [
    { matcher: "", hooks: [{ type: "command", command: "codesift precompact-snapshot --stdin" }] },
  ],
};

export async function setupClaudeHooks(): Promise<void> {
  const configDir = join(homedir(), ".claude");
  const settingsPath = join(configDir, "settings.json");
  await ensureDir(configDir);

  const { root, hooks } = await loadHooksSection(settingsPath);

  for (const [event, entries] of Object.entries(CLAUDE_HOOKS)) {
    for (const entry of entries) {
      ensureHookEntry(hooks, event, entry);
    }
  }

  // Repair installs from setup ≤0.8.11 that wrote stdin hooks without `--stdin`.
  upgradeStdinHookCommands(hooks);

  // Drop hooks retired in 0.8.14 (session-gate / sentinel-writer) from existing installs.
  removeRetiredClaudeHooks(hooks);

  await writeJsonFile(settingsPath, root);
  await migrateLegacyClaudeHooks(configDir);
}

/**
 * Remove codesift hook entries from the legacy ~/.claude/settings.local.json
 * (written by setup ≤0.8.9, never read by Claude Code at the user level).
 * Non-codesift hooks and all other keys in the file are preserved.
 */
async function migrateLegacyClaudeHooks(configDir: string): Promise<void> {
  const legacyPath = join(configDir, "settings.local.json");
  if (!existsSync(legacyPath)) return;

  let root: Record<string, unknown>;
  try {
    root = await readJsonFile(legacyPath);
  } catch {
    return; // unparseable — leave the user's file alone
  }
  const hooks = root["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return;

  let changed = false;
  const hooksSection = hooks as HooksSection;
  for (const event of Object.keys(hooksSection)) {
    const entries = hooksSection[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !hasCodesiftHook([entry]));
    if (kept.length !== entries.length) {
      changed = true;
      if (kept.length === 0) {
        delete hooksSection[event];
      } else {
        hooksSection[event] = kept;
      }
    }
  }
  if (!changed) return;

  if (Object.keys(hooksSection).length === 0) {
    delete root["hooks"];
  }
  await writeJsonFile(legacyPath, root);
}

// ---------------------------------------------------------------------------
// Codex CLI hooks — ~/.codex/hooks.json
// ---------------------------------------------------------------------------
// Codex Desktop already has its own approval/sandbox model. Installing
// CodeSift shell hooks here creates repeated approval prompts and leaves
// background conversation indexers running after a session ends. Setup now
// removes legacy CodeSift Codex hooks and preserves unrelated user hooks.
// ---------------------------------------------------------------------------

export async function setupCodexHooks(): Promise<void> {
  const configDir = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const hooksPath = join(configDir, "hooks.json");
  await ensureDir(configDir);

  const { root, hooks } = await loadHooksSection(hooksPath);

  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !hasCodesiftHook([entry]));
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  await writeJsonFile(hooksPath, root);
}

// ---------------------------------------------------------------------------
// Gemini CLI hooks — ~/.gemini/settings.json
// ---------------------------------------------------------------------------
// Gemini uses different event names and tool names:
//   PreToolUse → BeforeTool, PostToolUse → AfterTool,
//   PreCompact → PreCompress, Stop → SessionEnd
//   Read → read_file, Edit → replace, Write → write_file
// Gemini passes hook input via stdin (not HOOK_TOOL_INPUT env var).
// ---------------------------------------------------------------------------

const GEMINI_HOOKS: Record<string, HookEntry> = {
  BeforeTool: {
    matcher: "read_file",
    hooks: [{ type: "command", command: "codesift precheck-read --stdin" }],
  },
  AfterTool: {
    matcher: "write_file|replace",
    hooks: [{ type: "command", command: "codesift postindex-file --stdin" }],
  },
  PreCompress: {
    matcher: "",
    hooks: [{ type: "command", command: "codesift precompact-snapshot --stdin" }],
  },
};

export async function setupGeminiHooks(): Promise<void> {
  const configDir = join(homedir(), ".gemini");
  const settingsPath = join(configDir, "settings.json");
  await ensureDir(configDir);

  const { root, hooks } = await loadHooksSection(settingsPath);

  for (const [eventName, hookEntry] of Object.entries(GEMINI_HOOKS)) {
    if (!Array.isArray(hooks[eventName])) {
      hooks[eventName] = [];
    }
    if (!hasCodesiftHook(hooks[eventName])) {
      hooks[eventName].push(hookEntry);
    }
  }

  await writeJsonFile(settingsPath, root);
}

// ---------------------------------------------------------------------------
// Auto-install hooks for detected platform
// ---------------------------------------------------------------------------

export { setupClineHooks };

const PLATFORM_HOOK_INSTALLERS: Partial<Record<HookPlatform, () => Promise<void>>> = {
  claude: setupClaudeHooks,
  codex: setupCodexHooks,
  gemini: setupGeminiHooks,
  cline: setupClineHooks,
};

export async function setupHooksForPlatform(platform: HookPlatform): Promise<void> {
  const installer = PLATFORM_HOOK_INSTALLERS[platform];
  if (installer) {
    await installer();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface SetupOptions {
  hooks?: boolean;
  rules?: boolean;
  force?: boolean;
  /** Install global git post-commit hook for editor-agnostic review-queue
   *  automation. Defaults to true when `hooks: true` is set, since the hook
   *  is editor-agnostic and benefits all platforms equally. Pass `false` to
   *  opt out (e.g., users who manage git hooks via Husky / Lefthook). */
  gitHooks?: boolean;
  /** Write the shared-daemon HTTP client config instead of stdio. Pair with
   *  `codesift serve`. See [[startDaemon]] in cli/commands.ts. */
  http?: boolean;
  /** Daemon port for the HTTP client URL (default 7077). */
  port?: number;
}

const PLATFORM_HANDLERS: Record<Platform, (options?: SetupOptions) => Promise<SetupResult>> = {
  codex: (options) => setupCodex(options),
  claude: (options) => setupJsonPlatform("claude", options),
  cursor: (options) => setupJsonPlatform("cursor", options),
  gemini: (options) => setupJsonPlatform("gemini", options),
  antigravity: (options) => setupJsonPlatform("antigravity", options),
};

export async function setup(platform: string, options?: SetupOptions): Promise<SetupResult> {
  const handler = PLATFORM_HANDLERS[platform as Platform];
  if (!handler) {
    throw new Error(
      `Unknown platform: "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}, all`,
    );
  }
  const result = await handler(options);
  if (options?.hooks) {
    const hookInstaller = PLATFORM_HOOK_INSTALLERS[platform as HookPlatform];
    if (hookInstaller) {
      await hookInstaller();
    }
    if (platform === "claude") {
      // Auto-install rules with hooks — agents need rules to know the full tool mapping
      await installRules(platform, homedir(), options);
      // Inject CodeSift block into ~/.claude/CLAUDE.md (loaded every session, higher priority than rules/)
      await installGlobalClaudeMd(homedir());
    }
    // Editor-agnostic git post-commit hook: auto-update docs/review-queue.md
    // on every commit regardless of which editor/agent invoked it (Cursor,
    // Codex, Antigravity, plain terminal, etc). Default ON unless explicitly
    // disabled via `gitHooks: false` (e.g., for Husky/Lefthook users).
    if (options.gitHooks !== false) {
      await installGitHooks({ force: options.force ?? false });
    }
  }
  if (options?.rules && !(options?.hooks && platform === "claude")) {
    await installRules(platform, homedir(), options);
    if (platform === "claude") {
      await installGlobalClaudeMd(homedir());
    }
  }
  return result;
}

export async function setupAll(options?: SetupOptions): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  // Disable git-hooks per-platform during the loop so we install them ONCE at
  // the end (idempotent but avoids redundant log lines).
  const perPlatformOpts: SetupOptions = { ...options, gitHooks: false };
  for (const platform of SUPPORTED_PLATFORMS) {
    const result = await setup(platform, perPlatformOpts);
    results.push(result);
  }
  if (options?.hooks && options.gitHooks !== false) {
    await installGitHooks({ force: options.force ?? false });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

const STATUS_MESSAGES: Record<SetupResult["status"], (r: SetupResult) => string> = {
  created: (r) => `✓ Created ${r.config_path}`,
  updated: (r) => `✓ Added CodeSift MCP server to ${r.config_path}`,
  already_configured: (r) => `✓ already configured ${r.config_path}`,
};

const RULES_ACTION_LABELS: Partial<Record<InstallRulesResult["action"], string>> = {
  created: "created",
  updated: "updated",
  "force-updated": "force-updated",
};

export function formatSetupResult(result: SetupResult, rulesResult?: InstallRulesResult): string {
  const lines: string[] = [STATUS_MESSAGES[result.status](result)];
  if (result.note) {
    lines.push(`  ↳ ${result.note}`);
  }
  if (rulesResult && RULES_ACTION_LABELS[rulesResult.action] && rulesResult.path) {
    lines.push(`✓ ${RULES_ACTION_LABELS[rulesResult.action]} ${rulesResult.path}`);
  }
  return lines.join("\n");
}

export async function formatSetupLines(
  platform: string,
  options?: SetupOptions,
): Promise<string[]> {
  const handler = PLATFORM_HANDLERS[platform as Platform];
  if (!handler) {
    throw new Error(
      `Unknown platform: "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}, all`,
    );
  }
  const result = await handler(options);
  const lines: string[] = [STATUS_MESSAGES[result.status](result)];

  if (options?.rules) {
    const rulesResult = await installRules(platform, homedir(), options);
    const label = RULES_ACTION_LABELS[rulesResult.action];
    if (label && rulesResult.path) {
      lines.push(`✓ ${label} ${rulesResult.path}`);
    }
  }

  if (options?.hooks) {
    const hookInstaller = PLATFORM_HOOK_INSTALLERS[platform as HookPlatform];
    if (hookInstaller) {
      await hookInstaller();
      const hookPaths: Record<string, string> = {
        claude: join(homedir(), ".claude", "settings.json"),
        codex: join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "hooks.json"),
        gemini: join(homedir(), ".gemini", "settings.json"),
      };
      const hooksPath = hookPaths[platform] ?? "hooks";
      lines.push(`✓ hooks configured ${hooksPath}`);
      // Surface the manual wiki workflow without implying background refresh.
      lines.push(
        "  ↳ wiki: run `codesift wiki-generate` manually when you want to refresh repo docs",
      );
    }
  }

  return lines;
}
