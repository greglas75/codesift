import { describe, expect, it } from "vitest";
import { intersectsAddedLines, parseAddedLines, type LineRange } from "../../src/tools/dup-check-git.js";

function diffOf(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("parseAddedLines", () => {
  it.each<{ name: string; diff: string; added: Record<string, LineRange[]>; touched: string[] }>([
    {
      // Bug caught: a new file (`-0,0`) must count every line as added, not zero lines.
      name: "new file: every line is added",
      diff: diffOf(
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,3 @@",
        "+a", "+b", "+c",
      ),
      added: { "src/new.ts": [[1, 3]] },
      touched: ["src/new.ts"],
    },
    {
      // Bug caught: a `+N,0` hunk (pure deletion) produced a bogus [N, N-1] range.
      name: "pure deletion: file touched, nothing added",
      diff: diffOf(
        "diff --git a/src/x.ts b/src/x.ts",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -5,2 +4,0 @@",
        "-gone", "-gone too",
      ),
      added: {},
      touched: ["src/x.ts"],
    },
    {
      // Bug caught: only the first hunk of a file was kept, and an omitted count (`+9`) means 1.
      name: "multiple hunks, one with an omitted count",
      diff: diffOf(
        "diff --git a/src/x.ts b/src/x.ts",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -1 +1,2 @@",
        "-old", "+new", "+newer",
        "@@ -8,0 +9 @@",
        "+inserted",
      ),
      added: { "src/x.ts": [[1, 2], [9, 9]] },
      touched: ["src/x.ts"],
    },
    {
      // Bug caught: a deleted file's old path was dropped, so its stale index copy stayed in the pool.
      name: "deleted file: old path touched, nothing added",
      diff: diffOf(
        "diff --git a/src/dead.ts b/src/dead.ts",
        "deleted file mode 100644",
        "--- a/src/dead.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-a", "-b",
      ),
      added: {},
      touched: ["src/dead.ts"],
    },
    {
      // Bug caught: a removed SQL comment `-- x` reads as `--- x`, a file header, and derails parsing.
      name: "removed line starting with '-- ' is hunk body, not a header",
      diff: diffOf(
        "diff --git a/db/q.sql b/db/q.sql",
        "--- a/db/q.sql",
        "+++ b/db/q.sql",
        "@@ -3,1 +3,1 @@",
        "--- old comment",
        "+-- new comment",
        "@@ -10,0 +11,1 @@",
        "+select 1;",
      ),
      added: { "db/q.sql": [[3, 3], [11, 11]] },
      touched: ["db/q.sql"],
    },
    {
      // Bug caught: git quotes unusual names and appends a TAB to names with spaces.
      name: "quoted path and trailing tab",
      diff: diffOf(
        'diff --git "a/src/t\\tab.ts" "b/src/t\\tab.ts"',
        '--- "a/src/t\\tab.ts"',
        '+++ "b/src/t\\tab.ts"',
        "@@ -0,0 +1 @@",
        "+x",
        "diff --git a/src/my file.ts b/src/my file.ts",
        "--- a/src/my file.ts\t",
        "+++ b/src/my file.ts\t",
        "@@ -0,0 +1 @@",
        "+y",
      ),
      added: { "src/t\tab.ts": [[1, 1]], "src/my file.ts": [[1, 1]] },
      touched: ["src/t\tab.ts", "src/my file.ts"],
    },
  ])("$name", ({ diff, added, touched }) => {
    const result = parseAddedLines(diff);
    expect(Object.fromEntries(result.added)).toEqual(added);
    expect([...result.touched].sort()).toEqual([...touched].sort());
  });
});

describe("intersectsAddedLines", () => {
  const ranges: LineRange[] = [[10, 12], [30, 30]];
  it.each<{ name: string; start: number; end: number; expected: boolean }>([
    // Bug caught: an off-by-one on either boundary misses a symbol whose first or last line was edited.
    { name: "symbol ends on the first added line", start: 1, end: 10, expected: true },
    { name: "symbol starts on the last added line", start: 12, end: 20, expected: true },
    { name: "symbol encloses a one-line range", start: 25, end: 35, expected: true },
    { name: "symbol between ranges", start: 13, end: 29, expected: false },
    { name: "symbol after every range", start: 31, end: 40, expected: false },
  ])("$name", ({ start, end, expected }) => {
    expect(intersectsAddedLines(start, end, ranges)).toBe(expected);
  });
});
