import { readFileSync } from "node:fs";

const MAX_BOUNDED_READ_LIMIT = 5000;

export interface HookInput {
  filePath: string | null;
  sessionId: string | null;
  command: string | null;
  toolName: string | null;
  hasBoundedRange: boolean;
}

export const EMPTY_INPUT: HookInput = Object.freeze({
  filePath: null,
  sessionId: null,
  command: null,
  toolName: null,
  hasBoundedRange: false,
});

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

function parseBoundedInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasBoundedReadRange(input: Record<string, unknown>): boolean {
  const offset = parseBoundedInteger(input["offset"]);
  const limit = parseBoundedInteger(input["limit"]);
  return (
    offset !== null &&
    limit !== null &&
    offset >= 0 &&
    limit > 0 &&
    limit <= MAX_BOUNDED_READ_LIMIT
  );
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
  let hasBoundedRange = false;

  const useFileCandidate = (candidatePath: unknown, input: Record<string, unknown>): void => {
    if (filePath !== null || typeof candidatePath !== "string") return;
    filePath = candidatePath;
    hasBoundedRange = hasBoundedReadRange(input);
  };

  if (obj["tool_input"] && typeof obj["tool_input"] === "object") {
    const ti = obj["tool_input"] as Record<string, unknown>;
    useFileCandidate(ti["file_path"], ti);
    if (typeof ti["command"] === "string") command = ti["command"];
  }

  if (obj["tool"] && typeof obj["tool"] === "object") {
    const tool = obj["tool"] as Record<string, unknown>;
    if (tool["input"] && typeof tool["input"] === "object") {
      const input = tool["input"] as Record<string, unknown>;
      if (filePath === null) {
        useFileCandidate(input["path"], input);
        useFileCandidate(input["file_path"], input);
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
            useFileCandidate(args["file_path"], args);
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

  return { filePath, sessionId, command, toolName, hasBoundedRange };
}
