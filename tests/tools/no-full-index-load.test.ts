// Bug it catches: a tool path that materialises the whole index again. On tgm-survey-platform
// (1.4M symbols) one `getCodeIndex` is ~13 s and +2.4 GB of heap, larger than the daemon's index cache
// budget — ADR-004 stage 2 / ADR-006 stage 7 moved every tool onto narrow reads. A new call site has to
// be justified here, next to the ones that remain on purpose.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** Where a whole-index load is deliberate, and why. */
const ALLOWED: Record<string, string> = {
  "src/tools/index-tools/registry.ts": "the definition",
  "src/tools/graph-tools.ts": "TypeScript fallback when there is no native call graph",
  "src/tools/impact-tools.ts": "TypeScript fallback when there is no native call graph",
  "src/tools/route-tools/trace-route.ts": "TypeScript fallback when there is no native call graph",
  "src/tools/review-diff/orchestrator.ts": "small repos (<= 150k symbols): one load serves ten concurrent checks",
  "src/tools/php8-migration-candidates-tools.ts": "rules depend on whole-index order across disjoint predicates; no recorded calls",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Drop comments so prose mentioning the function does not count as a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("whole-index loads", () => {
  it("happen only where they are deliberate", () => {
    const root = process.cwd();
    const callers = sourceFiles(join(root, "src"))
      .filter((file) => /\bgetCodeIndex\s*\(/.test(stripComments(readFileSync(file, "utf-8"))))
      .map((file) => relative(root, file).split("\\").join("/"))
      .sort();
    expect(callers).toEqual(Object.keys(ALLOWED).sort());
  });
});
