/**
 * Match indexed file paths against `resolve_constant_value` `file_pattern`.
 * Prefers exact or suffix matches; avoids loose substring false positives on short patterns.
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
  if (p.length >= 4) return f.includes(p);
  return false;
}
