interface SemanticSearchOptions {
  top_k?: number;
  file_pattern?: string;
  exclude_tests?: boolean;
  rerank?: boolean;
}

function buildSemanticQuery(query: string, options: SemanticSearchOptions | undefined) {
  return {
    type: "semantic" as const,
    query,
    top_k: options?.top_k,
    file_filter: options?.file_pattern,
    exclude_tests: options?.exclude_tests,
    rerank: options?.rerank,
  };
}

function serializeSemanticData(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

export async function semanticSearch(
  repo: string,
  query: string,
  options?: SemanticSearchOptions,
): Promise<string> {
  const { handleSemanticQuery } = await import("../../retrieval/semantic-handlers.js");
  const semanticResult = await handleSemanticQuery(repo, buildSemanticQuery(query, options));
  return serializeSemanticData(semanticResult.data);
}
