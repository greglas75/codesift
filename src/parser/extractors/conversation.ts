/**
 * Conversation extractor — JSONL format (Claude Code session files).
 *
 * Parses user+assistant exchange pairs from JSONL session logs and emits
 * each pair as a "conversation_turn" CodeSymbol for indexing and search.
 */

import type { CodeSymbol } from "../../types.js";
import { makeSymbolId } from "../symbol-extractor.js";
import { tokenizeText } from "../../search/bm25.js";

const MAX_SOURCE_LENGTH = 5000;
const MAX_NAME_LENGTH = 100;
const MAX_TOOL_INPUT_LENGTH = 200;

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: unknown;
}

interface ConversationRecord {
  type: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  isCompactSummary?: boolean;
  message?: {
    content: string | ContentBlock[];
  };
}

/**
 * Extract text from message.content — handles both plain string and array of
 * content block objects (Claude multi-part format).
 *
 * Block handling:
 *   text         → include text as-is
 *   tool_use     → include "[tool: {name}] {truncated input}"
 *   tool_result  → skip entirely (noise — large file dumps)
 *   image        → replace with "[image]"
 *   thinking     → include thinking text
 *   unknown      → skip
 */
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          parts.push(block.text);
        }
        break;
      case "tool_use": {
        const name = block.name ?? "unknown";
        const inputStr = JSON.stringify(block.input ?? {});
        const truncated =
          inputStr.length > MAX_TOOL_INPUT_LENGTH
            ? inputStr.slice(0, MAX_TOOL_INPUT_LENGTH) + "…"
            : inputStr;
        parts.push(`[tool: ${name}] ${truncated}`);
        break;
      }
      case "tool_result":
        // Skip entirely — tool results contain large file dumps
        break;
      case "image":
        parts.push("[image]");
        break;
      case "thinking":
        if (typeof block.thinking === "string") {
          parts.push(block.thinking);
        }
        break;
      default:
        // Unknown block types — skip
        break;
    }
  }
  return parts.join("");
}

/**
 * Returns true if the message content consists entirely of tool_result blocks
 * (no text visible to the user). Such messages should not create a pending turn.
 */
function isAllToolResults(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  if (content.length === 0) return false;
  return content.every((block) => block.type === "tool_result");
}

/**
 * Extract CodeSymbol[] from a JSONL conversation session file.
 *
 * @param source   Raw JSONL text content
 * @param filePath Relative file path within the repo
 * @param repo     Repository identifier
 */
export function extractConversationSymbols(
  source: string,
  filePath: string,
  repo: string,
): CodeSymbol[] {
  if (!source.trim()) return [];

  const lines = source.split("\n");
  const symbols: CodeSymbol[] = [];

  let pendingUser: { record: ConversationRecord; lineNumber: number } | null = null;
  let turnIndex = 0;

  // Collect compact summaries; only the last one will be emitted
  const compactSummaries: Array<{ text: string; lineNumber: number; record: ConversationRecord }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    let record: ConversationRecord;
    try {
      record = JSON.parse(line) as ConversationRecord;
    } catch {
      // Skip malformed JSON lines without crashing
      continue;
    }

    if (record.type === "user") {
      // Skip user messages that are entirely tool_result blocks (no visible text)
      if (record.message?.content && isAllToolResults(record.message.content)) {
        continue;
      }

      // Skip compact summary messages — collect them separately, do not create turns
      if (record.isCompactSummary === true) {
        const text = record.message?.content
          ? extractText(record.message.content)
          : "";
        compactSummaries.push({ text, lineNumber: i + 1, record });
        continue;
      }

      // Start a new pending pair (overwrite any orphan user record)
      pendingUser = { record, lineNumber: i + 1 }; // 1-based
    } else if (record.type === "assistant" && pendingUser !== null) {
      // Pair found — build the symbol
      const userRecord = pendingUser.record;
      const userLineNumber = pendingUser.lineNumber;
      const assistantLineNumber = i + 1; // 1-based

      const userText = userRecord.message?.content
        ? extractText(userRecord.message.content)
        : "";
      const assistantText = record.message?.content
        ? extractText(record.message.content)
        : "";

      const name = userText.slice(0, MAX_NAME_LENGTH);
      const rawSource = `${userText}\n---\n${assistantText}`;
      const truncatedSource =
        rawSource.length > MAX_SOURCE_LENGTH
          ? rawSource.slice(0, MAX_SOURCE_LENGTH)
          : rawSource;

      const id = makeSymbolId(
        repo,
        filePath,
        `turn_${turnIndex}`,
        userLineNumber,
      );

      // BM25 field mapping — signature and docstring hold searchable text
      // (body field is limited to 500 chars, too short for conversations)
      const signature = userText.slice(0, 2000);
      const docstring = assistantText.slice(0, 3000);

      const metaParts: string[] = [];
      if (userRecord.timestamp) metaParts.push(userRecord.timestamp);
      if (userRecord.gitBranch) metaParts.push(userRecord.gitBranch);
      const metaTag = metaParts.length > 0 ? metaParts.join(" | ") : "";

      const sym: CodeSymbol = {
        id,
        repo,
        name,
        kind: "conversation_turn",
        file: filePath,
        start_line: userLineNumber,
        end_line: assistantLineNumber,
        source: truncatedSource,
        signature: metaTag ? `${metaTag}\n${signature}` : signature,
        docstring,
        tokens: tokenizeText(`${userText} ${assistantText}`),
        ...(userRecord.sessionId !== undefined && { parent: userRecord.sessionId }),
      };

      symbols.push(sym);
      turnIndex++;
      pendingUser = null;
    }
    // All other record types (progress, system, file-history-snapshot, etc.) are skipped
  }

  // Emit only the LAST compact summary as a conversation_summary symbol
  if (compactSummaries.length > 0) {
    const last = compactSummaries[compactSummaries.length - 1]!;
    const name = `summary: ${last.text.slice(0, MAX_NAME_LENGTH)}`;
    const truncatedSource =
      last.text.length > MAX_SOURCE_LENGTH
        ? last.text.slice(0, MAX_SOURCE_LENGTH)
        : last.text;

    const id = makeSymbolId(repo, filePath, "summary", last.lineNumber);

    const docParts: string[] = [];
    if (last.record.timestamp) docParts.push(last.record.timestamp);
    if (last.record.gitBranch) docParts.push(last.record.gitBranch);
    const docstring = docParts.length > 0 ? docParts.join(" | ") : undefined;

    const sym: CodeSymbol = {
      id,
      repo,
      name,
      kind: "conversation_summary",
      file: filePath,
      start_line: last.lineNumber,
      end_line: last.lineNumber,
      source: truncatedSource,
      tokens: tokenizeText(last.text),
      ...(docstring !== undefined && { docstring }),
      ...(last.record.sessionId !== undefined && { parent: last.record.sessionId }),
    };

    symbols.push(sym);
  }

  return symbols;
}
