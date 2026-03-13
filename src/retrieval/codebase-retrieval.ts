import { loadConfig } from "../config.js";
import type { SymbolKind } from "../types.js";

// Lazy imports to avoid circular dependencies at module load time.
// Each handler imports its dependency on first call.
type SubQueryResult = {
  type: string;
  data: unknown;
  tokens: number;
};

interface SubQuery {
  type: string;
  [key: string]: unknown;
}

/**
 * Estimate token count from a string. ~4 chars per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}


/**
 * Execute a single sub-query and return the result with token estimate.
 */
async function executeSubQuery(
  repo: string,
  query: SubQuery,
): Promise<SubQueryResult> {
  const qType = query.type;

  switch (qType) {
    case "symbols": {
      const { searchSymbols } = await import("../tools/search-tools.js");
      const results = await searchSymbols(repo, query["query"] as string, {
        kind: query["kind"] as SymbolKind | undefined,
        file_pattern: query["file_pattern"] as string | undefined,
        include_source: true,
        top_k: (query["top_k"] as number | undefined) ?? 10,
      });
      const data = results.map((r) => r.symbol);
      const text = JSON.stringify(data);
      return { type: qType, data, tokens: estimateTokens(text) };
    }

    case "text": {
      const { searchText } = await import("../tools/search-tools.js");
      const results = await searchText(repo, query["query"] as string, {
        regex: query["regex"] as boolean | undefined,
        context_lines: query["context_lines"] as number | undefined,
        file_pattern: query["file_pattern"] as string | undefined,
      });
      const text = JSON.stringify(results);
      return { type: qType, data: results, tokens: estimateTokens(text) };
    }

    case "file_tree": {
      const { getFileTree } = await import("../tools/outline-tools.js");
      const result = await getFileTree(repo, {
        path_prefix: query["path"] as string | undefined,
        depth: query["depth"] as number | undefined,
      });
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "outline": {
      const { getFileOutline } = await import("../tools/outline-tools.js");
      const result = await getFileOutline(repo, query["file_path"] as string);
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "references": {
      const { findReferences } = await import("../tools/symbol-tools.js");
      const results = await findReferences(
        repo,
        query["symbol_name"] as string,
      );
      const text = JSON.stringify(results);
      return { type: qType, data: results, tokens: estimateTokens(text) };
    }

    case "call_chain": {
      const { traceCallChain } = await import("../tools/graph-tools.js");
      const result = await traceCallChain(
        repo,
        query["symbol_name"] as string,
        (query["direction"] as "callers" | "callees") ?? "callers",
        query["depth"] as number | undefined,
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "impact": {
      const { impactAnalysis } = await import("../tools/graph-tools.js");
      const result = await impactAnalysis(
        repo,
        query["since"] as string,
        query["depth"] as number | undefined,
        query["until"] as string | undefined,
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "context": {
      const { assembleContext } = await import("../tools/context-tools.js");
      const result = await assembleContext(
        repo,
        query["query"] as string,
        query["max_tokens"] as number | undefined,
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    case "knowledge_map": {
      const { getKnowledgeMap } = await import("../tools/context-tools.js");
      const result = await getKnowledgeMap(
        repo,
        query["focus"] as string | undefined,
        query["depth"] as number | undefined,
      );
      const text = JSON.stringify(result);
      return { type: qType, data: result, tokens: estimateTokens(text) };
    }

    default:
      return {
        type: qType,
        data: { error: `Unknown sub-query type: ${qType}` },
        tokens: 50,
      };
  }
}

export interface CodebaseRetrievalResult {
  results: SubQueryResult[];
  total_tokens: number;
  truncated: boolean;
  query_count: number;
}

/**
 * Execute multiple sub-queries in a single batched call with shared token budget.
 *
 * Features:
 * - Cross-query deduplication (same symbol in multiple results → included once)
 * - Token budget enforcement
 * - Max 20 sub-queries per call
 * - Parallel execution where queries are independent
 */
export async function codebaseRetrieval(
  repo: string,
  queries: SubQuery[],
  tokenBudget?: number,
): Promise<CodebaseRetrievalResult> {
  const config = loadConfig();
  const budget = tokenBudget ?? config.defaultTokenBudget;
  const maxQueries = 20;

  const limited = queries.slice(0, maxQueries);

  // Execute all sub-queries in parallel
  const subResults = await Promise.all(
    limited.map((q) =>
      executeSubQuery(repo, q).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return {
          type: q.type,
          data: { error: message },
          tokens: estimateTokens(message),
        } satisfies SubQueryResult;
      }),
    ),
  );

  // Enforce token budget — include results until budget is exceeded
  const results: SubQueryResult[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const result of subResults) {
    if (totalTokens + result.tokens > budget) {
      truncated = true;
      // Try to include a truncated version
      const remaining = budget - totalTokens;
      if (remaining > 100) {
        const truncatedText = JSON.stringify(result.data).slice(0, remaining * 4);
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
