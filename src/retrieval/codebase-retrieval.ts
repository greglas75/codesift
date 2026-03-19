import { loadConfig } from "../config.js";
import {
  SubQuerySchema,
  type SubQuery,
  type SubQueryResult,
  type CodebaseRetrievalResult,
} from "./retrieval-schemas.js";
import { estimateTokens, truncateSymbolSource } from "./retrieval-utils.js";
import { handleSemanticQuery, handleHybridQuery } from "./semantic-handlers.js";
import {
  MAX_QUERIES,
  MIN_TRUNCATION_TOKENS,
  CHARS_PER_TOKEN,
  DEFAULT_SOURCE_CHARS,
} from "./retrieval-constants.js";

// Re-export for backward compatibility (tests + server import from here)
export { estimateTokens, decomposeQuery } from "./retrieval-utils.js";
export type { SubQuery, SubQueryResult, CodebaseRetrievalResult } from "./retrieval-schemas.js";

// ---------------------------------------------------------------------------
// Sub-query dispatcher — thin switch, delegates to typed handlers
// ---------------------------------------------------------------------------

async function executeSubQuery(
  repo: string,
  query: SubQuery,
): Promise<SubQueryResult> {
  switch (query.type) {
    case "symbols": {
      const { searchSymbols } = await import("../tools/search-tools.js");
      const results = await searchSymbols(repo, query.query, {
        kind: query.kind,
        file_pattern: query.file_pattern,
        include_source: true,
        top_k: query.top_k ?? 5,
      });
      const sourceLimit = query.source_chars ?? DEFAULT_SOURCE_CHARS;
      const data = results.map((r) => truncateSymbolSource(r.symbol, sourceLimit));
      const text = JSON.stringify(data);
      return { type: query.type, data, tokens: estimateTokens(text) };
    }

    case "text": {
      const { searchText } = await import("../tools/search-tools.js");
      const results = await searchText(repo, query.query, {
        regex: query.regex,
        context_lines: query.context_lines,
        file_pattern: query.file_pattern,
      });
      const text = JSON.stringify(results);
      return { type: query.type, data: results, tokens: estimateTokens(text) };
    }

    case "file_tree": {
      const { getFileTree } = await import("../tools/outline-tools.js");
      const result = await getFileTree(repo, {
        path_prefix: query.path ?? query.path_prefix,
        name_pattern: query.name_pattern,
        depth: query.depth,
        compact: query.compact,
        min_symbols: query.min_symbols,
      });
      const text = JSON.stringify(result);
      return { type: query.type, data: result, tokens: estimateTokens(text) };
    }

    case "outline": {
      const { getFileOutline } = await import("../tools/outline-tools.js");
      const result = await getFileOutline(repo, query.file_path);
      const text = JSON.stringify(result);
      return { type: query.type, data: result, tokens: estimateTokens(text) };
    }

    case "references": {
      const { findReferences } = await import("../tools/symbol-tools.js");
      const results = await findReferences(repo, query.symbol_name);
      const text = JSON.stringify(results);
      return { type: query.type, data: results, tokens: estimateTokens(text) };
    }

    case "call_chain": {
      const { traceCallChain } = await import("../tools/graph-tools.js");
      const result = await traceCallChain(
        repo,
        query.symbol_name,
        query.direction ?? "callers",
        {
          depth: query.depth,
          include_source: query.include_source ?? false,
        },
      );
      const text = JSON.stringify(result);
      return { type: query.type, data: result, tokens: estimateTokens(text) };
    }

    case "impact": {
      const { impactAnalysis } = await import("../tools/impact-tools.js");
      const result = await impactAnalysis(
        repo,
        query.since,
        {
          depth: query.depth,
          until: query.until,
          include_source: query.include_source ?? false,
        },
      );
      const text = JSON.stringify(result);
      return { type: query.type, data: result, tokens: estimateTokens(text) };
    }

    case "context": {
      const { assembleContext } = await import("../tools/context-tools.js");
      const result = await assembleContext(repo, query.query, query.max_tokens);
      const text = JSON.stringify(result);
      return { type: query.type, data: result, tokens: estimateTokens(text) };
    }

    case "knowledge_map": {
      const { getKnowledgeMap } = await import("../tools/context-tools.js");
      const result = await getKnowledgeMap(repo, query.focus, query.depth);
      const text = JSON.stringify(result);
      return { type: query.type, data: result, tokens: estimateTokens(text) };
    }

    case "semantic":
      return handleSemanticQuery(repo, query);

    case "hybrid":
      return handleHybridQuery(repo, query);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function codebaseRetrieval(
  repo: string,
  queries: unknown[],
  tokenBudget?: number,
): Promise<CodebaseRetrievalResult> {
  const config = loadConfig();
  const budget = tokenBudget ?? config.defaultTokenBudget;

  const limited = queries.slice(0, MAX_QUERIES);

  // Execute sub-queries sequentially to avoid parallel filesystem walks
  // (6 concurrent searchText walks on 600+ files = OOM / connection closed)
  const subResults: SubQueryResult[] = [];
  for (const raw of limited) {
    const parsed = SubQuerySchema.safeParse(raw);
    if (!parsed.success) {
      const message = `Invalid sub-query: ${parsed.error.issues.map((i) => i.message).join(", ")}`;
      subResults.push({
        type: (raw as { type?: string })?.type ?? "unknown",
        data: { error: message },
        tokens: estimateTokens(message),
      });
      continue;
    }
    try {
      subResults.push(await executeSubQuery(repo, parsed.data));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      subResults.push({
        type: parsed.data.type,
        data: { error: message },
        tokens: estimateTokens(message),
      });
    }
  }

  // Enforce token budget — include results until budget is exceeded
  const results: SubQueryResult[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const result of subResults) {
    if (totalTokens + result.tokens > budget) {
      truncated = true;
      const remaining = budget - totalTokens;
      if (remaining > MIN_TRUNCATION_TOKENS) {
        const truncatedText = JSON.stringify(result.data).slice(0, remaining * CHARS_PER_TOKEN);
        let truncatedData: unknown;
        try {
          truncatedData = JSON.parse(truncatedText);
        } catch {
          truncatedData = { partial: true, note: "Result truncated to fit token budget" };
        }
        results.push({
          type: result.type,
          data: truncatedData,
          tokens: remaining,
        });
        totalTokens += remaining;
      }
      break;
    }
    results.push(result);
    totalTokens += result.tokens;
  }

  return {
    results,
    total_tokens: totalTokens,
    truncated,
    query_count: limited.length,
  };
}
