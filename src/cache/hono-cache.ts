/**
 * HonoCache — in-memory LRU cache for HonoAppModel.
 *
 * Design decisions (spec D4 + adversarial review fixes):
 * - True LRU: delete+set on hit to maintain insertion-order-based recency
 * - Deep freeze on insert: prevent tool-cross-mutation of shared model
 * - Concurrent build protection: in-flight promise deduplication
 * - Path canonicalization in invalidate() for consistent matching
 * - Session-scoped (no persistence): cleared on process exit
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md
 * Plan: docs/specs/2026-04-10-hono-framework-intelligence-plan.md (Task 10)
 */

import { existsSync, realpathSync } from "node:fs";
import type { HonoAppModel } from "../parser/extractors/hono-model.js";

const DEFAULT_MAX_ENTRIES = 10;

interface CacheEntry {
  model: HonoAppModel;
  repo: string;
}

interface Extractor {
  parse(entryFile: string): Promise<HonoAppModel>;
}

export class HonoCache {
  private entries = new Map<string, CacheEntry>();
  private building = new Map<string, Promise<HonoAppModel>>();
  private maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /**
   * Get the HonoAppModel for a repo. Builds on miss, returns cached on hit.
   * Concurrent calls during cold start share the same in-flight promise.
   * Returned model is deeply frozen — do NOT attempt to mutate.
   */
  async get(
    repo: string,
    entryFile: string,
    extractor: Extractor,
  ): Promise<HonoAppModel> {
    const key = `${repo}:${entryFile}`;

    // Cache hit: move to end (true LRU) and return
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.model;
    }

    // Concurrent build protection: reuse in-flight promise
    const inflight = this.building.get(key);
    if (inflight) return inflight;

    // Build new model
    const promise = extractor
      .parse(entryFile)
      .then((model) => {
        const frozen = deepFreeze(model);
        this.entries.set(key, { model: frozen, repo });
        this.enforceLRU();
        return frozen;
      })
      .finally(() => {
        this.building.delete(key);
      });

    this.building.set(key, promise);
    return promise;
  }

  /**
   * Synchronous peek — returns the cached model without building.
   * Returns null on miss. Does NOT reorder LRU (peek is passive).
   * Used by findDeadCode and other hot paths that cannot await.
   */
  peek(repo: string): HonoAppModel | null {
    for (const entry of this.entries.values()) {
      if (entry.repo === repo) return entry.model;
    }
    return null;
  }

  /**
   * Invalidate any cache entry whose files_used contains the given path.
   * Canonicalizes via realpath before comparison for symlink/extension safety.
   */
  invalidate(absolutePath: string): void {
    const canonical = canonicalize(absolutePath);
    for (const [key, entry] of this.entries) {
      const match = entry.model.files_used.some(
        (f) => f === canonical || f === absolutePath,
      );
      if (match) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Clear cache entries. If repo is provided, only that repo's entries.
   * Otherwise clears all.
   */
  clear(repo?: string): void {
    if (!repo) {
      this.entries.clear();
      return;
    }
    for (const [key, entry] of this.entries) {
      if (entry.repo === repo) {
        this.entries.delete(key);
      }
    }
  }

  private enforceLRU(): void {
    while (this.entries.size > this.maxEntries) {
      // Map.keys() returns in insertion order — first key is LRU
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }
}

function canonicalize(filePath: string): string {
  try {
    if (existsSync(filePath)) {
      return realpathSync.native(filePath);
    }
  } catch {
    // Fall through
  }
  return filePath;
}

/**
 * Recursively freeze an object and all its nested objects/arrays.
 * Prevents tool-cross-mutation when multiple tools share the cached model.
 */
function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/** Singleton instance for the application. */
export const honoCache = new HonoCache();
