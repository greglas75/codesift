/** Scan source for next `;` outside strings/comments */
export function findSemicolonByte(source: string, startOffset: number): number {
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
export function findClosingParenByte(source: string, startOffset: number): number {
  const openIdx = source.indexOf("(", startOffset);
  if (openIdx === -1) return findSemicolonByte(source, startOffset);

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  for (let k = openIdx; k < source.length; k++) {
    const ch = source[k]!;
    if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
    if (inString) {
      if (ch === stringQuote && source[k + 1] === stringQuote) { k++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === "-" && source[k + 1] === "-") { inLineComment = true; k++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { inString = true; stringQuote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        const semi = source.indexOf(";", k);
        return semi !== -1 && semi - k < 200 ? semi : k;
      }
    }
  }
  return source.length - 1;
}
