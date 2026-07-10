import type { SignalBreakdown } from "./tool-ranker-types.js";

const VAGUE_WORDS = new Set([
  "help", "code", "find", "search", "what", "how", "show", "look",
]);

export function generateReasoning(
  id: string,
  query: string,
  signals: SignalBreakdown,
): string {
  const reasons: string[] = [];
  if (signals.identity > 0) reasons.push("exact name match");
  if (signals.lexical > 0.01 && signals.lexicalTokens.length > 0) {
    reasons.push(`keywords: ${signals.lexicalTokens.slice(0, 3).join(", ")}`);
  }
  if (signals.semantic >= 0.55) reasons.push("semantic similarity");
  if (signals.structural >= 0.5) reasons.push("high usage frequency");
  if (signals.framework > 0) reasons.push("relevant to project stack");
  if (reasons.length === 0) {
    const stem = query.trim().slice(0, 30) || id;
    return `general match for "${stem}"`;
  }
  return reasons.join("; ");
}

export function calibrationCap(
  query: string,
  tokens: string[],
  topScore: number,
  secondScore: number,
): number {
  const trimmed = query.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const allVague = tokens.length > 0 && tokens.every((token) => VAGUE_WORDS.has(token));
  if (trimmed.length < 10 || allVague) return 0.5;
  if (wordCount === 1 || tokens.length <= 1) return 0.6;
  if (topScore > 0 && topScore - secondScore < 0.1) return 0.4;
  return 1;
}
