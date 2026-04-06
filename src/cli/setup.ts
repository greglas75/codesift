// ---------------------------------------------------------------------------
// CLI setup command — configure codesift-mcp in AI coding tools
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

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

const HEADER_REGEX = /^<!-- codesift-rules v([\d.]+) hash:(\w+) -->/;

export async function installRules(
  platform: string,
  homeDir: string,
  options?: SetupOptions,
): Promise<InstallRulesResult> {
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
      const firstLine = existingContent.split("\n")[0];
      const match = HEADER_REGEX.exec(firstLine);

      if (match) {
        const existingVersion = match[1];
        const existingHash = match[2];

        // Always verify actual body hash to detect user edits
        const existingBody = existingContent.replace(HEADER_REGEX, "").trimStart();
        const existingBodyHash = sha256(existingBody);
        const bodyUnmodified = existingBodyHash === sourceHash;

        if (bodyUnmodified) {
          // Body matches source template
          if (existingVersion === version && existingHash === sourceHash) {
            // Same version, same hash, same body → nothing to do
            return { path: targetPath, action: "skipped" };
          }
          // Version or header hash differs but body matches → safe update
          await writeFile(targetPath, newContent, "utf-8");
          return { path: targetPath, action: "updated" };
        }

        // Body has been modified by user
        if (!options?.force) {
          return {
            path: targetPath,
            action: "skipped",
            warning: `Rules file has been modified by user. Use --force to overwrite.`,
          };
        }
        // Force overwrite
        await writeFile(targetPath, newContent, "utf-8");
        return { path: targetPath, action: "force-updated" };
      }

      // No valid header found — treat as user-owned file
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
// Codex — ~/.codex/config.toml
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
// Claude Code — ~/.claude/settings.json
// ---------------------------------------------------------------------------

async function setupClaude(): Promise<SetupResult> {
  const configDir = join(homedir(), ".claude");
  const configPath = join(configDir, "settings.json");

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const settings = await readJsonFile(configPath);
    const mcpServers = settings["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers?.["codesift"]) {
      return { platform: "claude", config_path: configPath, status: "already_configured" };
    }
    if (!settings["mcpServers"]) {
      settings["mcpServers"] = {};
    }
    (settings["mcpServers"] as Record<string, unknown>)["codesift"] = { ...MCP_SERVER_ENTRY };
    await writeJsonFile(configPath, settings);
    return { platform: "claude", config_path: configPath, status: "updated" };
  }

  // Create new file
  await writeJsonFile(configPath, { mcpServers: { codesift: { ...MCP_SERVER_ENTRY } } });
  return { platform: "claude", config_path: configPath, status: "created" };
}

// ---------------------------------------------------------------------------
// Cursor — ~/.cursor/mcp.json
// ---------------------------------------------------------------------------

async function setupCursor(): Promise<SetupResult> {
  const configDir = join(homedir(), ".cursor");
  const configPath = join(configDir, "mcp.json");

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const config = await readJsonFile(configPath);
    const mcpServers = config["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers?.["codesift"]) {
      return { platform: "cursor", config_path: configPath, status: "already_configured" };
    }
    if (!config["mcpServers"]) {
      config["mcpServers"] = {};
    }
    (config["mcpServers"] as Record<string, unknown>)["codesift"] = { ...MCP_SERVER_ENTRY };
    await writeJsonFile(configPath, config);
    return { platform: "cursor", config_path: configPath, status: "updated" };
  }

  await writeJsonFile(configPath, { mcpServers: { codesift: { ...MCP_SERVER_ENTRY } } });
  return { platform: "cursor", config_path: configPath, status: "created" };
}

// ---------------------------------------------------------------------------
// Gemini CLI — ~/.gemini/settings.json
// ---------------------------------------------------------------------------

async function setupGemini(): Promise<SetupResult> {
  const configDir = join(homedir(), ".gemini");
  const configPath = join(configDir, "settings.json");

  await ensureDir(configDir);

  if (existsSync(configPath)) {
    const settings = await readJsonFile(configPath);
    const mcpServers = settings["mcpServers"] as Record<string, unknown> | undefined;
    if (mcpServers?.["codesift"]) {
      return { platform: "gemini", config_path: configPath, status: "already_configured" };
    }
    if (!settings["mcpServers"]) {
      settings["mcpServers"] = {};
    }
    (settings["mcpServers"] as Record<string, unknown>)["codesift"] = { ...MCP_SERVER_ENTRY };
    await writeJsonFile(configPath, settings);
    return { platform: "gemini", config_path: configPath, status: "updated" };
  }

  await writeJsonFile(configPath, { mcpServers: { codesift: { ...MCP_SERVER_ENTRY } } });
  return { platform: "gemini", config_path: configPath, status: "created" };
}

// ---------------------------------------------------------------------------
// Claude Code hooks — .claude/settings.local.json
// ---------------------------------------------------------------------------

const PRE_TOOL_USE_HOOK = {
  matcher: "Read",
  hooks: [{ type: "command", command: "codesift precheck-read" }],
};

const POST_TOOL_USE_HOOK = {
  matcher: "Write|Edit",
  hooks: [{ type: "command", command: "codesift postindex-file" }],
};

type HookEntry = { matcher: string; hooks: unknown[] };
type HooksSection = Record<string, HookEntry[]>;

export async function setupClaudeHooks(): Promise<void> {
  const configDir = join(homedir(), ".claude");
  const settingsPath = join(configDir, "settings.local.json");

  await ensureDir(configDir);

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = await readJsonFile(settingsPath);
  }

  if (typeof settings["hooks"] !== "object" || settings["hooks"] === null) {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"] as HooksSection;

  // PreToolUse — add if not already present for matcher "Read"
  if (!Array.isArray(hooks["PreToolUse"])) {
    hooks["PreToolUse"] = [];
  }
  if (!hooks["PreToolUse"].some((h) => h.matcher === PRE_TOOL_USE_HOOK.matcher)) {
    hooks["PreToolUse"].push(PRE_TOOL_USE_HOOK);
  }

  // PostToolUse — add if not already present for matcher "Write|Edit"
  if (!Array.isArray(hooks["PostToolUse"])) {
    hooks["PostToolUse"] = [];
  }
  if (!hooks["PostToolUse"].some((h) => h.matcher === POST_TOOL_USE_HOOK.matcher)) {
    hooks["PostToolUse"].push(POST_TOOL_USE_HOOK);
  }

  await writeJsonFile(settingsPath, settings);
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
  claude: setupClaude,
  cursor: setupCursor,
  gemini: setupGemini,
};

export async function setup(platform: string, options?: SetupOptions): Promise<SetupResult> {
  const handler = PLATFORM_HANDLERS[platform as Platform];
  if (!handler) {
    throw new Error(
      `Unknown platform: "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}, all`,
    );
  }
  const result = await handler();
  if (platform === "claude" && options?.hooks) {
    await setupClaudeHooks();
  }
  if (options?.rules && (platform === "claude" || platform === "cursor")) {
    await installRules(platform, homedir(), options);
  }
  return result;
}

export async function setupAll(options?: SetupOptions): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  for (const platform of SUPPORTED_PLATFORMS) {
    const result = await setup(platform, platform === "claude" ? options : undefined);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

const STATUS_MESSAGES: Record<SetupResult["status"], (r: SetupResult) => string> = {
  created: (r) => `Created ${r.config_path} with CodeSift MCP server.`,
  updated: (r) => `Added CodeSift MCP server to ${r.config_path}.`,
  already_configured: (r) => `CodeSift MCP already configured in ${r.config_path}. No changes made.`,
};

export function formatSetupResult(result: SetupResult): string {
  return STATUS_MESSAGES[result.status](result);
}
