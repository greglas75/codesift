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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SUPPORTED_PLATFORMS = ["codex", "claude", "cursor", "gemini"] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

export interface SetupResult {
  platform: string;
  config_path: string;
  status: "created" | "updated" | "already_configured";
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

const CODEX_TOML_BLOCK = `
[mcp_servers.codesift]
command = "npx"
args = ["-y", "codesift-mcp"]
tool_timeout_sec = 120
`;

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "codesift-mcp"],
};

interface JsonPlatformConfig {
  configDirName: string;
  configFileName: string;
}

const JSON_PLATFORM_CONFIGS: Record<string, JsonPlatformConfig> = {
  claude: { configDirName: ".claude", configFileName: "settings.json" },
  cursor: { configDirName: ".cursor", configFileName: "mcp.json" },
  gemini: { configDirName: ".gemini", configFileName: "settings.json" },
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

async function setupCodex(): Promise<SetupResult> {
  const configDir = join(homedir(), ".codex");
  const configPath = join(configDir, "config.toml");

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const content = await readFile(configPath, "utf-8");
    if (content.includes("[mcp_servers.codesift]")) {
      return { platform: "codex", config_path: configPath, status: "already_configured" };
    }
    // Append to existing file
    const newContent = content.trimEnd() + "\n" + CODEX_TOML_BLOCK;
    await writeFile(configPath, newContent, "utf-8");
    return { platform: "codex", config_path: configPath, status: "updated" };
  }

  // Create new file
  await writeFile(configPath, CODEX_TOML_BLOCK.trimStart(), "utf-8");
  return { platform: "codex", config_path: configPath, status: "created" };
}

// ---------------------------------------------------------------------------
// JSON-based platform setup (Claude, Cursor, Gemini)
// ---------------------------------------------------------------------------

async function setupJsonPlatform(platform: string): Promise<SetupResult> {
  const config = JSON_PLATFORM_CONFIGS[platform];
  if (!config) throw new Error(`No JSON config for platform: ${platform}`);

  const configDir = join(homedir(), config.configDirName);
  const configPath = join(configDir, config.configFileName);

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const settings = await readJsonFile(configPath);
    const mcpServers = settings["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers?.["codesift"]) {
      return { platform, config_path: configPath, status: "already_configured" };
    }
    if (!settings["mcpServers"]) {
      settings["mcpServers"] = {};
    }
    (settings["mcpServers"] as Record<string, unknown>)["codesift"] = { ...MCP_SERVER_ENTRY };
    await writeJsonFile(configPath, settings);
    return { platform, config_path: configPath, status: "updated" };
  }

  await writeJsonFile(configPath, { mcpServers: { codesift: { ...MCP_SERVER_ENTRY } } });
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

// ---------------------------------------------------------------------------
// Claude Code hooks — .claude/settings.local.json
// ---------------------------------------------------------------------------

const CLAUDE_HOOKS: Record<string, HookEntry[]> = {
  PreToolUse: [
    { matcher: "Read", hooks: [{ type: "command", command: "codesift precheck-read" }] },
    { matcher: "Bash", hooks: [{ type: "command", command: "codesift precheck-bash" }] },
  ],
  PostToolUse: [
    { matcher: "Write|Edit", hooks: [{ type: "command", command: "codesift postindex-file" }] },
  ],
  PreCompact: [
    { matcher: "", hooks: [{ type: "command", command: "codesift precompact-snapshot" }] },
  ],
};

export async function setupClaudeHooks(): Promise<void> {
  const configDir = join(homedir(), ".claude");
  const settingsPath = join(configDir, "settings.local.json");
  await ensureDir(configDir);

  const { root, hooks } = await loadHooksSection(settingsPath);

  for (const [event, entries] of Object.entries(CLAUDE_HOOKS)) {
    for (const entry of entries) {
      ensureHookEntry(hooks, event, entry);
    }
  }

  await writeJsonFile(settingsPath, root);
}

// ---------------------------------------------------------------------------
// Codex CLI hooks — ~/.codex/hooks.json
// ---------------------------------------------------------------------------
// Codex only has the Bash tool — Read-redirect and PostToolUse don't apply.
// No PreCompact event. Install: Stop (conversation indexing) only.
// ---------------------------------------------------------------------------

export async function setupCodexHooks(): Promise<void> {
  const configDir = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const hooksPath = join(configDir, "hooks.json");
  await ensureDir(configDir);

  const { root, hooks } = await loadHooksSection(hooksPath);

  if (!Array.isArray(hooks["Stop"])) {
    hooks["Stop"] = [];
  }
  if (!hasCodesiftHook(hooks["Stop"])) {
    hooks["Stop"].push({
      matcher: "",
      hooks: [{ type: "command", command: "codesift index-conversations --quiet" }],
    });
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
  SessionEnd: {
    matcher: "",
    hooks: [{ type: "command", command: "codesift index-conversations --quiet" }],
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
}

const PLATFORM_HANDLERS: Record<Platform, () => Promise<SetupResult>> = {
  codex: setupCodex,
  claude: () => setupJsonPlatform("claude"),
  cursor: () => setupJsonPlatform("cursor"),
  gemini: () => setupJsonPlatform("gemini"),
};

export async function setup(platform: string, options?: SetupOptions): Promise<SetupResult> {
  const handler = PLATFORM_HANDLERS[platform as Platform];
  if (!handler) {
    throw new Error(
      `Unknown platform: "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}, all`,
    );
  }
  const result = await handler();
  if (options?.hooks) {
    const hookInstaller = PLATFORM_HOOK_INSTALLERS[platform as HookPlatform];
    if (hookInstaller) {
      await hookInstaller();
    }
    if (platform === "claude") {
      // Auto-install rules with hooks — agents need rules to know the full tool mapping
      await installRules(platform, homedir(), options);
    }
  }
  if (options?.rules && !(options?.hooks && platform === "claude")) {
    await installRules(platform, homedir(), options);
  }
  return result;
}

export async function setupAll(options?: SetupOptions): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  for (const platform of SUPPORTED_PLATFORMS) {
    const result = await setup(platform, options);
    results.push(result);
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
  const result = await handler();
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
        claude: join(homedir(), ".claude", "settings.local.json"),
        codex: join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "hooks.json"),
        gemini: join(homedir(), ".gemini", "settings.json"),
      };
      const hooksPath = hookPaths[platform] ?? "hooks";
      lines.push(`✓ hooks configured ${hooksPath}`);
    }
  }

  return lines;
}
