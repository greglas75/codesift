import type { ToolDefinition } from "../register-tools.js";

export interface ToolRecommendation {
  name: string;
  confidence: number;
  reasoning: string;
  suggested_params?: Record<string, string>;
  is_hidden: boolean;
}

export interface ToolRankerContext {
  query: string;
  toolDefs: readonly ToolDefinition[];
  embeddings: Map<string, number[]> | null;
  queryEmbedding: number[] | null;
  usageFrequency: Map<string, number>;
  frameworkTools: string[];
  coreToolNames?: Set<string>;
}

export interface SignalBreakdown {
  lexical: number;
  identity: number;
  semantic: number;
  structural: number;
  framework: number;
  lexicalTokens: string[];
}
