import { readFileSync } from "node:fs";

export interface HookInput {
  filePath: string | null;
  sessionId: string | null;
  command: string | null;
  toolName: string | null;
}

export const EMPTY_INPUT: HookInput = Object.freeze({ filePath: null, sessionId: null, command: null, toolName: null });

export function readRawInput(): string | null {
  const envInput = process.env["HOOK_TOOL_INPUT"];
  if (envInput) return envInput;

  if (process.argv.includes("--stdin")) {
    try {
      return readFileSync(0, "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}

export function parseHookInput(raw: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_INPUT;
  }
  if (parsed === null || typeof parsed !== "object") return EMPTY_INPUT;
  const obj = parsed as Record<string, unknown>;

  let filePath: string | null = null;
  let command: string | null = null;

  if (obj["tool_input"] && typeof obj["tool_input"] === "object") {
    const ti = obj["tool_input"] as Record<string, unknown>;
    if (typeof ti["file_path"] === "string") filePath = ti["file_path"];
    if (typeof ti["command"] === "string") command = ti["command"];
  }

  if (obj["tool"] && typeof obj["tool"] === "object") {
    const tool = obj["tool"] as Record<string, unknown>;
    if (tool["input"] && typeof tool["input"] === "object") {
      const input = tool["input"] as Record<string, unknown>;
      if (filePath === null) {
        if (typeof input["path"] === "string") filePath = input["path"];
        else if (typeof input["file_path"] === "string") filePath = input["file_path"];
      }
      if (command === null && typeof input["command"] === "string") command = input["command"];
    }
  }

  if (filePath === null) {
    for (const key of ["preToolUse", "postToolUse"]) {
      if (obj[key] && typeof obj[key] === "object") {
        const hook = obj[key] as Record<string, unknown>;
        if (hook["args"] && typeof hook["args"] === "object") {
          const args = hook["args"] as Record<string, unknown>;
          if (typeof args["file_path"] === "string") {
            filePath = args["file_path"];
            break;
          }
        }
      }
    }
  }

  let sessionId: string | null = null;
  if (typeof obj["session_id"] === "string") sessionId = obj["session_id"];
  else if (typeof obj["sessionId"] === "string") sessionId = obj["sessionId"];

  let toolName: string | null = null;
  if (typeof obj["tool_name"] === "string") toolName = obj["tool_name"];
  else if (obj["tool"] && typeof obj["tool"] === "object") {
    const t = obj["tool"] as Record<string, unknown>;
    if (typeof t["name"] === "string") toolName = t["name"];
  }

  return { filePath, sessionId, command, toolName };
}
