// Bug it catches: a tool path that materialises the whole index again. On tgm-survey-platform
// (1.4M symbols) one `getCodeIndex` is ~13 s and +2.4 GB of heap, larger than the daemon's index cache
// budget — ADR-004 stage 2 / ADR-006 stage 7 moved every tool onto narrow reads. A new call site has to
// be justified here, next to the ones that remain on purpose.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings } from "../../src/utils/source-stripper.js";

/** Where a whole-index load is deliberate, and why. */
const ALLOWED: Record<string, string> = {
  "src/tools/index-tools/registry.ts": "the definition",
  "src/tools/graph-tools.ts": "TypeScript fallback when there is no native call graph",
  "src/tools/impact-tools.ts": "TypeScript fallback when there is no native call graph",
  "src/tools/route-tools/trace-route.ts": "TypeScript fallback when there is no native call graph",
  "src/tools/review-diff/orchestrator.ts": "small repos (<= 150k symbols): one load serves ten concurrent checks",
  "src/tools/php8-migration-candidates-tools.ts": "rules depend on whole-index order across disjoint predicates; no recorded calls",
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = /\.(?:ts|tsx|mts|cts)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

/** Import and export lists name the function without using it — unless they rename it. */
const MODULE_LIST = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g;

/**
 * Whether the source USES `getCodeIndex`: a call, a reference (`const load = getCodeIndex`), or an
 * import that renames it. Comments and string contents are blanked first, so prose, error messages
 * and a `//` inside a string neither count nor hide the code after them.
 */
function usesGetCodeIndex(source: string): boolean {
  const code = stripCommentsAndStrings(source);
  const lists = code.match(MODULE_LIST) ?? [];
  if (lists.some((list) => /\bgetCodeIndex\s+as\b/.test(list))) return true;
  return /\bgetCodeIndex\b/.test(code.replace(MODULE_LIST, ""));
}

describe("whole-index loads", () => {
  it("happen only where they are deliberate", () => {
    const callers = sourceFiles(join(ROOT, "src"))
      .filter((file) => usesGetCodeIndex(readFileSync(file, "utf-8")))
      .map((file) => relative(ROOT, file).split("\\").join("/"))
      .sort();
    expect(callers).toEqual(Object.keys(ALLOWED).sort());
  });

  // Bug it catches: the guard itself missing a use (or flagging prose), which lets a load ship unseen.
  it.each([
    ["a call", "await getCodeIndex(repo);", true],
    ["a reference", "const load = getCodeIndex;", true],
    ["a renamed import", 'import { getCodeIndex as load } from "./x.js";', true],
    ["a call after a string holding //", 'const u = "a//b"; await getCodeIndex(repo);', true],
    ["a call between strings holding comment marks", 'const a = "/*"; getCodeIndex(r); const b = "*/";', true],
    ["a plain import with no use", 'import { getCodeIndex } from "./x.js";', false],
    ["a barrel re-export", "export { getCodeIndex, getIndexSummary };", false],
    ["a comment", "// getCodeIndex(repo) was slow", false],
    ["an error message", 'throw new Error("getCodeIndex(repo) failed");', false],
  ])("treats %s correctly", (_case, source, expected) => {
    expect(usesGetCodeIndex(source)).toBe(expected);
  });
});
