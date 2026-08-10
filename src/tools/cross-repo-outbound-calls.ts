import { findOutboundCalls } from "./cross-repo-outbound-lexer.js";

/** A single detected outbound HTTP call from consumer source. */
export interface OutboundCall {
  /** The static URL prefix extracted from the call. Paths only — origin stripped. */
  url_prefix: string;
  /** HTTP method, uppercased. Defaults to "GET" when not detectable. */
  method: string;
  /** True when the URL contains a dynamic segment (template var, concat, path param). */
  partial: boolean;
  /** Source file path as provided to extractOutboundCalls. */
  file: string;
  /** 1-based line number of the call in the original (pre-strip) source. */
  line: number;
}

/**
 * Strip the origin (scheme + host + port) from a URL string, returning the
 * path+query portion. If there is no origin (e.g. "/api/users"), returns as-is.
 * Examples:
 *   "https://api.example.com/v1/users" → "/v1/users"
 *   "/api/users"                        → "/api/users"
 */
function stripOrigin(url: string): string {
  // Match http(s)://host(:port) prefix
  const m = url.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (m) {
    return m[1] ?? "/";
  }
  return url;
}

/**
 * Handle the "leading variable" case: `${BASE}/path/to/resource`.
 *
 * rawUrlContent is the raw content of the URL literal (between quotes/backticks),
 * escape sequences intact, interpolation markers `${...}` preserved verbatim.
 *
 * C1: Strip query string (from first `?`) and fragment (from first `#`) from
 *     plain string URLs before returning.
 * C2: Track brace depth properly so `${ {a:1}.a }` (inner object literal) does
 *     not prematurely close the interpolation.
 */
function extractUrlPrefix(rawUrlContent: string): { url_prefix: string; partial: boolean } {
  // Trim leading/trailing whitespace (can appear in multi-line template literals — C4)
  const trimmed = rawUrlContent.trim();

  // Does the content contain any ${ ... } interpolations?
  const hasInterp = trimmed.includes("${");

  if (!hasInterp) {
    // Plain string / no interpolation — strip origin, then strip query/fragment (C1)
    let prefix = stripOrigin(trimmed);
    // Strip query string and fragment
    const qIdx = prefix.indexOf("?");
    const hIdx = prefix.indexOf("#");
    const cutIdx = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
    if (cutIdx !== -1) prefix = prefix.slice(0, cutIdx);
    return { url_prefix: prefix, partial: false };
  }

  // Template literal with interpolations.
  // Find first "/" that is NOT inside a ${...} block.
  // Track brace DEPTH inside ${} so inner objects `{ key: val }` don't
  // prematurely close the expression (C2 fix).
  let depth = 0;
  let firstSlashIdx = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "$" && trimmed[i + 1] === "{") {
      depth++;
      i++; // skip '{'
      continue;
    }
    if (c === "{" && depth > 0) {
      // Inner brace — increase depth (C2 fix)
      depth++;
      continue;
    }
    if (c === "}" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0 && c === "/" && firstSlashIdx === -1) {
      firstSlashIdx = i;
      break;
    }
  }

  if (firstSlashIdx === -1) {
    // No static path segment at all
    return { url_prefix: "", partial: true };
  }

  // From firstSlashIdx, collect static prefix until the next interpolation.
  // Also stop at `?` or `#` (C1) since query/fragment is not a path prefix.
  let prefix = "";
  let d = 0;
  let hitInterp = false;
  for (let i = firstSlashIdx; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "$" && trimmed[i + 1] === "{") {
      // Hit an interpolation — stop here, prefix is partial
      hitInterp = true;
      break;
    }
    // C1: stop at query/fragment
    if (c === "?" || c === "#") {
      break;
    }
    if (c === "{" && d > 0) {
      d++;
      continue;
    }
    if (c === "}" && d > 0) {
      d--;
      continue;
    }
    if (d === 0) {
      prefix += c;
    }
  }

  // The result is partial when:
  // - there was a leading interpolation (firstSlashIdx > 0 means content before the slash)
  // - or the prefix ends at an interpolation (hitInterp)
  const leadingInterp = firstSlashIdx > 0;
  return { url_prefix: prefix, partial: leadingInterp || hitInterp };
}

/**
 * Scan a window of source text (starting just after the fetch URL argument)
 * for a `method:` option to determine the HTTP verb.
 * Returns "GET" if not found.
 */
function sniffFetchMethodFromWindow(window: string): string {
  const methodMatch = window.match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/);
  if (methodMatch) {
    return methodMatch[1]!.toUpperCase();
  }
  return "GET";
}

/**
 * Extract all outbound HTTP calls from `source` (TypeScript/JavaScript).
 * Supports fetch, axios.METHOD, and got.METHOD patterns.
 *
 * Uses a single-pass state-machine lexer so calls inside comments, string
 * literals, template literals, and regex literals are never falsely reported
 * (fixes C3/C6).  Multi-line templates are handled naturally (C4).  Wide-
 * spaced string concatenation is detected via the lexer's nextCodeToken (C5).
 * Query-string and fragment stripping is done in extractUrlPrefix (C1).
 *
 * @param source - Raw source code.
 * @param file   - File path to embed in results (returned as-is).
 */
export function extractOutboundCalls(source: string, file: string): OutboundCall[] {
  const lexerCalls = findOutboundCalls(source);
  const results: OutboundCall[] = [];

  for (const lc of lexerCalls) {
    const rawUrl = lc.urlLiteral.raw;
    const { url_prefix, partial } = extractUrlPrefix(rawUrl);

    // C5: string concat detection — check the token immediately after the
    // closing quote/backtick.  nextCodeToken already captures any amount of
    // whitespace before the next token, so wide spacing is handled correctly.
    const isConcat = lc.nextCodeToken.startsWith("+");

    let method: string;
    if (lc.callee === "fetch") {
      // For fetch, scan the source ahead of the call site for method: "VERB"
      // We need a substring of source starting after the URL literal.
      // Use line as rough anchor — search a window after the call.
      // We approximate by scanning from a position we can derive from source.
      // Since the lexer already consumed the URL, scan next ~200 chars of source
      // from just after the URL literal.
      // Simplest: search the source from lc.line onwards for `method:`.
      // More accurately: findOutboundCalls gives us the line, so we scan a
      // window of the raw source from the end of the call's URL literal.
      // We don't have the exact offset, but we can search a window around the
      // line.  Use source.indexOf approach: locate the URL in source and scan.
      // For robustness, scan the 300-char window of source starting from the
      // first character of the matching line.
      const lineStart = findLineStart(source, lc.line);
      const window = source.slice(lineStart, lineStart + 300);
      method = sniffFetchMethodFromWindow(window);
    } else {
      // axios / got: method comes from the callee (axios.get → GET)
      method = lc.method ?? "GET";
    }

    results.push({
      url_prefix,
      method,
      partial: partial || isConcat,
      file,
      line: lc.line,
    });
  }

  return results;
}

/**
 * Find the character index of the start of line `lineNumber` (1-based) in `source`.
 */
function findLineStart(source: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      if (line === lineNumber) return i + 1;
    }
  }
  return source.length;
}
