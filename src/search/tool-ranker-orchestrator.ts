import { tokenizeText } from "./bm25.js";
import { buildToolBM25Index } from "./tool-ranker-bm25.js";
import { calibrationCap, generateReasoning } from "./tool-ranker-reasoning.js";
import {
  collectToolSignals,
  computeLexicalSignals,
  computeSemanticSignals,
} from "./tool-ranker-signals.js";
import { weightedSignalScore } from "./tool-ranker-signal-math.js";
import type { SignalBreakdown, ToolRankerContext, ToolRecommendation } from "./tool-ranker-types.js";
import type { ToolDefinition } from "../register-tools.js";

const MAX_RECOMMENDATIONS = 10;

interface ScoredTool {
  def: ToolDefinition;
  raw: number;
  signals: SignalBreakdown;
}

export function rankTools(context: ToolRankerContext): ToolRecommendation[] {
  const { query, toolDefs } = context;
  if (toolDefs.length === 0 || !query.trim()) return [];
  const lexical = computeLexicalSignals(query, buildToolBM25Index(toolDefs));
  const semantic = computeSemanticSignals(toolDefs, context.embeddings, context.queryEmbedding);
  const signalContext = {
    query,
    lexical,
    semantic,
    usage: context.usageFrequency,
    frameworkTools: new Set(context.frameworkTools),
  };
  const scored = scoreTools(toolDefs, signalContext).sort((left, right) => right.raw - left.raw);
  const top = scored.slice(0, MAX_RECOMMENDATIONS);
  if (top.length === 0) return [];
  const topRaw = top[0]?.raw ?? 0;
  const cap = calibrationCap(query, tokenizeText(query), topRaw, top[1]?.raw ?? 0);
  const coreNames = context.coreToolNames ?? new Set<string>();
  return top.map((tool) => toRecommendation(tool, query, topRaw, cap, coreNames));
}

function scoreTools(
  definitions: readonly ToolDefinition[],
  context: Parameters<typeof collectToolSignals>[1],
): ScoredTool[] {
  const output: ScoredTool[] = [];
  for (const def of definitions) {
    const signals = collectToolSignals(def.name, context);
    const raw = weightedSignalScore(signals);
    if (raw > 0) output.push({ def, raw, signals });
  }
  return output;
}

function toRecommendation(
  tool: ScoredTool,
  query: string,
  topRaw: number,
  cap: number,
  coreNames: Set<string>,
): ToolRecommendation {
  const normalised = topRaw > 0 ? tool.raw / topRaw : 0;
  const confidence = Math.max(0, Math.min(cap, normalised * cap));
  return {
    name: tool.def.name,
    confidence: Math.round(confidence * 1000) / 1000,
    reasoning: generateReasoning(tool.def.name, query, tool.signals),
    is_hidden: !coreNames.has(tool.def.name),
  };
}
