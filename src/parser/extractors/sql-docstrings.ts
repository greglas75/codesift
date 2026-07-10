export function extractSqlDocstring(lines: string[], blockLineIdx: number): string | undefined {
  const commentLines: string[] = [];
  let inBlock = false;

  for (let j = blockLineIdx - 1; j >= 0; j--) {
    const trimmed = lines[j]!.trim();

    // Detect end of block comment (scanning upward, so */ comes first)
    if (!inBlock && trimmed.endsWith("*/")) {
      inBlock = true;
      // Handle single-line block comment: /* text */
      if (trimmed.startsWith("/*")) {
        commentLines.unshift(trimmed.slice(2, -2).trim());
        inBlock = false;
        continue;
      }
      const content = trimmed.replace(/\*\/\s*$/, "").replace(/^\s*\*\s?/, "").trim();
      if (content) commentLines.unshift(content);
      continue;
    }
    if (inBlock) {
      if (trimmed.startsWith("/*")) {
        const content = trimmed.replace(/^\/\*\s*/, "").trim();
        if (content) commentLines.unshift(content);
        inBlock = false;
        continue;
      }
      // Middle of block comment — strip leading *
      commentLines.unshift(trimmed.replace(/^\s*\*\s?/, ""));
      continue;
    }

    if (trimmed.startsWith("--")) {
      commentLines.unshift(trimmed.replace(/^--\s*/, ""));
    } else if (trimmed === "") {
      if (commentLines.length > 0) break;
    } else {
      break;
    }
  }
  return commentLines.length > 0 ? commentLines.join("\n") : undefined;
}
