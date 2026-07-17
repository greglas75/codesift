import { searchPatterns } from "../../pattern-tools.js";

// Keep the legacy audit scope stable. The pattern catalog has since grown with
// informational Python patterns that were not part of python_audit's contract.
export const PYTHON_PATTERNS = [
  "mutable-default", "bare-except", "broad-except", "eval-exec", "shell-true",
  "pickle-load", "yaml-unsafe", "shadow-builtin", "n-plus-one-django", "late-binding", "assert-tuple",
];

export async function runAntiPatterns(repo: string, file_pattern?: string) {
  const results = await Promise.all(
    PYTHON_PATTERNS.map((pattern) =>
      searchPatterns(repo, pattern, file_pattern ? { file_pattern } : undefined)
        .catch(() => ({ matches: [] })),
    ),
  );
  const matches = results.flatMap((result) => result.matches ?? []);
  return { matches, total: matches.length };
}
