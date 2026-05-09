/**
 * Single-pass character-level state machine that strips comments, string
 * literals, template literals, and JS regex literals from source code,
 * replacing each stripped character with whitespace so that downstream
 * regex match positions remain stable.
 *
 * Tier 8 — promoted from Tier 7's react-tools internal helper. Used by both
 * pattern-tools.ts (preprocessing for regex patterns with `preprocess: true`)
 * and react-tools.ts (Suspense ancestor detection).
 *
 * Handles:
 *   - // line comments
 *   - block comments
 *   - 'single' / "double" / `template` string literals (with escape sequences)
 *   - JS regex literals /pattern/flags including character classes [...]
 *
 * Heuristic — distinguishes `/` as division from `/` as regex-start by
 * examining the preceding non-whitespace token. Does not handle:
 *   - JSX text nodes (out of scope; JSX has no comment grammar between tags)
 *   - tagged template expressions ${...} contents (treated opaquely)
 */
export function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  type State =
    | "code"
    | "lineComment"
    | "blockComment"
    | "single"
    | "double"
    | "template"
    | "regex";
  let state: State = "code";
  let lastCodeChar = "";
  // Stack of template-literal contexts pending continuation after `${...}`
  // expression interpolation. Each entry stores the brace depth at which to
  // pop back to template state.
  const templateStack: { braceDepth: number }[] = [];
  let braceDepth = 0;

  // JS keywords that legally precede a regex literal (start an expression).
  // Adversarial Run 1 CRITICAL: `return /x/`, `throw /x/`, `case /x/` were
  // previously misclassified as division because the preceding char was `n`
  // (return) / `w` (throw) / `e` (case) — word chars failing the operator test.
  const REGEX_PRECEDING_KEYWORDS = new Set([
    "return", "throw", "case", "delete", "in", "of", "instanceof", "typeof",
    "new", "void", "yield", "await", "do", "else",
  ]);

  function isRegexContext(prev: string, prevToken: string): boolean {
    if (prev === "") return true;
    if (REGEX_PRECEDING_KEYWORDS.has(prevToken)) return true;
    return /[=(,;!&|?:{[<>+\-*%^~]/.test(prev);
  }

  // Track most recent identifier-shaped token from the code stream so we can
  // recognise keywords like `return` / `throw` before a `/`.
  let prevToken = "";
  let identBuf = "";

  while (i < n) {
    const c = source[i]!;
    const next = i + 1 < n ? source[i + 1]! : "";
    if (state === "code") {
      if (c === "/" && next === "/") {
        if (identBuf.length > 0) { prevToken = identBuf; identBuf = ""; }
        state = "lineComment";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        if (identBuf.length > 0) { prevToken = identBuf; identBuf = ""; }
        state = "blockComment";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "/" && isRegexContext(lastCodeChar, prevToken)) {
        state = "regex";
        out.push(" ");
        i++;
        identBuf = "";
        continue;
      }
      if (c === "'") {
        state = "single";
        out.push(" ");
        i++;
        lastCodeChar = c;
        continue;
      }
      if (c === '"') {
        state = "double";
        out.push(" ");
        i++;
        lastCodeChar = c;
        continue;
      }
      if (c === "`") {
        state = "template";
        out.push(" ");
        i++;
        lastCodeChar = c;
        continue;
      }
      // Track brace depth — needed for template ${...} expression closure.
      if (c === "{") braceDepth++;
      else if (c === "}") {
        // Closing `}` may end a template ${} expression
        if (templateStack.length > 0 && templateStack[templateStack.length - 1]!.braceDepth === braceDepth) {
          templateStack.pop();
          state = "template";
          out.push(" ");
          i++;
          // Reset code-state token tracking
          if (identBuf.length > 0) { prevToken = identBuf; identBuf = ""; }
          lastCodeChar = "";
          continue;
        }
        braceDepth--;
      }
      out.push(c);
      if (/\s/.test(c)) {
        // Whitespace flushes any identifier accumulated so far to prevToken.
        if (identBuf.length > 0) {
          prevToken = identBuf;
          identBuf = "";
        }
      } else {
        lastCodeChar = c;
        // Track identifier-shaped tokens for keyword-aware regex detection.
        if (/[A-Za-z_$]/.test(c) || (/[0-9]/.test(c) && identBuf.length > 0)) {
          identBuf += c;
        } else {
          if (identBuf.length > 0) prevToken = identBuf;
          identBuf = "";
        }
      }
      i++;
      continue;
    }
    if (state === "lineComment") {
      if (c === "\n") {
        state = "code";
        out.push("\n");
        i++;
        continue;
      }
      out.push(" ");
      i++;
      continue;
    }
    if (state === "blockComment") {
      if (c === "*" && next === "/") {
        state = "code";
        out.push(" ", " ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
      continue;
    }
    if (state === "regex") {
      if (c === "\\" && next) {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === "[") {
        out.push(" ");
        i++;
        while (i < n && source[i] !== "]") {
          if (source[i] === "\\" && i + 1 < n) {
            out.push(" ", " ");
            i += 2;
            continue;
          }
          out.push(source[i] === "\n" ? "\n" : " ");
          i++;
        }
        if (i < n) {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (c === "/") {
        // Adversarial Run 1: consume trailing regex flags `gimsuy...` so they
        // don't leak into code stream as identifier characters.
        out.push(" ");
        i++;
        while (i < n && /[gimsuyd]/.test(source[i]!)) {
          out.push(" ");
          i++;
        }
        state = "code";
        lastCodeChar = "/";
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i++;
      continue;
    }
    // string-like states: single, double, template
    const closer =
      state === "single" ? "'" : state === "double" ? '"' : "`";
    if (c === "\\" && next) {
      out.push(" ", " ");
      i += 2;
      continue;
    }
    // Template ${...} interpolation — switch to code state, push template
    // context onto stack so we resume after matching `}`.
    if (state === "template" && c === "$" && next === "{") {
      templateStack.push({ braceDepth: braceDepth });
      braceDepth++;
      state = "code";
      out.push("$", "{"); // preserve in output so contents get processed
      i += 2;
      lastCodeChar = "{";
      continue;
    }
    if (c === closer) {
      state = "code";
      out.push(" ");
      i++;
      continue;
    }
    out.push(c === "\n" ? "\n" : " ");
    i++;
  }
  return out.join("");
}
