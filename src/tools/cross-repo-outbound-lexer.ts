/**
 * Lightweight state-machine lexer for outbound HTTP call detection.
 *
 * Performs a single forward scan over JS/TS source, classifying each position as:
 *   code | string | template | regex | lineComment | blockComment
 *
 * At code positions only, detects `fetch(`, `axios.METHOD(`, `got.METHOD(` calls,
 * then reads the immediately following string/template literal as the URL argument.
 *
 * This approach fixes C2 (inner braces in interpolation), C3 (regex literals
 * not confused with comments), C4 (multi-line templates), C5 (wide-spaced concat),
 * and C6 (no false positives from string-embedded call text).
 */

export type OutboundCallee = "fetch" | "axios" | "got";

export interface UrlLiteral {
  kind: "string" | "template";
  /** Raw content between quotes/backticks, escape sequences intact. */
  raw: string;
}

export interface LexerOutboundCall {
  callee: OutboundCallee;
  /** HTTP method from callee name (axios.get → "GET"). fetch/got default undefined. */
  method?: string;
  urlLiteral: UrlLiteral;
  /** The first non-whitespace token after the closing quote/backtick. */
  nextCodeToken: string;
  /** 1-based line number of the call keyword. */
  line: number;
}

// ---------------------------------------------------------------------------
// Internal state machine
// ---------------------------------------------------------------------------

type State =
  | "code"
  | "lineComment"
  | "blockComment"
  | "singleString"
  | "doubleString"
  | "template"
  | "regex";

/**
 * Classify whether the slash at `pos` (where source[pos] === '/') opens a
 * regex literal.  We look at the previous non-whitespace token kind:
 *   - After an identifier/literal/closing bracket → division operator (not regex)
 *   - After operator / keyword / open bracket / start → regex
 *
 * We scan backwards through `out` (already-processed output) for the last
 * meaningful character.
 */
function isRegexStart(out: readonly string[]): boolean {
  // Scan backwards through already-emitted output for last non-space char
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    // Closing brackets / identifier chars → division
    if (c === ")" || c === "]" || /[a-zA-Z0-9_$]/.test(c)) return false;
    // Everything else (operators, opening brackets, etc.) → regex
    return true;
  }
  // Start of file → regex
  return true;
}

// ---------------------------------------------------------------------------
// Main lexer
// ---------------------------------------------------------------------------

/**
 * Lex `source` and return all detected outbound HTTP calls with their URL
 * literal and metadata.  Calls inside strings/templates/comments are skipped.
 */
export function findOutboundCalls(source: string): LexerOutboundCall[] {
  const results: LexerOutboundCall[] = [];
  const n = source.length;

  // out[] mirrors source character-by-character (same length) so we can
  // track state of already-processed output for regex disambiguation.
  // We use it only for the isRegexStart() backwards scan.
  const out: string[] = [];

  let i = 0;
  let state: State = "code";
  let line = 1;

  // Template literal stack for nested ${...}
  // Each entry records the brace depth at which we entered a ${} expression.
  const templateStack: number[] = [];
  let braceDepth = 0;

  // Regex literal termination: track whether we just exited a [] character class
  let inRegexClass = false;

  function peek(offset = 1): string {
    return i + offset < n ? source[i + offset]! : "";
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Read a string literal starting AFTER the opening quote (pos already past
  // the quote).  Returns raw content (excluding quotes) and advances `i`.
  // ──────────────────────────────────────────────────────────────────────────
  function readStringContent(quote: string): string {
    let raw = "";
    while (i < n) {
      const c = source[i]!;
      if (c === "\\") {
        raw += c;
        i++;
        if (i < n) {
          raw += source[i]!;
          if (source[i] === "\n") line++;
          i++;
        }
        continue;
      }
      if (c === quote) {
        i++; // consume closing quote
        break;
      }
      if (c === "\n") line++;
      raw += c;
      i++;
    }
    return raw;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Read a template literal starting AFTER the opening backtick.
  // Returns raw content (excluding backticks) including ${...} verbatim.
  // Handles nested objects inside ${} via brace-depth tracking.
  // ──────────────────────────────────────────────────────────────────────────
  function readTemplateContent(): string {
    let raw = "";
    let depth = 0; // brace depth inside ${}
    let inExpr = false;

    while (i < n) {
      const c = source[i]!;

      if (!inExpr) {
        if (c === "\\") {
          raw += c;
          i++;
          if (i < n) {
            raw += source[i]!;
            if (source[i] === "\n") line++;
            i++;
          }
          continue;
        }
        if (c === "`") {
          i++; // consume closing backtick
          break;
        }
        if (c === "$" && peek() === "{") {
          raw += "${";
          i += 2;
          inExpr = true;
          depth = 1;
          continue;
        }
        if (c === "\n") line++;
        raw += c;
        i++;
        continue;
      }

      // Inside ${...}
      if (c === "{") {
        depth++;
        raw += c;
        i++;
        continue;
      }
      if (c === "}") {
        depth--;
        raw += c;
        i++;
        if (depth === 0) {
          inExpr = false;
        }
        continue;
      }
      // Track strings inside ${} so a "}" inside a string doesn't end the expr
      if (c === '"' || c === "'") {
        raw += c;
        i++;
        while (i < n) {
          const sc = source[i]!;
          raw += sc;
          i++;
          if (sc === "\\") {
            if (i < n) { raw += source[i]!; i++; }
            continue;
          }
          if (sc === c) break;
        }
        continue;
      }
      if (c === "\n") line++;
      raw += c;
      i++;
    }
    return raw;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Skip whitespace (including newlines) at code level, return first non-ws
  // index.  Does NOT advance global `i`.
  // ──────────────────────────────────────────────────────────────────────────
  function skipWs(start: number): number {
    let p = start;
    while (p < n) {
      const c = source[p]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { p++; continue; }
      break;
    }
    return p;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // After finding a callee + "(" at code level, try to read the URL argument.
  // `i` should be positioned right after the "(" (already consumed).
  // Returns the UrlLiteral or null if the first non-ws token is not a quote.
  // ──────────────────────────────────────────────────────────────────────────
  function tryReadUrlArg(): UrlLiteral | null {
    const p = skipWs(i);
    if (p >= n) return null;
    const q = source[p]!;
    if (q === '"' || q === "'") {
      i = p + 1; // advance past opening quote
      const raw = readStringContent(q);
      return { kind: "string", raw };
    }
    if (q === "`") {
      i = p + 1; // advance past backtick
      const raw = readTemplateContent();
      return { kind: "template", raw };
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // After reading the URL literal (i is now just past closing quote/backtick),
  // peek at the next non-whitespace code token (up to 50 chars).
  // ──────────────────────────────────────────────────────────────────────────
  function peekNextCodeToken(): string {
    const p = skipWs(i);
    if (p >= n) return "";
    // Read until whitespace or a separator
    let tok = "";
    let q = p;
    while (q < n && tok.length < 20) {
      const c = source[q]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") break;
      tok += c;
      q++;
    }
    return tok;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Main scan loop
  // ──────────────────────────────────────────────────────────────────────────
  while (i < n) {
    const c = source[i]!;
    const next = peek();

    // ── code state ──────────────────────────────────────────────────────────
    if (state === "code") {
      // Line comment
      if (c === "/" && next === "/") {
        state = "lineComment";
        out.push(c); i++;
        out.push(next); i++;
        if (source[i - 1] === "\n") line++;
        continue;
      }
      // Block comment
      if (c === "/" && next === "*") {
        state = "blockComment";
        out.push(c); i++;
        out.push(next); i++;
        continue;
      }
      // Regex literal — only if previous context indicates regex start
      if (c === "/" && next !== "/" && next !== "*" && isRegexStart(out)) {
        state = "regex";
        inRegexClass = false;
        out.push(c); i++;
        continue;
      }
      // String literals
      if (c === '"') {
        state = "doubleString";
        out.push(c); i++;
        continue;
      }
      if (c === "'") {
        state = "singleString";
        out.push(c); i++;
        continue;
      }
      if (c === "`") {
        state = "template";
        templateStack.push(braceDepth); // push current code brace depth
        out.push(c); i++;
        continue;
      }
      // Brace tracking (for template ${} expressions)
      if (c === "{") {
        braceDepth++;
        out.push(c); i++;
        continue;
      }
      if (c === "}") {
        if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]!) {
          // Closing a ${} expression — return to template state
          templateStack.pop();
          braceDepth--;
          state = "template";
          out.push(c); i++;
          continue;
        }
        braceDepth--;
        out.push(c); i++;
        continue;
      }

      // ── Call detection at code positions ──────────────────────────────────
      // fetch(
      if (
        c === "f" && source.slice(i, i + 5) === "fetch" &&
        (i === 0 || !/[a-zA-Z0-9_$]/.test(source[i - 1]!))
      ) {
        const callLine = line;
        // skip "fetch"
        for (let k = 0; k < 5; k++) { out.push(source[i]!); i++; }
        const wp = skipWs(i);
        if (wp < n && source[wp] === "(") {
          // consume whitespace + "("
          while (i < wp) { out.push(source[i]!); i++; }
          out.push("("); i++; // consume "("
          const urlLit = tryReadUrlArg();
          if (urlLit) {
            const nextTok = peekNextCodeToken();
            results.push({ callee: "fetch", urlLiteral: urlLit, nextCodeToken: nextTok, line: callLine });
          }
          continue;
        }
        continue;
      }

      // axios.METHOD(
      if (
        c === "a" && source.slice(i, i + 5) === "axios" &&
        (i === 0 || !/[a-zA-Z0-9_$]/.test(source[i - 1]!))
      ) {
        const callLine = line;
        for (let k = 0; k < 5; k++) { out.push(source[i]!); i++; }
        if (i < n && source[i] === ".") {
          out.push("."); i++;
          const methods = ["delete", "patch", "post", "put", "get"];
          let matched: string | null = null;
          for (const m of methods) {
            if (source.slice(i, i + m.length).toLowerCase() === m &&
                (i + m.length >= n || !/[a-zA-Z0-9_$]/.test(source[i + m.length]!))) {
              matched = m;
              break;
            }
          }
          if (matched) {
            const verb = matched.toUpperCase();
            for (let k = 0; k < matched.length; k++) { out.push(source[i]!); i++; }
            const wp = skipWs(i);
            if (wp < n && source[wp] === "(") {
              while (i < wp) { out.push(source[i]!); i++; }
              out.push("("); i++;
              const urlLit = tryReadUrlArg();
              if (urlLit) {
                const nextTok = peekNextCodeToken();
                results.push({ callee: "axios", method: verb, urlLiteral: urlLit, nextCodeToken: nextTok, line: callLine });
              }
              continue;
            }
          }
        }
        continue;
      }

      // got.METHOD(
      if (
        c === "g" && source.slice(i, i + 3) === "got" &&
        (i === 0 || !/[a-zA-Z0-9_$]/.test(source[i - 1]!)) &&
        (i + 3 >= n || !/[a-zA-Z0-9_$]/.test(source[i + 3]!))
      ) {
        const callLine = line;
        for (let k = 0; k < 3; k++) { out.push(source[i]!); i++; }
        // peek for "."
        const wp0 = skipWs(i);
        if (wp0 < n && source[wp0] === ".") {
          while (i < wp0) { out.push(source[i]!); i++; }
          out.push("."); i++;
          const methods = ["delete", "patch", "post", "put", "get"];
          let matched: string | null = null;
          for (const m of methods) {
            if (source.slice(i, i + m.length).toLowerCase() === m &&
                (i + m.length >= n || !/[a-zA-Z0-9_$]/.test(source[i + m.length]!))) {
              matched = m;
              break;
            }
          }
          if (matched) {
            const verb = matched.toUpperCase();
            for (let k = 0; k < matched.length; k++) { out.push(source[i]!); i++; }
            const wp = skipWs(i);
            if (wp < n && source[wp] === "(") {
              while (i < wp) { out.push(source[i]!); i++; }
              out.push("("); i++;
              const urlLit = tryReadUrlArg();
              if (urlLit) {
                const nextTok = peekNextCodeToken();
                results.push({ callee: "got", method: verb, urlLiteral: urlLit, nextCodeToken: nextTok, line: callLine });
              }
              continue;
            }
          }
        }
        continue;
      }

      // Regular character
      if (c === "\n") line++;
      out.push(c); i++;
      continue;
    }

    // ── lineComment state ────────────────────────────────────────────────────
    if (state === "lineComment") {
      if (c === "\n") { state = "code"; line++; out.push(c); i++; continue; }
      out.push(" "); i++;
      continue;
    }

    // ── blockComment state ───────────────────────────────────────────────────
    if (state === "blockComment") {
      if (c === "*" && next === "/") {
        state = "code";
        out.push(" "); i++;
        out.push(" "); i++;
        continue;
      }
      if (c === "\n") line++;
      out.push(c === "\n" ? "\n" : " "); i++;
      continue;
    }

    // ── singleString state ────────────────────────────────────────────────────
    if (state === "singleString") {
      out.push(c);
      if (c === "\\") { i++; if (i < n) { out.push(source[i]!); if (source[i] === "\n") line++; i++; } continue; }
      if (c === "'") { state = "code"; }
      if (c === "\n") line++;
      i++;
      continue;
    }

    // ── doubleString state ────────────────────────────────────────────────────
    if (state === "doubleString") {
      out.push(c);
      if (c === "\\") { i++; if (i < n) { out.push(source[i]!); if (source[i] === "\n") line++; i++; } continue; }
      if (c === '"') { state = "code"; }
      if (c === "\n") line++;
      i++;
      continue;
    }

    // ── template state ────────────────────────────────────────────────────────
    if (state === "template") {
      out.push(c);
      if (c === "\\") { i++; if (i < n) { out.push(source[i]!); if (source[i] === "\n") line++; i++; } continue; }
      if (c === "`") {
        templateStack.pop();
        state = "code";
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        out.push(next);
        i += 2;
        braceDepth++;
        templateStack.push(braceDepth);
        state = "code";
        continue;
      }
      if (c === "\n") line++;
      i++;
      continue;
    }

    // ── regex state ───────────────────────────────────────────────────────────
    if (state === "regex") {
      out.push(c);
      if (c === "\\") {
        i++;
        if (i < n) { out.push(source[i]!); if (source[i] === "\n") line++; i++; }
        continue;
      }
      if (c === "[" && !inRegexClass) { inRegexClass = true; i++; continue; }
      if (c === "]" && inRegexClass) { inRegexClass = false; i++; continue; }
      if (c === "/" && !inRegexClass) {
        // End of regex — consume optional flags
        i++;
        while (i < n && /[gimsuy]/.test(source[i]!)) {
          out.push(source[i]!);
          i++;
        }
        state = "code";
        continue;
      }
      if (c === "\n") line++;
      i++;
      continue;
    }

    // Fallback
    if (c === "\n") line++;
    out.push(c); i++;
  }

  return results;
}
