import { homedir } from "node:os";
import { join, resolve } from "node:path";

function getCurrentHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function encodeCwdToClaudePath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function getClaudeConversationProjectPath(
  cwd: string,
  homeDir = getCurrentHomeDir(),
): string {
  return join(homeDir, ".claude", "projects", encodeCwdToClaudePath(resolve(cwd)));
}

export function resolveConversationProjectPath(projectPath?: string): string {
  return projectPath ? resolve(projectPath) : getClaudeConversationProjectPath(process.cwd());
}
