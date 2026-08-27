import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupOptions, SetupResult } from "./types.js";
import { ensureDir, writeJsonFile, writeSecretFile } from "./fs.js";
import { daemonHttpUrl, resolveMcpServerEntry, assertTokenTransportIsSafe } from "./mcp.js";
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

export function ensureCodesiftDefaultToolsApprovalApprove(
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
      'default_tools_approval_mode = "approve"',
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
      'default_tools_approval_mode = "approve"' +
      (suffix.startsWith("\n") || suffix === "" ? "" : "\n") +
      suffix,
    changed: true,
  };
}

function ensureCodesiftRequired(
  content: string,
): { content: string; changed: boolean } {
  const header = "[mcp_servers.codesift]";
  const start = content.indexOf(header);
  if (start === -1) return { content, changed: false };

  const afterHeader = start + header.length;
  const nextTableOffset = content.slice(afterHeader).search(/\n\[[^\]]+\]/);
  const end = nextTableOffset === -1 ? content.length : afterHeader + nextTableOffset;
  const block = content.slice(start, end);
  const requiredExpression = /^required[\t ]*=[\t ]*(?:true|false)[\t ]*$/m;
  if (requiredExpression.test(block)) {
    const updatedBlock = block.replace(requiredExpression, "required = true");
    return updatedBlock === block
      ? { content, changed: false }
      : { content: content.slice(0, start) + updatedBlock + content.slice(end), changed: true };
  }

  const prefix = content.slice(0, end).replace(/\n?$/, "\n");
  const suffix = content.slice(end);
  return {
    content:
      prefix +
      "required = true" +
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
    // Same guard as the JSON path: a token on a plaintext non-loopback URL is refused.
    assertTokenTransportIsSafe(options);
    const lines = ["url = " + jsonString(daemonHttpUrl(options.port, options.cwd, options.host, options.scheme))];
    if (options.token) {
      lines.push("[mcp_servers.codesift.http_headers]");
      lines.push("Authorization = " + jsonString(`Bearer ${options.token}`));
    }
    return lines.join("\n");
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
    '\ntool_timeout_sec = 120\nrequired = true\ndefault_tools_approval_mode = "approve"\n'
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


/**
 * Remove `[mcp_servers.codesift.env]` when the entry is HTTP.
 *
 * Env vars configure a process this client no longer spawns — under HTTP the daemon carries its
 * own environment. Codex does not ignore the leftover, it refuses the whole file:
 *
 *     Error loading config.toml: env is not supported for streamable_http
 *
 * Verified against codex-cli 0.144.6. Leaving it behind means `setup --http` writes a config the
 * client cannot load at all, which is worse than not converting: every MCP server in the file goes
 * down with it, not just codesift.
 */
function stripCodesiftEnvTable(content: string): { content: string; changed: boolean } {
  const header = "[mcp_servers.codesift.env]";
  const start = content.indexOf(header);
  if (start === -1) return { content, changed: false };
  const after = start + header.length;
  const nextTable = content.slice(after).search(/\n\[[^\]]+\]/);
  const end = nextTable === -1 ? content.length : after + nextTable;
  const before = content.slice(0, start).replace(/\n+$/, "\n");
  return { content: before + content.slice(end).replace(/^\n+/, "\n"), changed: true };
}


/**
 * Keep a project-scoped config out of the repository's history.
 *
 * The file pins an ABSOLUTE path (`?cwd=/Users/someone/DEV/thing`), so committing it hands every
 * other developer a URL pointing at a directory that does not exist on their machine. Left
 * untracked and unignored it also shows up in `git status` forever, which is how it eventually gets
 * committed by accident.
 *
 * Written to `.git/info/exclude`, never to `.gitignore`: the exclusion is a fact about THIS
 * checkout, and editing a tracked file to accommodate a local tool is a change the repo's owners
 * did not ask for. Best-effort — a failure here must not fail the setup.
 */
async function excludeProjectConfigLocally(projectRoot: string): Promise<boolean> {
  try {
    const excludePath = join(projectRoot, ".git", "info", "exclude");
    if (!existsSync(join(projectRoot, ".git"))) return false;
    const current = existsSync(excludePath) ? await readFile(excludePath, "utf-8") : "";
    if (/^\.codex\/?$/m.test(current)) return false;
    await ensureDir(join(projectRoot, ".git", "info"));
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await writeFile(excludePath, `${current}${sep}# codesift: per-project MCP config pins an absolute path\n.codex/\n`);
    return true;
  } catch {
    return false;
  }
}

export async function setupCodex(options?: SetupOptions): Promise<SetupResult> {
  // Codex merges a project's .codex/config.toml INTO the global one rather than replacing it, and
  // the merge is per key. So a project entry carrying `url` lands on a global entry that already
  // carries `command`, and Codex refuses the result outright:
  //
  //     Error loading config.toml: url is not supported for stdio in `mcp_servers.codesift`
  //
  // Verified against codex-cli 0.144.6. The consequence is that a project-scoped HTTP entry cannot
  // coexist with a global STDIO one — the global entry has to be HTTP too (a bare daemon URL with
  // no ?cwd=, which each project then overrides with its own).
  const projectScope = options?.projectScope === true;
  const projectRoot = options?.cwd ?? process.cwd();
  const configDir = projectScope ? join(projectRoot, ".codex") : join(homedir(), ".codex");
  const configPath = join(configDir, "config.toml");
  if (projectScope) {
    const globalToml = join(homedir(), ".codex", "config.toml");
    if (existsSync(globalToml)) {
      const g = await readFile(globalToml, "utf-8");
      const block = extractCodesiftTomlBlock(g);
      if (block && /^(command|args)[\t ]*=/m.test(block.block)) {
        throw new Error(
          "The global ~/.codex/config.toml still defines mcp_servers.codesift as stdio "
          + "(`command = ...`). Codex MERGES the project config into it, so this project's `url` "
          + "would produce `url is not supported for stdio` and Codex would refuse to start. "
          + "Convert the global entry first: `codesift setup codex --http` (no --project), which "
          + "writes a bare daemon URL that each project's config then overrides.",
        );
      }
    }
  }
  await ensureDir(configDir);

  // Runs on every path, not only on creation: a config written before this existed is exactly the
  // one still sitting unignored in someone's `git status`.
  if (projectScope) await excludeProjectConfigLocally(projectRoot);

  if (!existsSync(configPath)) {
    await writeSecretFile(configPath, getCodexTomlBlock(options).trimStart());
    return { platform: "codex", config_path: configPath, status: "created" };
  }

  const original = await readFile(configPath, "utf-8");
  const { content: cleaned, removed } = stripCodesiftToolApprovalOverrides(original);
  // Strip the env sub-table BEFORE normalising: an HTTP entry that keeps it makes Codex refuse the
  // entire config file, taking every other MCP server down with it.
  const envStripped = options?.http === true
    ? stripCodesiftEnvTable(cleaned)
    : { content: cleaned, changed: false };
  const normalizedEntry = normalizeCodesiftTomlServerEntry(envStripped.content, options);
  const normalized = ensureCodesiftDefaultToolsApprovalApprove(normalizedEntry.content);
  const required = ensureCodesiftRequired(normalized.content);
  const content = required.content;
  const noteFields =
    removed > 0
      ? { note: "removed " + removed + " per-tool approval override" + (removed === 1 ? "" : "s") + " on mcp_servers.codesift" }
      : {};

  if (content.includes("[mcp_servers.codesift]")) {
    if (removed > 0 || envStripped.changed || normalized.changed || normalizedEntry.changed || required.changed) {
      await writeSecretFile(configPath, content);
      return { platform: "codex", config_path: configPath, status: "updated", ...noteFields };
    }
    return { platform: "codex", config_path: configPath, status: "already_configured" };
  }

  await writeSecretFile(configPath, content.trimEnd() + "\n" + getCodexTomlBlock(options));
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
