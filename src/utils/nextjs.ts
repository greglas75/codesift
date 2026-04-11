import { readFile } from "node:fs/promises";

/** Maximum bytes to read when scanning for a directive. */
export const DIRECTIVE_WINDOW = 512;

/**
 * Strip BOM, shebangs, single-line comments, and block comments
 * from the beginning of source text.
 */
function stripBomAndComments(text: string): string {
  let s = text;
  // Strip BOM
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // Strip shebang
  if (s.startsWith("#!")) {
    const nl = s.indexOf("\n");
    s = nl >= 0 ? s.slice(nl + 1) : "";
  }
  // Iteratively strip leading comments
  let changed = true;
  while (changed) {
    changed = false;
    s = s.trimStart();
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl >= 0 ? s.slice(nl + 1) : "";
      changed = true;
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end >= 0) {
        s = s.slice(end + 2);
        changed = true;
      }
    }
  }
  return s;
}

/**
 * Scan a file's first 512 bytes for a `"use client"` or `"use server"` directive.
 * Returns the directive string or `null` if not found.
 */
export async function scanDirective(
  filePath: string,
): Promise<"use client" | "use server" | null> {
  try {
    const buf = await readFile(filePath, { encoding: "utf8", flag: "r" });
    const head = buf.slice(0, DIRECTIVE_WINDOW);
    const stripped = stripBomAndComments(head);
    const match = stripped.match(/^\s*["'`](use (?:client|server))["'`]\s*;?/);
    return match ? (match[1] as "use client" | "use server") : null;
  } catch {
    return null;
  }
}
