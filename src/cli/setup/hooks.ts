import { existsSync } from "node:fs";
import { readJsonFile } from "./fs.js";

export type HookEntry = { matcher: string; hooks: unknown[] };
export type HooksSection = Record<string, HookEntry[]>;

export async function loadHooksSection(
  configPath: string,
): Promise<{ root: Record<string, unknown>; hooks: HooksSection }> {
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    root = await readJsonFile(configPath);
  }
  if (
    typeof root["hooks"] !== "object" ||
    root["hooks"] === null ||
    Array.isArray(root["hooks"])
  ) {
    root["hooks"] = {};
  }
  return { root, hooks: root["hooks"] as HooksSection };
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
