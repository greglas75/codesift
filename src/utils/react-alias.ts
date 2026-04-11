/**
 * React/Vite/Next.js path alias resolver — heuristic.
 *
 * Resolves `@/components/Foo` to a real file path within the repo without
 * parsing tsconfig.json. Tries common conventions: src/, lib/, then root.
 *
 * Returns null for non-aliased imports (anything not starting with "@/").
 *
 * Used by trace_component_tree and React-aware analysis to bridge the gap
 * between import statements and actual file locations.
 */

const TS_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js", "/index.tsx", "/index.jsx", "/index.ts", "/index.js"];
const ROOT_CANDIDATES = ["src", "lib"];

export function resolveAlias(
  importPath: string,
  files: { path: string }[],
): string | null {
  if (!importPath.startsWith("@/")) return null;
  const rest = importPath.slice(2);

  // Try src/, lib/, then root (no prefix)
  const bases = [...ROOT_CANDIDATES.map((r) => `${r}/${rest}`), rest];

  // Build a Set for O(1) lookup — files list can be large
  const fileSet = new Set(files.map((f) => f.path));

  for (const base of bases) {
    for (const ext of TS_EXTENSIONS) {
      const target = base + ext;
      if (fileSet.has(target)) return target;
    }
  }

  return null;
}
