/**
 * Shared Hono entry-file resolution. Used by all 13 Hono tools to locate the
 * `new Hono()` or `new OpenAPIHono()` instantiation in the indexed symbols.
 *
 * Previously this helper was copy-pasted into every tool file, violating DRY.
 * A single bug in entry detection would have required 13 fixes; a single
 * improvement required 13 edits.
 */

import { join } from "node:path";

interface IndexSymbol {
  source?: string | undefined;
  file: string;
}

interface IndexLike {
  symbols: IndexSymbol[];
  root: string;
}

/**
 * Regex matches `new Hono()`, `new Hono<...>()`, `new OpenAPIHono()`, and
 * `new OpenAPIHono<...>()` — all covered by an optional generic-arg block.
 */
const HONO_INSTANTIATION = /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/;

/**
 * Resolve the entry file for a Hono app by scanning indexed symbol sources
 * for `new Hono(...)` / `new OpenAPIHono(...)`. Returns the absolute path
 * joined from index.root, or null if no such symbol exists.
 *
 * Uses first-match semantics. In a monorepo with multiple Hono apps, the
 * caller is responsible for disambiguation (e.g. via workspace filter).
 */
export function resolveHonoEntryFile(index: IndexLike): string | null {
  for (const sym of index.symbols) {
    if (sym.source && HONO_INSTANTIATION.test(sym.source)) {
      return join(index.root, sym.file);
    }
  }
  return null;
}
