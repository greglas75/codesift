import type { ContractMatch, RepoEndpoint } from "../types.js";
import type { OutboundCall } from "./cross-repo-outbound-calls.js";

/** Split a path into non-empty segments (splitting on "/"). */
function pathSegments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Compute the longest literal prefix of a normalised template path. */
function templateLiteralHead(normalizedPath: string): string {
  const segs = pathSegments(normalizedPath);
  const literalSegs: string[] = [];
  for (const seg of segs) {
    if (seg === "{param}") break;
    literalSegs.push(seg);
  }
  if (literalSegs.length === 0) return "/";
  return "/" + literalSegs.join("/") + "/";
}

/** Test whether a concrete path instantiates a normalised template path. */
function instantiatesTemplate(concretePath: string, normalizedTemplate: string): boolean {
  const concSegs = pathSegments(concretePath);
  const tmplSegs = pathSegments(normalizedTemplate);
  if (concSegs.length !== tmplSegs.length) return false;
  for (let i = 0; i < tmplSegs.length; i++) {
    const t = tmplSegs[i]!;
    const c = concSegs[i]!;
    if (t === "{param}") {
      if (c.length === 0) return false; // must match exactly one non-empty segment
    } else {
      if (t !== c) return false;
    }
  }
  return true;
}

/** Test whether a partial consumer URL prefix matches a template's literal head. */
function matchesPartialPrefix(urlPrefix: string, normalizedTemplate: string): boolean {
  if (!urlPrefix) return false;
  const head = templateLiteralHead(normalizedTemplate);
  // Normalise: ensure both end with "/" for prefix comparison
  const normPrefix = urlPrefix.endsWith("/") ? urlPrefix : urlPrefix + "/";
  const normHead = head.endsWith("/") ? head : head + "/";
  // The consumer prefix must equal or be a path-prefix of the template literal head
  return normHead.startsWith(normPrefix) || normPrefix === normHead;
}

/**
 * Match producer `RepoEndpoint[]` against consumer outbound calls (annotated with repo).
 *
 * Matching rules:
 *   - Same HTTP method (case-insensitive, already uppercased by adapters)
 *   - Cross-repo only (producer.repo !== consumer.repo)
 *   - Non-partial consumer: concrete path INSTANTIATES the normalised template → "exact"
 *   - Partial consumer: url_prefix is a path-prefix of the template's literal head → "partial"
 *
 * One consumer can match multiple producers (all reported).
 * Multiple consumers can match one producer (all reported).
 * Deduplication: identical (producer_repo, consumer_repo, consumer_file, line, path, method) → single entry.
 */
export function matchContracts(
  producers: RepoEndpoint[],
  consumers: Array<OutboundCall & { repo: string }>,
): ContractMatch[] {
  const results: ContractMatch[] = [];
  const seen = new Set<string>();

  for (const p of producers) {
    for (const c of consumers) {
      // Cross-repo only
      if (p.repo === c.repo) continue;
      // Method must match
      if (p.method !== c.method) continue;

      let confidence: ContractMatch["confidence"] | null = null;

      if (!c.partial) {
        // Exact: concrete path must instantiate the normalised template
        if (instantiatesTemplate(c.url_prefix, p.normalized_path)) {
          confidence = "exact";
        }
      } else {
        // Partial: prefix must match template's literal head
        if (matchesPartialPrefix(c.url_prefix, p.normalized_path)) {
          confidence = "partial";
        }
      }

      if (confidence === null) continue;

      // Deduplication key
      const key = `${p.repo}|${c.repo}|${c.file}|${c.line}|${p.normalized_path}|${c.method}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        producer_repo: p.repo,
        consumer_repo: c.repo,
        method: c.method,
        path: p.normalized_path,
        consumer_file: c.file,
        consumer_line: c.line,
        confidence,
      });
    }
  }

  return results;
}

export { instantiatesTemplate, matchesPartialPrefix };
