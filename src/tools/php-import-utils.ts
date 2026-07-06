/**
 * Shared PHP namespace/import parsing helpers for lightweight tool analysis.
 */

export function extractPhpNamespace(source?: string): string | null {
  const match = /\bnamespace\s+([^;{]+)\s*[;{]/m.exec(source ?? "");
  return match?.[1]?.trim().replace(/^\\/, "") ?? null;
}

export function extractPhpUseImports(source?: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of (source ?? "").matchAll(/^\s*use\s+(?!function\b|const\b)([^;]+);/gm)) {
    for (const rawClause of splitTopLevelCommas(match[1]!)) {
      const clause = rawClause.trim();
      if (!clause) continue;

      const group = /^(.+?)\\?\{(.+)\}$/.exec(clause);
      if (group) {
        const prefix = group[1]!.trim().replace(/^\\/, "").replace(/\\+/g, "\\").replace(/\\$/, "");
        for (const member of splitTopLevelCommas(group[2]!)) {
          const raw = member.trim();
          if (!raw) continue;
          const aliasMatch = /^(.+?)\s+as\s+([A-Za-z_]\w*)$/i.exec(raw);
          const imported = (aliasMatch?.[1] ?? raw).trim().replace(/^\\/, "").replace(/\\+/g, "\\");
          const fqcn = `${prefix}\\${imported}`;
          const alias = aliasMatch?.[2] ?? fqcn.split("\\").pop();
          if (alias) imports.set(alias, fqcn);
        }
        continue;
      }

      const aliasMatch = /^(.+?)\s+as\s+([A-Za-z_]\w*)$/i.exec(clause);
      const fqcn = (aliasMatch?.[1] ?? clause).trim().replace(/^\\/, "").replace(/\\+/g, "\\");
      const alias = aliasMatch?.[2] ?? fqcn.split("\\").pop();
      if (alias) imports.set(alias, fqcn);
    }
  }
  return imports;
}

export function resolvePhpClassReference(
  classRef: string,
  context?: { namespace?: string | null; imports?: Map<string, string> },
): string {
  if (classRef.startsWith("\\")) return classRef.slice(1);

  const segments = classRef.split("\\");
  const first = segments[0]!;
  const imported = context?.imports?.get(first);
  if (imported) {
    return segments.length === 1
      ? imported
      : `${imported}\\${segments.slice(1).join("\\")}`;
  }

  return context?.namespace ? `${context.namespace}\\${classRef}` : classRef;
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}
