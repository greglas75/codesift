import type { SignalBreakdown } from "./tool-ranker-types.js";

const SIGNAL_WEIGHTS = {
  lexical: 1,
  identity: 2,
  semantic: 0.8,
  structural: 0.1,
  framework: 0.6,
} as const;

export function computeIdentity(query: string, toolName: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerName = toolName.toLowerCase();
  if (!lowerName) return 0;
  return lowerQuery.includes(lowerName) || lowerQuery.includes(lowerName.replace(/_/g, " ")) ? 1 : 0;
}

export function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator > 0 ? dot / denominator : 0;
}

export function normaliseUsage(usage: Map<string, number>, toolName: string): number {
  const value = usage.get(toolName) ?? 0;
  if (value <= 0) return 0;
  let maximum = 0;
  for (const candidate of usage.values()) maximum = Math.max(maximum, candidate);
  return maximum > 0 ? Math.min(1, value / maximum) : 0;
}

export function weightedSignalScore(signals: SignalBreakdown): number {
  return SIGNAL_WEIGHTS.lexical * signals.lexical
    + SIGNAL_WEIGHTS.identity * signals.identity
    + SIGNAL_WEIGHTS.semantic * signals.semantic
    + SIGNAL_WEIGHTS.structural * signals.structural
    + SIGNAL_WEIGHTS.framework * signals.framework;
}
