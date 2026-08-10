import type { CodeIndex } from "../../types.js";

const PHP_USE_SINGLE_PATTERN = /^\s*use\s+(\w+(?:\\\w+)+)(?:\s+as\s+\w+)?\s*;/gm;
const PHP_USE_GROUP_PATTERN = /^\s*use\s+(\w+(?:\\\w+)*)\\\{([^}]+)\}\s*;/gm;
const KOTLIN_IMPORT_PATTERN = /^\s*import\s+([\w.]+(?:\.\*)?)(?:\s+as\s+\w+)?\s*$/gm;
const EXTERNAL_KOTLIN_PREFIXES = [
  "kotlin.", "java.", "javax.", "android.", "androidx.",
  "org.jetbrains.", "org.junit.",
] as const;

export function extractPhpUseStatements(source: string): string[] {
  const uses = new Set<string>();
  PHP_USE_SINGLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHP_USE_SINGLE_PATTERN.exec(source)) !== null) {
    const fqcn = match[1]?.replace(/^\\/, "");
    if (fqcn) uses.add(fqcn);
  }
  PHP_USE_GROUP_PATTERN.lastIndex = 0;
  while ((match = PHP_USE_GROUP_PATTERN.exec(source)) !== null) {
    const prefix = match[1]?.replace(/^\\/, "");
    const members = match[2];
    if (!prefix || !members) continue;
    for (const raw of members.split(",")) {
      const bare = raw.replace(/\s+as\s+\w+\s*$/, "").trim();
      if (bare) uses.add(`${prefix}\\${bare}`);
    }
  }
  return [...uses];
}

export function extractKotlinImports(source: string): string[] {
  const imports = new Set<string>();
  KOTLIN_IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KOTLIN_IMPORT_PATTERN.exec(source)) !== null) {
    if (match[1]) imports.add(match[1]);
  }
  return [...imports];
}

export function resolveKotlinImport(
  fqName: string,
  kotlinFilesByBasename: Map<string, string[]>,
): string | null {
  if (fqName.endsWith(".*") || EXTERNAL_KOTLIN_PREFIXES.some((prefix) => fqName.startsWith(prefix))) {
    return null;
  }
  const parts = fqName.split(".");
  if (parts.length < 2) return null;
  const simpleName = parts[parts.length - 1]!;
  const packagePath = parts.slice(0, -1).join("/");
  const candidates = kotlinFilesByBasename.get(simpleName);
  if (!candidates) return null;
  for (const candidate of candidates) {
    if (candidate.includes(packagePath)) return candidate;
  }
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function buildKotlinFilesByBasename(index: CodeIndex): Map<string, string[]> {
  const filesByBasename = new Map<string, string[]>();
  for (const file of index.files) {
    if (!/\.kts?$/.test(file.path)) continue;
    const basename = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.kts?$/, "");
    const existing = filesByBasename.get(basename);
    if (existing) existing.push(file.path);
    else filesByBasename.set(basename, [file.path]);
  }
  return filesByBasename;
}
