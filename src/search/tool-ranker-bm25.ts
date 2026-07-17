import { createHash } from "node:crypto";

import { buildBM25Index, type BM25Index } from "./bm25.js";
import type { ToolDefinition } from "../register-tools.js";
import type { CodeSymbol } from "../types.js";

interface ToolBM25Cache {
  fingerprint: string;
  index: BM25Index;
}

let bm25Cache: ToolBM25Cache | null = null;

export function toolDefsFingerprint(toolDefs: readonly ToolDefinition[]): string {
  const subset = toolDefs.map((definition) => [
    definition.name,
    definition.description,
    definition.searchHint ?? "",
    definition.category ?? "",
  ]);
  return createHash("sha1")
    .update(JSON.stringify(subset))
    .digest("hex")
    .slice(0, 16);
}

export function buildToolBM25Index(toolDefs: readonly ToolDefinition[]): BM25Index {
  const fingerprint = toolDefsFingerprint(toolDefs);
  if (bm25Cache?.fingerprint === fingerprint) return bm25Cache.index;
  const index = buildBM25Index(toolDefs.map(toolToSymbol));
  bm25Cache = { fingerprint, index };
  return index;
}

export function clearToolBM25Cache(): void {
  bm25Cache = null;
}

function toolToSymbol(definition: ToolDefinition): CodeSymbol {
  return {
    id: definition.name,
    repo: "__tools__",
    name: definition.name,
    kind: "function",
    file: `__tools__/${definition.category ?? "uncategorized"}.tool`,
    start_line: 1,
    end_line: 1,
    signature: definition.description,
    docstring: definition.searchHint ?? "",
  };
}
