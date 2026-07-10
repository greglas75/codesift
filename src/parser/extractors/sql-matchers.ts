import { DDL_MATCHERS } from "./sql-matcher-catalog.js";
import type { DdlMatcher } from "./sql-matcher-catalog.js";
export type { DdlMatcher } from "./sql-matcher-catalog.js";

export interface DdlHit {
  matcher: DdlMatcher;
  name: string;
  matchOffset: number;
}

export function collectDdlHits(source: string): DdlHit[] {
  const hits: DdlHit[] = [];
  for (const matcher of DDL_MATCHERS) {
    matcher.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.pattern.exec(source)) !== null) {
      const name = pickName(match, Math.max(1, match.length - 4));
      const createIndex = match[0]?.toUpperCase().indexOf("CREATE") ?? -1;
      if (!name || createIndex === -1) continue;
      hits.push({ matcher, name, matchOffset: match.index + createIndex });
    }
  }
  return hits.sort((left, right) => left.matchOffset - right.matchOffset);
}

function pickName(match: RegExpExecArray, offset: number): string | null {
  return match[offset] ?? match[offset + 1] ?? match[offset + 2] ?? match[offset + 3] ?? null;
}
