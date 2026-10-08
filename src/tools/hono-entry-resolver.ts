/**
 * Hono entry-file resolution over a materialised index: the first symbol (index order) whose source
 * instantiates `Hono` / `OpenAPIHono`.
 *
 * Since ADR-004 stage 2 the tools resolve by repo name instead (`resolveRepoHonoEntryFile` in
 * framework-detect-repo.ts, which pages through the table and stops at the first hit). This form is
 * kept as the reference that test asserts against, and `HONO_INSTANTIATION` is the one regex both
 * use. `route-tools/hono.ts` has its own resolver that prefers non-test files — a different rule.
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
export const HONO_INSTANTIATION = /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/;

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
