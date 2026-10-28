/**
 * The git side of `codesift dup-check`: which checkout we are in, what we diff against, and which
 * lines the branch adds. Every call is a plain `git` subprocess run from the checkout's top level, so
 * the paths it returns are relative to that top level.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

/** Bad invocation (not a git checkout, unknown base ref): the CLI exits 2, never 1. */
export class DupCheckUsageError extends Error {}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrNull(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

export function checkoutTopLevel(cwd: string): string {
  const top = gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new DupCheckUsageError(`not a git repository: ${cwd}`);
  return top;
}

/** The main checkout's root when `topLevel` is a linked worktree, else null. */
export function mainCheckoutRoot(topLevel: string): string | null {
  const common = gitOrNull(topLevel, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return null;
  const main = dirname(common);
  return main === topLevel ? null : main;
}

/** `origin/HEAD`'s target (e.g. `origin/develop`), then `origin/main`, then `main`. */
export function defaultBaseRef(topLevel: string): string {
  const head = gitOrNull(topLevel, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (head?.startsWith("refs/remotes/")) return head.slice("refs/remotes/".length);
  for (const ref of ["origin/main", "main"]) {
    if (gitOrNull(topLevel, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])) return ref;
  }
  throw new DupCheckUsageError(
    "no default base: origin/HEAD, origin/main and main are all missing — pass --base <ref>",
  );
}

export function mergeBaseWith(topLevel: string, base: string): string {
  if (!gitOrNull(topLevel, ["rev-parse", "--verify", "-q", `${base}^{commit}`])) {
    throw new DupCheckUsageError(`unknown base ref: ${base}`);
  }
  const mb = gitOrNull(topLevel, ["merge-base", base, "HEAD"]);
  if (!mb) throw new DupCheckUsageError(`no merge base between ${base} and HEAD`);
  return mb;
}

/**
 * The merge base against the WORKING TREE, so committed, staged and unstaged edits all count.
 * `--no-renames` turns a move into delete + add: the old path then drops out of the comparison pool
 * (it is superseded), so a moved function is not reported as a copy of itself. Prefixes are pinned
 * because `diff.noprefix` / `diff.mnemonicPrefix` in a user's config would change them.
 */
export function diffAgainst(topLevel: string, mergeBase: string): string {
  return git(topLevel, [
    "-c", "core.quotePath=false",
    "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--src-prefix=a/", "--dst-prefix=b/", mergeBase, "--",
  ]);
}

export function untrackedFiles(topLevel: string): string[] {
  const out = git(topLevel, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/** Inclusive 1-based line range. */
export type LineRange = readonly [number, number];

export interface AddedLines {
  /** Files with at least one added line, mapped to the added ranges in the NEW file. */
  added: Map<string, LineRange[]>;
  /** Every path the diff mentions on either side (added, modified or deleted). */
  touched: Set<string>;
}

/** Undo git's C-style quoting of a path (`"a/x\ty"`, octal bytes for anything else). */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf-8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → null. Git appends a TAB to names containing a space. */
function diffHeaderPath(rest: string, prefix: "a/" | "b/"): string | null {
  const path = unquoteGitPath(rest.replace(/\t$/, ""));
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Added line ranges from a `git diff -U0` (prefixes `a/` and `b/`).
 *
 * Hunk bodies are consumed by their header's counts rather than by prefix, because inside a hunk a
 * removed line whose text starts with `-- ` (an SQL or Lua comment) reads as `--- …` — a file header
 * to any parser that only looks at the first characters.
 */
export function parseAddedLines(diff: string): AddedLines {
  const added = new Map<string, LineRange[]>();
  const touched = new Set<string>();
  let current: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (oldLeft > 0 && line.startsWith("-")) { oldLeft--; continue; }
    if (newLeft > 0 && line.startsWith("+")) { newLeft--; continue; }
    oldLeft = 0;
    newLeft = 0;
    if (line.startsWith("diff --git ")) {
      current = null;
    } else if (line.startsWith("--- ")) {
      const old = diffHeaderPath(line.slice(4), "a/");
      if (old) touched.add(old);
    } else if (line.startsWith("+++ ")) {
      current = diffHeaderPath(line.slice(4), "b/");
      if (current) touched.add(current);
    } else {
      const hunk = HUNK_RE.exec(line);
      if (!hunk) continue;
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const start = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (current && newLeft > 0) {
        const ranges = added.get(current) ?? [];
        ranges.push([start, start + newLeft - 1]);
        added.set(current, ranges);
      }
    }
  }
  return { added, touched };
}

/** Does the symbol's line span share at least one line with an added range? */
export function intersectsAddedLines(startLine: number, endLine: number, ranges: readonly LineRange[]): boolean {
  return ranges.some(([from, to]) => from <= endLine && to >= startLine);
}
