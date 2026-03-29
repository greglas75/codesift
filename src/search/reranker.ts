import type { SearchResult, CodeChunk } from "../types.js";

const DEFAULT_RERANK_TOP_N = 50;
const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

let pipeline: ((pairs: string[][], options?: Record<string, unknown>) => Promise<Array<{ score: number }>>) | null = null;
let loadAttempted = false;
let loadWarned = false;

async function loadPipeline(model?: string): Promise<typeof pipeline> {
  if (pipeline) return pipeline;
  if (loadAttempted) return null;
  loadAttempted = true;

  try {
    // @ts-expect-error — optional dependency, may not be installed
    const transformers = await import("@huggingface/transformers");
    const pipelineFn = transformers.pipeline ?? transformers.default?.pipeline;
    if (!pipelineFn) return null;

    const reranker = await pipelineFn("text-classification", model ?? DEFAULT_MODEL, {
      quantized: true,
    });

    pipeline = async (pairs: string[][]) => {
      const results: Array<{ score: number }> = [];
      for (const [query, text] of pairs) {
        const out = await reranker(`${query} [SEP] ${text}`, { topk: 1 });
        const score = Array.isArray(out) ? (out[0]?.score ?? 0) : (out?.score ?? 0);
        results.push({ score: typeof score === "number" ? score : 0 });
      }
      return results;
    };

    return pipeline;
  } catch {
    return null;
  }
}

/**
 * Rerank SearchResult[] using a cross-encoder model.
 * Returns results reordered by cross-encoder score.
 * Falls back to original order if the model is unavailable.
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  topN?: number,
  model?: string,
): Promise<SearchResult[]> {
  if (results.length <= 1) return results;

  const limit = Math.min(topN ?? DEFAULT_RERANK_TOP_N, results.length);
  const candidates = results.slice(0, limit);
  const remainder = results.slice(limit);

  const reranker = await loadPipeline(model);
  if (!reranker) {
    if (!loadWarned) {
      loadWarned = true;
      console.error(
        "[codesift] Cross-encoder reranking unavailable. Install @huggingface/transformers for improved search quality.",
      );
    }
    return results;
  }

  const pairs = candidates.map((r) => {
    const text = buildCandidateText(r);
    return [query, text];
  });

  const scores = await reranker(pairs);

  const scored = candidates.map((r, i) => ({
    result: r,
    ceScore: scores[i]?.score ?? 0,
  }));

  scored.sort((a, b) => b.ceScore - a.ceScore);

  return [...scored.map((s) => s.result), ...remainder];
}

/**
 * Rerank chunk IDs using a cross-encoder model.
 * Returns reordered chunk IDs.
 */
export async function rerankChunkIds(
  query: string,
  chunkIds: string[],
  chunks: Map<string, CodeChunk>,
  topN?: number,
  model?: string,
): Promise<string[]> {
  if (chunkIds.length <= 1) return chunkIds;

  const limit = Math.min(topN ?? DEFAULT_RERANK_TOP_N, chunkIds.length);
  const candidates = chunkIds.slice(0, limit);
  const remainder = chunkIds.slice(limit);

  const reranker = await loadPipeline(model);
  if (!reranker) {
    if (!loadWarned) {
      loadWarned = true;
      console.error(
        "[codesift] Cross-encoder reranking unavailable. Install @huggingface/transformers for improved search quality.",
      );
    }
    return chunkIds;
  }

  const pairs = candidates.map((id) => {
    const chunk = chunks.get(id);
    const text = chunk?.text ?? id;
    return [query, text];
  });

  const scores = await reranker(pairs);

  const scored = candidates.map((id, i) => ({
    id,
    ceScore: scores[i]?.score ?? 0,
  }));

  scored.sort((a, b) => b.ceScore - a.ceScore);

  return [...scored.map((s) => s.id), ...remainder];
}

function buildCandidateText(r: SearchResult): string {
  const parts: string[] = [];
  if (r.symbol.kind) parts.push(r.symbol.kind);
  parts.push(r.symbol.name);
  if (r.symbol.signature) parts.push(r.symbol.signature);
  if (r.symbol.source) parts.push(r.symbol.source.slice(0, 500));
  else if (r.symbol.docstring) parts.push(r.symbol.docstring.slice(0, 200));
  return parts.join(" ");
}

/** Reset singleton for testing. */
export function _resetReranker(): void {
  pipeline = null;
  loadAttempted = false;
  loadWarned = false;
}
