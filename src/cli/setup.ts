// ---------------------------------------------------------------------------
// CLI setup facade — platform implementations live in ./setup/
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";
import type { HookPlatform } from "./platform.js";
import { setupClineHooks } from "./shell-templates.js";
import { installGitHooks } from "./git-hooks-installer.js";
import { setupClaude, setupClaudeHooks } from "./setup/claude.js";
import {
  setupCodex,
  setupCodexHooks,
  stripCodesiftToolApprovalOverrides,
  ensureCodesiftDefaultToolsApprovalApprove,
} from "./setup/codex.js";
import { setupCursor } from "./setup/cursor.js";
import { setupAntigravity, setupGemini, setupGeminiHooks } from "./setup/gemini.js";
import { buildJsonServerEntry, daemonHttpUrl } from "./setup/mcp.js";
import { installGlobalClaudeMd, installRules } from "./setup/rules.js";
import type { InstallRulesResult, SetupOptions, SetupResult } from "./setup/types.js";

export const SUPPORTED_PLATFORMS = ["codex", "claude", "cursor", "gemini", "antigravity"] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type { InstallRulesResult, SetupOptions, SetupResult } from "./setup/types.js";

export {
  buildJsonServerEntry,
  daemonHttpUrl,
  ensureCodesiftDefaultToolsApprovalApprove,
  installRules,
  setupClaudeHooks,
  setupCodexHooks,
  setupGeminiHooks,
  setupClineHooks,
  stripCodesiftToolApprovalOverrides,
};

const PLATFORM_HANDLERS: Record<
  Platform,
  (options?: SetupOptions) => Promise<SetupResult>
> = {
  codex: setupCodex,
  claude: setupClaude,
  cursor: setupCursor,
  gemini: setupGemini,
  antigravity: setupAntigravity,
};

const PLATFORM_HOOK_INSTALLERS: Partial<Record<HookPlatform, () => Promise<void>>> = {
  claude: setupClaudeHooks,
  codex: setupCodexHooks,
  gemini: setupGeminiHooks,
  cline: setupClineHooks,
};

function requirePlatformHandler(
  platform: string,
): (options?: SetupOptions) => Promise<SetupResult> {
  const handler = PLATFORM_HANDLERS[platform as Platform];
  if (!handler) {
    throw new Error(
      "Unknown platform: \"" + platform + "\". Supported: " + SUPPORTED_PLATFORMS.join(", ") + ", all",
    );
  }
  return handler;
}

export async function setupHooksForPlatform(platform: HookPlatform): Promise<void> {
  const installer = PLATFORM_HOOK_INSTALLERS[platform];
  if (installer) {
    await installer();
  }
}

export async function setup(platform: string, options?: SetupOptions): Promise<SetupResult> {
  const result = await requirePlatformHandler(platform)(options);
  if (options?.hooks) {
    await setupHooksForPlatform(platform as HookPlatform);
    if (platform === "claude") {
      await installRules(platform, homedir(), options);
      await installGlobalClaudeMd(homedir());
    }
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
  const perPlatformOpts: SetupOptions = { ...options, gitHooks: false };
  for (const platform of SUPPORTED_PLATFORMS) {
    results.push(await setup(platform, perPlatformOpts));
  }
  if (options?.hooks && options.gitHooks !== false) {
    await installGitHooks({ force: options.force ?? false });
  }
  return results;
}

const STATUS_MESSAGES: Record<SetupResult["status"], (result: SetupResult) => string> = {
  created: (result) => "✓ Created " + result.config_path,
  updated: (result) => "✓ Added CodeSift MCP server to " + result.config_path,
  already_configured: (result) => "✓ already configured " + result.config_path,
};

const RULES_ACTION_LABELS: Partial<Record<InstallRulesResult["action"], string>> = {
  created: "created",
  updated: "updated",
  "force-updated": "force-updated",
};

export function formatSetupResult(
  result: SetupResult,
  rulesResult?: InstallRulesResult,
): string {
  const lines: string[] = [STATUS_MESSAGES[result.status](result)];
  if (result.note) {
    lines.push("  ↳ " + result.note);
  }
  if (rulesResult && RULES_ACTION_LABELS[rulesResult.action] && rulesResult.path) {
    lines.push("✓ " + RULES_ACTION_LABELS[rulesResult.action] + " " + rulesResult.path);
  }
  return lines.join("\n");
}

export async function formatSetupLines(
  platform: string,
  options?: SetupOptions,
): Promise<string[]> {
  const result = await requirePlatformHandler(platform)(options);
  const lines: string[] = [STATUS_MESSAGES[result.status](result)];

  if (options?.rules) {
    const rulesResult = await installRules(platform, homedir(), options);
    const label = RULES_ACTION_LABELS[rulesResult.action];
    if (label && rulesResult.path) {
      lines.push("✓ " + label + " " + rulesResult.path);
    }
  }

  if (options?.hooks) {
    const hookInstaller = PLATFORM_HOOK_INSTALLERS[platform as HookPlatform];
    if (!hookInstaller) {
      return lines;
    }
    await hookInstaller();
    const hookPaths: Record<string, string> = {
      claude: join(homedir(), ".claude", "settings.json"),
      codex: join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "hooks.json"),
      gemini: join(homedir(), ".gemini", "settings.json"),
    };
    const hooksPath = hookPaths[platform] ?? "hooks";
    lines.push("✓ hooks configured " + hooksPath);
    const codeMarker = String.fromCharCode(96);
    lines.push(
      "  ↳ wiki: run " +
        codeMarker +
        "codesift wiki-generate" +
        codeMarker +
        " manually when you want to refresh repo docs",
    );
  }

  return lines;
}
