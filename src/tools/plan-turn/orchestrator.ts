import { getCodeIndex } from "../index-tools.js";
import {
  CORE_TOOL_NAMES,
  detectAutoLoadToolsCached,
  getToolDefinitions,
} from "../../register-tools.js";
import {
  getToolEmbeddings,
  rankTools,
  type ToolRankerContext,
  type ToolRecommendation,
} from "../../search/tool-ranker.js";
import { loadConfig } from "../../config.js";
import { getSessionState } from "../../storage/session-state.js";
import { resolveRegisteredRepoMeta } from "../../storage/registry.js";
import { getUsageStats } from "../../storage/usage-stats.js";
import type { CodeIndex } from "../../types.js";
import {
  augmentFrameworkToolsForMonorepo,
  detectFrameworkMismatch,
  filterWorkspaceFrameworkTools,
} from "./framework-context.js";
import { parseQuery } from "./query-parser.js";
import {
  buildUnindexedResult,
  collectFileRecommendations,
  collectSymbolRecommendations,
  MAX_FILES,
  MAX_SYMBOLS,
  MAX_TOOLS,
  mergeToolRecommendations,
} from "./recommendations.js";
import { isStaleIndex } from "./stale-index.js";
import type {
  GapAnalysis,
  ParsedQuery,
  PlanTurnMetadata,
  PlanTurnOptions,
  PlanTurnResult,
} from "./types.js";

type SessionState = ReturnType<typeof getSessionState>;
type ToolDefinitions = ReturnType<typeof getToolDefinitions>;
type ToolEmbeddings = Awaited<ReturnType<typeof getToolEmbeddings>>;

interface LoadedRankerContext {
  toolDefinitions: ToolDefinitions;
  usageFrequency: Map<string, number>;
  frameworkTools: string[];
  embeddings: ToolEmbeddings;
}

interface MetadataInput {
  parsed: ParsedQuery;
  batches: ToolRecommendation[][];
  tools: ToolRecommendation[];
  usageFrequency: Map<string, number>;
  frameworkTools: string[];
  embeddingAvailable: boolean;
  sessionState: SessionState;
  staleIndex: boolean;
  startedAt: number;
}

interface ResultInput {
  query: string;
  parsed: ParsedQuery;
  index: CodeIndex;
  loadedContext: LoadedRankerContext;
  tools: ToolRecommendation[];
  alreadyUsed: string[];
  metadata: PlanTurnMetadata;
}

let usageFrequencyCache: Map<string, number> | null = null;

async function getUsageFrequency(): Promise<Map<string, number>> {
  if (usageFrequencyCache) return usageFrequencyCache;
  try {
    const usageStats = await getUsageStats();
    const usageFrequency = new Map<string, number>();
    for (const toolStats of usageStats.tools ?? []) {
      usageFrequency.set(toolStats.tool, toolStats.total_calls ?? 0);
    }
    usageFrequencyCache = usageFrequency;
    return usageFrequency;
  } catch {
    return new Map();
  }
}

export function _resetPlanTurnCaches(): void {
  usageFrequencyCache = null;
}

async function readLastGitCommit(repo: string): Promise<string | undefined> {
  try {
    const config = loadConfig();
    const registeredRepo = await resolveRegisteredRepoMeta(config.registryPath, repo);
    return registeredRepo?.meta.last_git_commit;
  } catch {
    return undefined;
  }
}

function normalizeEvidenceQuery(query: string): string {
  return query.toLowerCase().replace(/[^\w\s]/g, "").trim();
}

function findGapAnalysis(
  parsed: ParsedQuery,
  sessionState: SessionState,
  skipSession: boolean,
): GapAnalysis | undefined {
  const normalizedQuery = normalizeEvidenceQuery(parsed.normalized);
  if (skipSession || normalizedQuery.length === 0) return undefined;
  for (const evidence of sessionState.negativeEvidence) {
    if (normalizeEvidenceQuery(evidence.query) !== normalizedQuery) continue;
    return {
      action: "STOP_AND_REPORT_GAP",
      prior_query: evidence.query,
      prior_result_count: 0,
      suggestion:
        `Prior call to ${evidence.tool} with the same query returned 0 results. `
        + "Reformulate (broaden pattern / drop file filter / try semantic search) "
        + "before retrying.",
    };
  }
  return undefined;
}

function buildGapResult(
  query: string,
  parsed: ParsedQuery,
  gapAnalysis: GapAnalysis,
  sessionState: SessionState,
  startedAt: number,
): PlanTurnResult {
  return {
    query,
    truncated: parsed.truncated,
    confidence: 0,
    tools: [],
    symbols: [],
    files: [],
    reveal_required: [],
    already_used: [],
    gap_analysis: gapAnalysis,
    metadata: {
      intents_detected: parsed.intents.length,
      bm25_candidates: 0,
      embedding_available: false,
      session_queries_seen: sessionState.queries.length,
      duration_ms: Date.now() - startedAt,
      ...(parsed.truncated ? { truncated: true } : {}),
      ...(parsed.is_vague ? { vague_query: true } : {}),
    },
  };
}

async function loadRankerContext(
  parsed: ParsedQuery,
  index: CodeIndex,
): Promise<LoadedRankerContext> {
  const toolDefinitions = getToolDefinitions();
  const [usageFrequency, baseFrameworkTools, embeddings] = await Promise.all([
    getUsageFrequency(),
    detectAutoLoadToolsCached(process.cwd()).catch(() => [] as string[]),
    getToolEmbeddings(toolDefinitions).catch(() => null),
  ]);
  const scopedFrameworkTools = filterWorkspaceFrameworkTools(
    baseFrameworkTools,
    parsed.normalized,
    index,
  );
  return {
    toolDefinitions,
    usageFrequency,
    embeddings,
    frameworkTools: augmentFrameworkToolsForMonorepo(
      scopedFrameworkTools,
      parsed.normalized,
      index,
    ),
  };
}

function rankParsedIntents(
  parsed: ParsedQuery,
  loadedContext: LoadedRankerContext,
): ToolRecommendation[][] {
  const intents = parsed.intents.length > 0 ? parsed.intents : [parsed.normalized];
  const batches: ToolRecommendation[][] = [];
  for (const intent of intents) {
    if (!intent.trim()) continue;
    const rankerContext: ToolRankerContext = {
      query: intent,
      toolDefs: loadedContext.toolDefinitions,
      embeddings: loadedContext.embeddings,
      queryEmbedding: null,
      usageFrequency: loadedContext.usageFrequency,
      frameworkTools: loadedContext.frameworkTools,
      coreToolNames: CORE_TOOL_NAMES,
    };
    try {
      batches.push(rankTools(rankerContext));
    } catch {
      batches.push([]);
    }
  }
  return batches;
}

function partitionSessionRecommendations(
  recommendations: ToolRecommendation[],
  sessionState: SessionState,
  skipSession: boolean,
): { primary: ToolRecommendation[]; alreadyUsed: string[] } {
  const alreadyCalled = new Set<string>();
  if (!skipSession) {
    for (const query of sessionState.queries) alreadyCalled.add(query.tool);
  }
  const primary: ToolRecommendation[] = [];
  const alreadyUsed: string[] = [];
  for (let index = 0; index < recommendations.length; index++) {
    const recommendation = recommendations[index];
    if (!recommendation) continue;
    if (alreadyCalled.has(recommendation.name) && index >= 3) {
      alreadyUsed.push(recommendation.name);
    } else {
      primary.push(recommendation);
    }
  }
  return { primary, alreadyUsed };
}

function selectTools(primary: ToolRecommendation[], maxTools: number): ToolRecommendation[] {
  const tools = primary.slice(0, maxTools);
  if (tools.length > 0) return tools;
  return [{
    name: "discover_tools",
    confidence: 0.3,
    reasoning: "No direct matches, fall back to explicit search",
    is_hidden: !CORE_TOOL_NAMES.has("discover_tools"),
  }];
}

function collectRevealRequired(tools: ToolRecommendation[]): string[] {
  return tools
    .filter((tool) => tool.is_hidden && !CORE_TOOL_NAMES.has(tool.name))
    .map((tool) => tool.name);
}

function buildMetadata(input: MetadataInput): PlanTurnMetadata {
  const topConfidence = input.tools[0]?.confidence ?? 0;
  const secondConfidence = input.tools[1]?.confidence ?? 0;
  const hasLowDiscrimination = input.tools.length >= 2
    && Math.abs(topConfidence - secondConfidence) < 0.05;
  return {
    intents_detected: input.parsed.intents.length,
    bm25_candidates: input.batches.reduce((sum, batch) => sum + batch.length, 0),
    embedding_available: input.embeddingAvailable,
    session_queries_seen: input.sessionState.queries.length,
    duration_ms: Date.now() - input.startedAt,
    ...(input.parsed.truncated ? { truncated: true } : {}),
    ...(input.parsed.is_vague ? { vague_query: true } : {}),
    ...(input.staleIndex ? { stale_index: true } : {}),
    ...(hasLowDiscrimination ? { low_discrimination: true } : {}),
    ...(detectFrameworkMismatch(input.parsed.normalized, input.frameworkTools)
      ? { framework_mismatch: true }
      : {}),
    ...(input.usageFrequency.size === 0 ? { cold_start: true } : {}),
  };
}

function buildSuccessfulResult(input: ResultInput): PlanTurnResult {
  const result: PlanTurnResult = {
    query: input.query,
    truncated: input.parsed.truncated,
    confidence: Math.round(Math.max(...input.tools.map((tool) => tool.confidence)) * 1000) / 1000,
    tools: input.tools,
    symbols: collectSymbolRecommendations(input.parsed, input.index).slice(0, MAX_SYMBOLS),
    files: collectFileRecommendations(input.parsed, input.index).slice(0, MAX_FILES),
    reveal_required: collectRevealRequired(input.tools),
    already_used: input.alreadyUsed,
    metadata: input.metadata,
  };
  if (input.loadedContext.frameworkTools.length > 0) {
    result.framework_context = input.loadedContext.frameworkTools.slice(0, 5).join(", ");
  }
  return result;
}

export async function planTurn(
  repo: string,
  query: string,
  options?: PlanTurnOptions,
): Promise<PlanTurnResult> {
  const startedAt = Date.now();
  const maxTools = Math.min(MAX_TOOLS, options?.max_results ?? MAX_TOOLS);
  const skipSession = options?.skip_session === true;
  const index = await getCodeIndex(repo, { skipFreshness: true });
  if (!index) return buildUnindexedResult(query, startedAt);

  const lastGitCommit = await readLastGitCommit(repo);
  const parsed = parseQuery(query, index);
  const sessionState = getSessionState();
  const gapAnalysis = findGapAnalysis(parsed, sessionState, skipSession);
  if (gapAnalysis) return buildGapResult(query, parsed, gapAnalysis, sessionState, startedAt);

  const loadedContext = await loadRankerContext(parsed, index);
  const batches = rankParsedIntents(parsed, loadedContext);
  const mergedRecommendations = mergeToolRecommendations(batches);
  const { primary, alreadyUsed } = partitionSessionRecommendations(
    mergedRecommendations,
    sessionState,
    skipSession,
  );
  const tools = selectTools(primary, maxTools);
  const metadata = buildMetadata({
    parsed,
    batches,
    tools,
    usageFrequency: loadedContext.usageFrequency,
    frameworkTools: loadedContext.frameworkTools,
    embeddingAvailable: loadedContext.embeddings !== null && loadedContext.embeddings.size > 0,
    sessionState,
    staleIndex: isStaleIndex(index, lastGitCommit),
    startedAt,
  });
  return buildSuccessfulResult({
    query,
    parsed,
    index,
    loadedContext,
    tools,
    alreadyUsed,
    metadata,
  });
}
