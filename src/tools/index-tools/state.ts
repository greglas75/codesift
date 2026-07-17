import type { FSWatcher } from "../../storage/watcher.js";
import type { BM25Index } from "../../search/bm25.js";
import type { CodeIndex } from "../../types.js";

export const activeWatchers = new Map<string, FSWatcher>();
export const bm25Indexes = new Map<string, BM25Index>();
export const codeIndexes = new Map<string, CodeIndex>();
export const embeddingCaches = new Map<string, Map<string, Float32Array>>();

export const lastFullIndexAt = new Map<string, number>();
