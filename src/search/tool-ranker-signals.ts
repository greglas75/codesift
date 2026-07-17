import { searchBM25, type BM25Index } from "./bm25.js";
import { computeIdentity, cosine, normaliseUsage } from "./tool-ranker-signal-math.js";
import type { ToolDefinition } from "../register-tools.js";
import type { SignalBreakdown } from "./tool-ranker-types.js";

export interface SignalCollectionContext {
  query: string;
  lexical: Map<string, { score: number; matches: string[] }>;
  semantic: Map<string, number>;
  usage: Map<string, number>;
  frameworkTools: Set<string>;
}

const BM25_TOP_K = 50;
const TOOL_FIELD_WEIGHTS = {
  name: 5,
  signature: 2.5,
  docstring: 2,
  body: 0,
  comments: 0,
};

export function computeLexicalSignals(
  query: string,
  index: BM25Index,
): Map<string, { score: number; matches: string[] }> {
  const results = searchBM25(index, query, BM25_TOP_K, TOOL_FIELD_WEIGHTS);
  const output = new Map<string, { score: number; matches: string[] }>();
  const topScore = results[0]?.score ?? 0;
  if (topScore <= 0) return output;
  for (const result of results) {
    output.set(result.symbol.id, {
      score: result.score / topScore,
      matches: result.matches ?? [],
    });
  }
  return output;
}

export function computeSemanticSignals(
  toolDefs: readonly ToolDefinition[],
  embeddings: Map<string, number[]> | null,
  queryEmbedding: number[] | null,
): Map<string, number> {
  const output = new Map<string, number>();
  if (!embeddings || !queryEmbedding?.length) return output;
  for (const def of toolDefs) {
    const vector = embeddings.get(def.name);
    if (!vector?.length) continue;
    const similarity = cosine(queryEmbedding, vector);
    if (similarity > 0) output.set(def.name, similarity);
  }
  return output;
}

export function collectToolSignals(
  name: string,
  context: SignalCollectionContext,
): SignalBreakdown {
  const lexicalSignal = context.lexical.get(name);
  return {
    lexical: lexicalSignal?.score ?? 0,
    identity: computeIdentity(context.query, name),
    semantic: context.semantic.get(name) ?? 0,
    structural: normaliseUsage(context.usage, name),
    framework: context.frameworkTools.has(name) ? 1 : 0,
    lexicalTokens: lexicalSignal?.matches ?? [],
  };
}
