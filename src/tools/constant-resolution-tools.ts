import type { IndexSummary } from "../storage/sqlite-index-store.js";
import { findRepoSymbols, getIndexSummary } from "./index-tools.js";
import type { ConstantResolutionResult, ConstantResolutionMatch } from "./python-constants-tools.js";
import { resolveConstantValue as resolvePythonConstantValue } from "./python-constants-tools.js";
import { resolveTypeScriptConstantValue } from "./typescript-constants-tools.js";
import { matchesConstantFilePattern } from "../utils/constant-file-pattern.js";

export type ConstantResolutionLanguage = "python" | "typescript";

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

async function inferLanguages(
  repo: string,
  index: IndexSummary,
  symbolName: string,
  options?: { file_pattern?: string; language?: ConstantResolutionLanguage },
): Promise<ConstantResolutionLanguage[]> {
  if (options?.language) return [options.language];

  const pattern = options?.file_pattern ?? "";
  if (pattern.endsWith(".py")) return ["python"];
  if (pattern.endsWith(".ts") || pattern.endsWith(".tsx")) return ["typescript"];

  // Only symbols with this exact name can vote, so one `WHERE name = ?` read replaces a walk over
  // the whole materialised index. Their file is all that is looked at.
  const candidates = (
    await findRepoSymbols(repo, { name: symbolName, withSource: false }, { skipFreshness: true })
  ).filter((symbol) => matchesConstantFilePattern(symbol.file, options?.file_pattern));

  const hasPython = candidates.some((symbol) => symbol.file.endsWith(".py"));
  const hasTypeScript = candidates.some((symbol) => isTypeScriptFile(symbol.file));

  if (hasPython && hasTypeScript) return ["python", "typescript"];
  if (hasPython) return ["python"];
  if (hasTypeScript) return ["typescript"];

  const repoHasPython = index.files.some((file) => file.path.endsWith(".py"));
  const repoHasTypeScript = index.files.some((file) => isTypeScriptFile(file.path));

  if (repoHasPython && repoHasTypeScript) return ["python", "typescript"];
  if (repoHasPython) return ["python"];
  if (repoHasTypeScript) return ["typescript"];
  return [];
}

function normalizeMatches(
  matches: ConstantResolutionMatch[],
  language: ConstantResolutionLanguage,
): ConstantResolutionMatch[] {
  return matches.map((match) => ({
    ...match,
    language,
  }));
}

export async function resolveConstantValue(
  repo: string,
  symbolName: string,
  options?: {
    file_pattern?: string;
    max_depth?: number;
    language?: ConstantResolutionLanguage;
  },
): Promise<ConstantResolutionResult> {
  const index = await getIndexSummary(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found.`);
  }

  const languages = await inferLanguages(repo, index, symbolName, options);
  if (languages.length === 0) {
    return { query: symbolName, matches: [] };
  }

  const matches: ConstantResolutionMatch[] = [];

  // No shared index is handed down any more: the Python resolver reads only what it needs, and
  // the TypeScript resolver loads its own when it runs (it already did so whenever it was called
  // directly). Materialising here would force the whole index on a Python-only query.
  const { language: _language, ...resolverOptions } = options ?? {};
  for (const language of languages) {
    if (language === "python") {
      const result = await resolvePythonConstantValue(repo, symbolName, resolverOptions);
      matches.push(...normalizeMatches(result.matches, "python"));
      continue;
    }

    if (language === "typescript") {
      const result = await resolveTypeScriptConstantValue(repo, symbolName, resolverOptions);
      matches.push(...normalizeMatches(result.matches, "typescript"));
    }
  }

  matches.sort((a, b) =>
    a.file.localeCompare(b.file)
    || a.line - b.line
    || (a.language ?? "").localeCompare(b.language ?? ""),
  );

  return {
    query: symbolName,
    matches,
  };
}
