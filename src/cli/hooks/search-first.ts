import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isTestFileStrict } from "../../utils/test-file.js";
import { CODE_EXTENSIONS, denyTool, isCodesiftServerRunning, isPathInIndexedRepo } from "./shared.js";
import { readRawInput } from "./input.js";

/**
 * Search-first gate (PreToolUse Write).
 *
 * Agents duplicate code because nothing makes them look before they write: the
 * grep/find/Read hooks only reroute a search the agent already decided to do, so
 * an agent that goes straight to "create helpers/formatPercent.ts" never meets
 * any of them. This gate fires on exactly that moment — a NEW production source
 * file inside an indexed repo — and asks for one lookup since the last human
 * prompt before the file may be created. Any repo search counts (CodeSift
 * discovery tools, Grep/Glob, grep/rg in Bash, an Explore agent), so the gate
 * never demands a capability the caller lacks.
 *
 * It fails OPEN everywhere: an unreadable or missing transcript, a transcript
 * too large to scan, an unknown hook payload — all allow. A false deny stops
 * real work; a missed nudge only costs what we have today.
 */

/** CodeSift tools that answer "does this already exist?". Matched on the name after the last `__`. */
const CODESIFT_DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  "search_symbols", "search_text", "semantic_search", "codebase_retrieval", "find_and_show",
  "find_clones", "find_references", "plan_turn", "get_file_tree", "get_file_outline",
  "assemble_context", "get_context_bundle", "get_symbols", "search_patterns",
]);

const NATIVE_SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

const SHELL_SEARCH = /(?:^|[\s;&|(`])(?:rg|grep|egrep|ag|ack)\s|git\s+grep\s|codesift\s+(?:search|symbols|find|find-clones|refs|context|retrieve|dup-check)\b/;

/** Stop scanning backwards after this much transcript: beyond it the answer is "unknown" (allow). */
const MAX_SCAN_BYTES = 48 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

interface TranscriptEntry {
  type?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  origin?: { kind?: unknown } | null;
  message?: { content?: unknown } | null;
}

/** A tool_use block that looked something up in the repo. */
export function isSearchToolUse(name: string, input: unknown): boolean {
  if (NATIVE_SEARCH_TOOLS.has(name)) return true;
  if (name.startsWith("mcp__") && name.includes("codesift")) {
    return CODESIFT_DISCOVERY_TOOLS.has(name.slice(name.lastIndexOf("__") + 2));
  }
  const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (name === "Bash") return typeof fields["command"] === "string" && SHELL_SEARCH.test(fields["command"]);
  if (name === "Agent" || name === "Task") return fields["subagent_type"] === "Explore";
  return false;
}

/**
 * A prompt the human typed (or a subagent's brief), which opens a new task window.
 * Tool results, skill bodies (`isMeta`), compaction summaries and background-task
 * notifications are user-role lines too, but none of them starts new work.
 */
export function isHumanPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) return false;
  const kind = entry.origin?.kind ?? "human";
  if (kind !== "human") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => (b as { type?: unknown })?.type === "tool_result");
}

function entrySearched(entry: TranscriptEntry): boolean {
  if (entry.type !== "assistant") return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    return b?.type === "tool_use" && typeof b.name === "string" && isSearchToolUse(b.name, b.input);
  });
}

/**
 * Walk transcript lines from the newest: a search before reaching the latest
 * human prompt → true; the prompt first → false. `null` = could not tell.
 */
export function searchedSinceLastPrompt(linesNewestFirst: Iterable<string>): boolean | null {
  for (const line of linesNewestFirst) {
    // Cheap filters first: most lines are attachments, api records and huge tool results. A tool result
    // is neither a lookup nor a prompt; the unescaped marker cannot occur inside prompt text (JSON escapes it).
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    if (line.includes('"type":"tool_result"')) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entrySearched(entry)) return true;
    if (isHumanPrompt(entry)) return false;
  }
  return null;
}

/** Lines of a JSONL file, newest first, read in chunks from the end. Stops at `maxBytes`. */
export function* readLinesBackward(path: string, maxBytes = MAX_SCAN_BYTES, chunkBytes = CHUNK_BYTES): Generator<string> {
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    const floor = Math.max(0, position - maxBytes);
    let carry = Buffer.alloc(0);
    while (position > floor) {
      const size = Math.min(chunkBytes, position - floor);
      position -= size;
      const chunk = Buffer.alloc(size);
      // A short read would leave zero bytes in the chunk: give up (the caller fails open).
      if (readSync(fd, chunk, 0, size, position) !== size) return;
      const data = Buffer.concat([chunk, carry]);
      // Split on bytes, not on a decoded string: a chunk boundary may fall inside a multi-byte character.
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (end > i + 1) yield data.subarray(i + 1, end).toString("utf-8");
        end = i;
      }
      carry = data.subarray(0, end);
    }
    // The first line is complete only when the whole file was read.
    if (position === 0 && carry.length > 0) yield carry.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** A subagent's own transcript: `<dir>/<session>/subagents/agent-<id>.jsonl` beside the session's. */
export function transcriptFor(transcriptPath: string, agentId: string | null): string | null {
  if (!agentId) return transcriptPath;
  const sessionDir = transcriptPath.replace(/\.jsonl$/, "");
  const agentPath = join(sessionDir, "subagents", `agent-${agentId}.jsonl`);
  return existsSync(agentPath) ? agentPath : null;
}

/** Only brand-new production source files are gated: edits, tests, declarations and generated output are not. */
export function isGatedNewFile(filePath: string): boolean {
  if (!CODE_EXTENSIONS.has(extname(filePath).toLowerCase())) return false;
  if (filePath.endsWith(".d.ts") || isTestFileStrict(filePath)) return false;
  if (/(^|[\\/])(node_modules|dist|build|coverage|\.next|vendor)[\\/]/.test(filePath)) return false;
  return !existsSync(filePath);
}

function denyReason(filePath: string, serverRunning: boolean): string {
  const stem = basename(filePath).replace(/\.[^.]+$/, "");
  const dir = basename(dirname(filePath));
  const lookups = serverRunning
    ? `  search_symbols(query="${stem}")                 — same name or shape\n` +
      `  semantic_search(query="<what the new code does>") — same job under another name\n` +
      `  find_clones(file_pattern="${dir}")                — copies already in that area`
    : `  grep -rn "<key identifier>" <src dir>  — same name or shape`;
  return (
    `New source file ${JSON.stringify(stem + extname(filePath))}: check whether this already exists before creating it.\n` +
    `${lookups}\n` +
    `Reuse or extend what you find; if nothing fits, write the file again — one lookup since the last prompt unlocks it.\n` +
    `(CODESIFT_SEARCH_FIRST=0 turns this gate off.)`
  );
}

interface WriteHookInput {
  filePath: string | null;
  transcriptPath: string | null;
  agentId: string | null;
}

export function parseWriteHookInput(raw: string): WriteHookInput {
  const empty: WriteHookInput = { filePath: null, transcriptPath: null, agentId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const obj = parsed as Record<string, unknown>;
  const toolInput = obj["tool_input"] && typeof obj["tool_input"] === "object"
    ? (obj["tool_input"] as Record<string, unknown>)
    : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    filePath: str(toolInput["file_path"]),
    transcriptPath: str(obj["transcript_path"]),
    agentId: str(obj["agent_id"]),
  };
}

export async function handlePrecheckWrite(): Promise<void> {
  try {
    if (process.env["CODESIFT_SEARCH_FIRST"] === "0") return process.exit(0);
    const raw = readRawInput();
    if (!raw) return process.exit(0);
    const { filePath, transcriptPath, agentId } = parseWriteHookInput(raw);
    if (!filePath || !transcriptPath || !isGatedNewFile(filePath) || !isPathInIndexedRepo(filePath)) {
      return process.exit(0);
    }
    const transcript = transcriptFor(transcriptPath, agentId);
    if (!transcript || !existsSync(transcript)) return process.exit(0);
    if (searchedSinceLastPrompt(readLinesBackward(transcript)) !== false) return process.exit(0);
    denyTool(denyReason(filePath, isCodesiftServerRunning()));
  } catch {
    process.exit(0);
  }
}
