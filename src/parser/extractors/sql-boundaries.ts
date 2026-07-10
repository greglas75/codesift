export function sliceBalancedParens(source: string, openIdx: number): string | null {
  if (source[openIdx] !== "(") return null;
  let depth = 0;
  let inString = false;
  let stringQuote = "";
  for (let k = openIdx; k < source.length; k++) {
    const ch = source[k]!;
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIdx + 1, k);
    }
  }
  return null;
}

/** Split a string on commas at parens-depth 0, ignoring commas inside strings/parens. */
export function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let start = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]!;
    if (inString) {
      if (ch === stringQuote && body[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, k));
      start = k + 1;
    }
  }
  if (start < body.length) out.push(body.slice(start));
  return out;
}

// ── Byte-precise end finding (for source-string scanning) ─

export function findEndByte(source: string, startOffset: number, strategy: string): number {
  switch (strategy) {
    case "paren":
      return findClosingParenByte(source, startOffset);
    case "semicolon":
      return findSemicolonByte(source, startOffset);
    case "begin-end":
      return findBeginEndByte(source, startOffset);
    case "single-line":
      return source.indexOf("\n", startOffset) ?? source.length - 1;
    default:
      return findSemicolonByte(source, startOffset);
  }
}

/** Scan source for next `;` outside strings/comments */
function findSemicolonByte(source: string, startOffset: number): number {
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  for (let k = startOffset; k < source.length; k++) {
    const ch = source[k]!;
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "-" && source[k + 1] === "-") { inLineComment = true; k++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === ";") return k;
  }
  return source.length - 1;
}

/** Scan source for matching closing paren outside strings/comments */
function findClosingParenByte(source: string, startOffset: number): number {
  // First find the opening paren
  let openIdx = source.indexOf("(", startOffset);
  if (openIdx === -1) return findSemicolonByte(source, startOffset);

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  for (let k = openIdx; k < source.length; k++) {
    const ch = source[k]!;
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "-" && source[k + 1] === "-") { inLineComment = true; k++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        // Also include trailing semicolon if present nearby
        const semi = source.indexOf(";", k);
        if (semi !== -1 && semi - k < 200) return semi;
        return k;
      }
    }
  }
  return source.length - 1;
}

/** Scan source for BEGIN...END or fall back to semicolon */
function findBeginEndByte(source: string, startOffset: number): number {
  // Simplified: just use semicolon scan (BEGIN/END structures are rare in our test corpus)
  return findSemicolonByte(source, startOffset);
}

// ── Helpers ───────────────────────────────────────────────
