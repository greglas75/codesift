import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
import { ensureDir, writeJsonFile } from "./fs.js";
import { daemonHttpUrl, resolveMcpServerEntry } from "./mcp.js";
import { hasCodesiftHook, loadHooksSection } from "./hooks.js";

export function stripCodesiftToolApprovalOverrides(
  content: string,
): { content: string; removed: number } {
  const expression = /\[mcp_servers\.codesift\.tools\.[^\]]+\][\t ]*\r?\napproval_mode[\t ]*=[\t ]*"[^"]*"[\t ]*\r?\n?/g;
  const matches = content.match(expression);
  if (!matches || matches.length === 0) {
    return { content, removed: 0 };
  }
  return {
    content: content.replace(expression, "").replace(/\n{3,}/g, "\n\n"),
    removed: matches.length,
  };
}

export function ensureCodesiftDefaultToolsApprovalAuto(
  content: string,
): { content: string; changed: boolean } {
  const header = "[mcp_servers.codesift]";
  const start = content.indexOf(header);
  if (start === -1) return { content, changed: false };

  const afterHeader = start + header.length;
  const nextTableOffset = content.slice(afterHeader).search(/\n\[[^\]]+\]/);
  const end = nextTableOffset === -1 ? content.length : afterHeader + nextTableOffset;
  const block = content.slice(start, end);
  const approvalExpression = /^default_tools_approval_mode[\t ]*=[\t ]*"[^"]*"[\t ]*$/m;
  if (approvalExpression.test(block)) {
    const updatedBlock = block.replace(
      approvalExpression,
      'default_tools_approval_mode = "auto"',
    );
    return updatedBlock === block
      ? { content, changed: false }
      : { content: content.slice(0, start) + updatedBlock + content.slice(end), changed: true };
  }

  const prefix = content.slice(0, end).replace(/\n?$/, "\n");
  const suffix = content.slice(end);
  return {
    content:
      prefix +
      'default_tools_approval_mode = "auto"' +
      (suffix.startsWith("\n") || suffix === "" ? "" : "\n") +
      suffix,
    changed: true,
  };
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function getCodexServerEntryLines(options?: SetupOptions): string {
  if (options?.http) {
    return "url = " + jsonString(daemonHttpUrl(options.port));
  }
  const entry = resolveMcpServerEntry();
  return (
    "command = " +
    jsonString(entry.command) +
    "\nargs = [" +
    entry.args.map((arg) => jsonString(arg)).join(", ") +
    "]"
  );
}

function getCodexTomlBlock(options?: SetupOptions): string {
  return (
    "\n[mcp_servers.codesift]\n" +
    getCodexServerEntryLines(options) +
    '\ntool_timeout_sec = 120\ndefault_tools_approval_mode = "auto"\n'
  );
}

function extractCodesiftTomlBlock(
  content: string,
): { start: number; end: number; block: string } | null {
  const header = "[mcp_servers.codesift]";
  const start = content.indexOf(header);
  if (start === -1) return null;
  const afterHeader = start + header.length;
  const nextTableOffset = content.slice(afterHeader).search(/\n\[[^\]]+\]/);
  const end = nextTableOffset === -1 ? content.length : afterHeader + nextTableOffset;
  return { start, end, block: content.slice(start, end) };
}

function normalizeCodesiftTomlServerEntry(
  content: string,
  options?: SetupOptions,
): { content: string; changed: boolean } {
  const found = extractCodesiftTomlBlock(content);
  if (!found) return { content, changed: false };

  const desiredHttp = options?.http === true;
  const block = found.block;
  const hasHttp = /^url[\t ]*=/m.test(block);
  const hasStdio = /^(command|args)[\t ]*=/m.test(block);
  const hasDistServer = /dist\/server\.js/.test(block);

  // An npx command is only LEGACY when it does not carry the package in args.
  // `command = "npx"` + `args = ["-y", "codesift-mcp"]` is precisely what
  // getCodexServerEntryLines emits when the binary is not globally installed
  // (the documented npx install path). The old regex matched any npx command,
  // so it flagged the desired entry as legacy — setup rewrote config.toml on
  // every single run and never reported `already_configured`. Only the
  // argument-less legacy form (`command = "npx"`, no codesift-mcp in args) is
  // still migrated.
  const hasNpxCommand = /^command[\t ]*=[\t ]*"[^"]*npx"/m.test(block);
  const argsCarryPackage = /^args[\t ]*=.*codesift-mcp/m.test(block);
  const hasLegacyNpx = hasNpxCommand && !argsCarryPackage;

  const shouldRewrite =
    desiredHttp !== hasHttp ||
    (desiredHttp ? hasStdio : hasHttp || hasLegacyNpx || hasDistServer);
  if (!shouldRewrite) return { content, changed: false };

  const withoutEntry = block.replace(/^(command|args|url)[\t ]*=.*(?:\r?\n)?/gm, "");
  const rest = withoutEntry
    .replace("[mcp_servers.codesift]", "")
    .replace(/^\s*\n/, "")
    .trimEnd();
  const updatedBlock =
    "[mcp_servers.codesift]\n" +
    getCodexServerEntryLines(options) +
    (rest ? "\n" + rest : "") +
    "\n";
  return {
    content: content.slice(0, found.start) + updatedBlock + content.slice(found.end),
    changed: true,
  };
}

export async function setupCodex(options?: SetupOptions): Promise<SetupResult> {
  const configDir = join(homedir(), ".codex");
  const configPath = join(configDir, "config.toml");
  await ensureDir(configDir);

  if (!existsSync(configPath)) {
    await writeFile(configPath, getCodexTomlBlock(options).trimStart(), "utf-8");
    return { platform: "codex", config_path: configPath, status: "created" };
  }

  const original = await readFile(configPath, "utf-8");
  const { content: cleaned, removed } = stripCodesiftToolApprovalOverrides(original);
  const normalizedEntry = normalizeCodesiftTomlServerEntry(cleaned, options);
  const normalized = ensureCodesiftDefaultToolsApprovalAuto(normalizedEntry.content);
  const content = normalized.content;
  const noteFields =
    removed > 0
      ? { note: "removed " + removed + " per-tool approval override" + (removed === 1 ? "" : "s") + " on mcp_servers.codesift" }
      : {};

  if (content.includes("[mcp_servers.codesift]")) {
    if (removed > 0 || normalized.changed || normalizedEntry.changed) {
      await writeFile(configPath, content, "utf-8");
      return { platform: "codex", config_path: configPath, status: "updated", ...noteFields };
    }
    return { platform: "codex", config_path: configPath, status: "already_configured" };
  }

  await writeFile(configPath, content.trimEnd() + "\n" + getCodexTomlBlock(options), "utf-8");
  return { platform: "codex", config_path: configPath, status: "updated", ...noteFields };
}

export async function setupCodexHooks(): Promise<void> {
  const configDir = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const hooksPath = join(configDir, "hooks.json");
  await ensureDir(configDir);
  const { root, hooks } = await loadHooksSection(hooksPath);

  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !hasCodesiftHook([entry]));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  await writeJsonFile(hooksPath, root);
}
