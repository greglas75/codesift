import type { SearchResult, CodeChunk } from "../types.js";

const DEFAULT_RERANK_TOP_N = 50;
const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

type RerankerFn = (pairs: string[][]) => Promise<Array<{ score: number }>>;

const pipelineCache = new Map<string, RerankerFn>();
const failedModels = new Set<string>();
let loadWarned = false;

async function loadPipeline(model?: string): Promise<RerankerFn | null> {
  const modelName = model ?? DEFAULT_MODEL;

  const cached = pipelineCache.get(modelName);
  if (cached) return cached;
  if (failedModels.has(modelName)) return null;

  try {
    // @ts-expect-error — optional dependency, may not be installed
    const transformers = await import("@huggingface/transformers");
    const pipelineFn = transformers.pipeline ?? transformers.default?.pipeline;
    if (!pipelineFn) { failedModels.add(modelName); return null; }

    const classifier = await pipelineFn("text-classification", modelName, {
      quantized: true,
    });

    const rerankerFn: RerankerFn = async (pairs: string[][]) => {
      // Batch: send all inputs at once for better throughput
      const inputs = pairs.map(([q, t]) => `${q} [SEP] ${t}`);
      const outputs = await classifier(inputs, { topk: 1 });

      // Normalize: pipeline returns single object for 1 input, array for N
      const results: Array<{ score: number }> = [];
      for (let i = 0; i < pairs.length; i++) {
        const out = Array.isArray(outputs[i]) ? outputs[i][0] : outputs[i] ?? outputs;
        const score = out?.score ?? 0;
        results.push({ score: typeof score === "number" ? score : 0 });
      }
      return results;
    };

    pipelineCache.set(modelName, rerankerFn);
    return rerankerFn;
  } catch {
    failedModels.add(modelName);
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

/** Reset caches for testing. */
export function _resetReranker(): void {
  pipelineCache.clear();
  failedModels.clear();
  loadWarned = false;
}
