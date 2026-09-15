import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseJsonObject, writeJsonFile } from "./fs.js";

export type HookEntry = { matcher: string; hooks: unknown[] };
export type HooksSection = Record<string, HookEntry[]>;

/**
 * Hooks are auto-installed on every MCP server start — many processes at once, while
 * the host (Claude Code itself) rewrites the same file too. An existing file that
 * reads as empty is almost certainly one caught mid-write by someone else, so it is
 * refused instead of treated as `{}`: rebuilding from nothing drops every setting that
 * is not a CodeSift hook. `original` is the file as read, for `saveHooksSection`.
 */
export async function loadHooksSection(
  configPath: string,
): Promise<{ root: Record<string, unknown>; hooks: HooksSection; original: string | null }> {
  let root: Record<string, unknown> = {};
  let original: string | null = null;
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    if (raw.trim() === "") {
      throw new Error(
        configPath + " exists but is empty (possibly mid-write by another process); "
        + "refusing to rebuild it from scratch. Retry, or delete the file if it should be empty.",
      );
    }
    root = parseJsonObject(raw, configPath);
    original = JSON.stringify(root);
  }
  if (
    typeof root["hooks"] !== "object" ||
    root["hooks"] === null ||
    Array.isArray(root["hooks"])
  ) {
    root["hooks"] = {};
  }
  return { root, hooks: root["hooks"] as HooksSection, original };
}

/** Write only when installing changed something — a no-op server start leaves the file alone. */
export async function saveHooksSection(
  configPath: string,
  root: Record<string, unknown>,
  original: string | null,
): Promise<boolean> {
  if (original !== null && JSON.stringify(root) === original) return false;
  await writeJsonFile(configPath, root);
  return true;
}

export function ensureHookEntry(hooks: HooksSection, event: string, entry: HookEntry): void {
  if (!Array.isArray(hooks[event])) {
    hooks[event] = [];
  }
  if (!hooks[event].some((hook) => hook.matcher === entry.matcher)) {
    hooks[event].push(entry);
  }
}

export function hasCodesiftHook(entries: HookEntry[]): boolean {
  return entries.some((entry) =>
    (entry.hooks as Array<Record<string, unknown>>)?.some?.((hook) =>
      typeof hook === "object" &&
      hook !== null &&
      typeof hook["command"] === "string" &&
      (hook["command"] as string).includes("codesift"),
    ),
  );
}
