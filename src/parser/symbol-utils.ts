/** Split camelCase, PascalCase, and snake_case identifiers into lowercase tokens. */
export function tokenizeIdentifier(name: string): string[] {
  const parts = name.split("_").filter(Boolean);
  const tokens: string[] = [];
  for (const part of parts) {
    const subParts = part
      .replace(/([a-z0-9])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0");
    for (const subPart of subParts) {
      if (subPart.length > 0) tokens.push(subPart.toLowerCase());
    }
  }
  return tokens;
}

export function makeSymbolId(
  repo: string,
  file: string,
  name: string,
  startLine: number,
): string {
  return `${repo}:${file}:${name}:${startLine}`;
}
