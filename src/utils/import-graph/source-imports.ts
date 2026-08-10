const IMPORT_PATTERNS = [
  /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"](\.\.?\/[^'"]+\.php)['"]/g,
];

function collectImports(source: string, includeBare: boolean): string[] {
  const imports = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const importPath = match[1];
      if (!importPath) continue;
      const isRelative = importPath.startsWith(".");
      if ((includeBare && !isRelative && !importPath.startsWith("/")) ||
          (!includeBare && isRelative)) {
        imports.add(importPath);
      }
    }
  }
  return [...imports];
}

/** Extract relative import paths from a source string. */
export function extractImports(source: string): string[] {
  return collectImports(source, false);
}

/** Extract bare-specifier imports for workspace and tsconfig resolution. */
export function extractBareImports(source: string): string[] {
  return collectImports(source, true);
}
