/**
 * Match indexed file paths against `resolve_constant_value` `file_pattern`.
 * Prefers exact, suffix, or path-segment matches. The slash-free substring fallback
 * requires a path-segment boundary (so `pattern="core"` matches `src/core/x.ts`
 * but not `src/scoreboard.ts`).
 */
export function matchesConstantFilePattern(file: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const f = file.replace(/\\/g, "/");
  const p = pattern.replace(/\\/g, "/");
  if (f === p) return true;
  if (f.endsWith(p)) return true;
  if (p.includes("/")) {
    const idx = f.indexOf(p);
    if (idx === -1) return false;
    return idx === 0 || f[idx - 1] === "/";
  }
  const lastSeg = f.split("/").pop() ?? f;
  if (lastSeg === p) return true;
  // Pattern without slash: require a full path-segment match somewhere in `f`
  // so we never match arbitrary substrings of unrelated names.
  return f.split("/").includes(p);
}
