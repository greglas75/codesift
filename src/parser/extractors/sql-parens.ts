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
