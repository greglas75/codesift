import { z } from "zod";

const SymbolKindSchema = z.enum([
  "function", "method", "class", "interface", "type", "variable",
  "constant", "field", "enum", "namespace", "module", "section",
  "metadata", "test_suite", "test_case", "test_hook", "default_export",
  "conversation_turn", "conversation_summary", "unknown",
]);

const SymbolsQuerySchema = z.object({
  type: z.literal("symbols"),
  query: z.string(),
  kind: SymbolKindSchema.optional(),
  file_pattern: z.string().optional(),
  top_k: z.number().int().positive().optional(),
  source_chars: z.number().int().nonnegative().optional(),
});

const TextQuerySchema = z.object({
  type: z.literal("text"),
  query: z.string(),
  regex: z.boolean().optional(),
  context_lines: z.number().int().nonnegative().optional(),
  file_pattern: z.string().optional(),
});

const FileTreeQuerySchema = z.object({
  type: z.literal("file_tree"),
  path: z.string().optional(),
  path_prefix: z.string().optional(),
  name_pattern: z.string().optional(),
  depth: z.number().int().positive().optional(),
  compact: z.boolean().optional(),
  min_symbols: z.number().int().nonnegative().optional(),
});

const OutlineQuerySchema = z.object({
  type: z.literal("outline"),
  file_path: z.string(),
});

const ReferencesQuerySchema = z.object({
  type: z.literal("references"),
  symbol_name: z.string(),
});

const CallChainQuerySchema = z.object({
  type: z.literal("call_chain"),
  symbol_name: z.string(),
  direction: z.enum(["callers", "callees"]).optional(),
  depth: z.number().int().positive().optional(),
  include_source: z.boolean().optional(),
});

const ImpactQuerySchema = z.object({
  type: z.literal("impact"),
  since: z.string(),
  depth: z.number().int().positive().optional(),
  until: z.string().optional(),
  include_source: z.boolean().optional(),
});

const ContextQuerySchema = z.object({
  type: z.literal("context"),
  query: z.string(),
  max_tokens: z.number().int().positive().optional(),
});

const KnowledgeMapQuerySchema = z.object({
  type: z.literal("knowledge_map"),
  focus: z.string().optional(),
  depth: z.number().int().positive().optional(),
});

const SemanticQuerySchema = z.object({
  type: z.literal("semantic"),
  query: z.string(),
  top_k: z.number().int().positive().optional(),
  file_filter: z.string().optional(),
  exclude_tests: z.boolean().optional(),
  source_chars: z.number().int().nonnegative().optional(),
});

const HybridQuerySchema = z.object({
  type: z.literal("hybrid"),
  query: z.string(),
  top_k: z.number().int().positive().optional(),
  file_filter: z.string().optional(),
  exclude_tests: z.boolean().optional(),
});

const ConversationQuerySchema = z.object({
  type: z.literal("conversation"),
  query: z.string(),
  project: z.string().optional(),
  limit: z.number().int().positive().optional().default(5),
});

export const SubQuerySchema = z.discriminatedUnion("type", [
  SymbolsQuerySchema,
  TextQuerySchema,
  FileTreeQuerySchema,
  OutlineQuerySchema,
  ReferencesQuerySchema,
  CallChainQuerySchema,
  ImpactQuerySchema,
  ContextQuerySchema,
  KnowledgeMapQuerySchema,
  SemanticQuerySchema,
  HybridQuerySchema,
  ConversationQuerySchema,
]);

export type SubQuery = z.infer<typeof SubQuerySchema>;

export type SubQueryResult = {
  type: string;
  data: unknown;
  tokens: number;
};

export interface CodebaseRetrievalResult {
  results: SubQueryResult[];
  total_tokens: number;
  truncated: boolean;
  query_count: number;
}
