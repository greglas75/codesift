import { findOutboundCalls } from "./cross-repo-outbound-lexer.js";

/** A single detected outbound HTTP call from consumer source. */
export interface OutboundCall {
  /** The static URL prefix extracted from the call. Paths only — origin stripped. */
  url_prefix: string;
  /** HTTP method, uppercased. Defaults to "GET" when not detectable. */
  method: string;
  /** True when the path contains a dynamic segment (template var, concat, path param). */
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
  // Match http(s)://host(:port) and protocol-relative origins.
  const m = url.match(/^(?:https?:)?\/\/[^/]+(\/.*)?$/i);
  if (m) {
    return m[1] ?? "/";
  }
  return url;
}

function isInterpolationStart(value: string, index: number): boolean {
  if (value[index] !== "$" || value[index + 1] !== "{") return false;
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 0;
}

function findStaticSlash(value: string, start: number): number {
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    const char = value[index]!;
    if (isInterpolationStart(value, index)) {
      depth++;
      index++;
    } else if (char === "{" && depth > 0) {
      depth++;
    } else if (char === "}" && depth > 0) {
      depth--;
    } else if (char === "/" && depth === 0) {
      return index;
    }
  }
  return -1;
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
  const firstInterpolation = trimmed.split("").findIndex((_, index) =>
    isInterpolationStart(trimmed, index));
  const hasInterp = firstInterpolation !== -1;

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
  const scheme = trimmed.match(/^https?:\/\//i);
  const protocolRelative = trimmed.startsWith("//");
  const leadingInterpolation = firstInterpolation === 0;
  const firstSlashIdx = scheme
    ? findStaticSlash(trimmed, scheme[0].length)
    : protocolRelative
      ? findStaticSlash(trimmed, 2)
      : leadingInterpolation
        ? findStaticSlash(trimmed, 0)
        : 0;

  if (firstSlashIdx === -1) {
    // No static path segment at all
    return { url_prefix: "", partial: true };
  }

  // From firstSlashIdx, collect static prefix until the next interpolation.
  // Also stop at `?` or `#` (C1) since query/fragment is not a path prefix.
  let prefix = "";
  let hitInterp = false;
  for (let i = firstSlashIdx; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (isInterpolationStart(trimmed, i)) {
      // Hit an interpolation — stop here, prefix is partial
      hitInterp = true;
      break;
    }
    // C1: stop at query/fragment
    if (c === "?" || c === "#") {
      break;
    }
    prefix += c;
  }

  // `partial` describes path stability, not whether the origin or query is dynamic.
  // The path is partial when it starts after a leading interpolation or ends at one.
  return { url_prefix: prefix, partial: leadingInterpolation || hitInterp };
}

/**
 * Scan a window of source text (starting just after the fetch URL argument)
 * for a `method:` option to determine the HTTP verb.
 * Returns "GET" if not found.
 */
function sniffFetchMethodFromWindow(window: string): string {
  let objectDepth = 0;
  const skipQuoted = (start: number): number => {
    const quote = window[start]!;
    for (let index = start + 1; index < window.length; index++) {
      if (window[index] === "\\") index++;
      else if (window[index] === quote) return index + 1;
    }
    return window.length;
  };
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (/\s/.test(window[index] ?? "")) index++;
    return index;
  };
  const readMethodValue = (colon: number): string | null => {
    if (window[colon] !== ":") return null;
    const valueStart = skipWhitespace(colon + 1);
    const quote = window[valueStart];
    if (quote !== "'" && quote !== '"' && quote !== "`") return null;
    const valueEnd = skipQuoted(valueStart);
    const value = window.slice(valueStart + 1, valueEnd - 1);
    return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value) ? value.toUpperCase() : null;
  };

  for (let index = 0; index < window.length;) {
    const char = window[index]!;
    const next = window[index + 1] ?? "";
    if (char === "/" && next === "/") {
      const newline = window.indexOf("\n", index + 2);
      index = newline === -1 ? window.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = window.indexOf("*/", index + 2);
      index = end === -1 ? window.length : end + 2;
      continue;
    }
    if (char === "{") {
      objectDepth++;
      index++;
      continue;
    }
    if (char === "}") {
      objectDepth = Math.max(0, objectDepth - 1);
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const keyEnd = skipQuoted(index);
      if (objectDepth === 1 && window.slice(index + 1, keyEnd - 1) === "method") {
        const method = readMethodValue(skipWhitespace(keyEnd));
        if (method) return method;
      }
      index = keyEnd;
      continue;
    }
    if (objectDepth === 1 && window.startsWith("method", index)) {
      const before = window[index - 1] ?? "";
      const after = window[index + 6] ?? "";
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        const colon = skipWhitespace(index + 6);
        const method = readMethodValue(colon);
        if (method) return method;
      }
    }
    index++;
  }
  return "GET";
}

/** Find the closing parenthesis for the current fetch call, skipping strings/comments. */
function findFetchCallEnd(source: string, start: number): number | null {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index++;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && --depth === 0) {
      return index;
    }
  }
  return null;
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
      const callEnd = findFetchCallEnd(source, lc.urlEnd);
      const window = callEnd === null ? "" : source.slice(lc.urlEnd, callEnd);
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
