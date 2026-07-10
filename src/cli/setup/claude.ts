import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs.js";
import { ensureHookEntry, hasCodesiftHook, loadHooksSection, type HookEntry, type HooksSection } from "./hooks.js";
import { setupJsonPlatform } from "./mcp.js";

const CLAUDE_CONFIG = { configDirName: ".claude", configFileName: "settings.json" };

const STDIN_HOOK_SUBCOMMANDS = [
  "session-start", "session-gate", "precheck-read", "precheck-bash", "precheck-glob",
  "precheck-grep", "precheck-agent", "postindex-file", "sentinel-writer",
  "precompact-snapshot",
] as const;

const CLAUDE_HOOKS: Record<string, HookEntry[]> = {
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

function removeRetiredClaudeHooks(hooks: HooksSection): void {
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      const list = entry.hooks as Array<Record<string, unknown>> | undefined;
      return !Array.isArray(list) || !list.some((hook) =>
        typeof hook["command"] === "string" &&
        ((hook["command"] as string).includes("session-gate") ||
          (hook["command"] as string).includes("sentinel-writer")),
      );
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
}

function upgradeStdinHookCommands(hooks: HooksSection): void {
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const list = entry.hooks as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(list)) continue;
      for (const hook of list) {
        const command = hook["command"];
        if (
          typeof command !== "string" ||
          !command.includes("codesift") ||
          command.includes("--stdin")
        ) {
          continue;
        }
        if (
          STDIN_HOOK_SUBCOMMANDS.some((subcommand) =>
            new RegExp("(^|\\s)" + subcommand + "(\\s|$)").test(command),
          )
        ) {
          hook["command"] = command + " --stdin";
        }
      }
    }
  }
}

async function migrateLegacyClaudeHooks(configDir: string): Promise<void> {
  const legacyPath = join(configDir, "settings.local.json");
  if (!existsSync(legacyPath)) return;

  let root: Record<string, unknown>;
  try {
    root = await readJsonFile(legacyPath);
  } catch {
    return;
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
      if (kept.length === 0) delete hooksSection[event];
      else hooksSection[event] = kept;
    }
  }
  if (!changed) return;
  if (Object.keys(hooksSection).length === 0) delete root["hooks"];
  await writeJsonFile(legacyPath, root);
}

export function setupClaude(options?: SetupOptions): Promise<SetupResult> {
  return setupJsonPlatform("claude", CLAUDE_CONFIG, options);
}

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

  upgradeStdinHookCommands(hooks);
  removeRetiredClaudeHooks(hooks);
  await writeJsonFile(settingsPath, root);
  await migrateLegacyClaudeHooks(configDir);
}
