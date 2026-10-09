import { execFileSync } from "node:child_process";
import type { ReviewIndex } from "../review-index.js";
import type { CheckResult, ReviewFinding } from "../types.js";

const TS_JS_RE = /\.(tsx?|jsx?)$/;
const EXPORT_NAMED_RE =
  /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
const EXPORT_DEFAULT_RE = /export\s+default/g;

/**
 * Breaking changes check: detect exported symbols removed between `since` and
 * current index. For each changed .ts/.js file, `git show` retrieves the old
 * source and a regex extracts export names. These are compared against the
 * current index symbols. Missing exports -> T1 "breaking" findings.
 *
 * File-level renames (detected via `git diff --find-renames`) are suppressed
 * because renames naturally lose old export names.
 */
export async function checkBreakingChanges(
  index: Pick<ReviewIndex, "symbolsInFile">,
  repoRoot: string,
  changedFiles: string[],
  since: string,
  until: string,
): Promise<CheckResult> {
  const start = Date.now();

  try {
    const renamedFiles = detectRenamedFiles(repoRoot, since, until);
    const filesToCompare = changedFiles.filter((f) => isComparableSourceFile(f, renamedFiles));
    const findings: ReviewFinding[] = [];
    for (const file of filesToCompare) {
      findings.push(...await findRemovedExports(index, repoRoot, file, since));
    }

    return {
      check: "breaking",
      status: findings.length > 0 ? "fail" : "pass",
      findings,
      duration_ms: Date.now() - start,
      summary: findings.length > 0
        ? `${findings.length} removed export(s) detected`
        : "No breaking changes detected",
    };
  } catch (err: unknown) {
    return {
      check: "breaking",
      status: "error",
      findings: [],
      duration_ms: Date.now() - start,
      summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function detectRenamedFiles(repoRoot: string, since: string, until: string): Set<string> {
  try {
    const renameRaw = execFileSync(
      "git",
      [
        "diff",
        "--find-renames",
        "--name-status",
        `${since}..${until || "HEAD"}`,
      ],
      { cwd: repoRoot, encoding: "utf-8", timeout: 10_000 },
    );
    return parseRenamedFiles(renameRaw);
  } catch {
    // If rename detection fails, proceed without suppression.
    return new Set<string>();
  }
}

function parseRenamedFiles(renameRaw: string): Set<string> {
  const renamedFiles = new Set<string>();
  for (const line of renameRaw.split("\n")) {
    if (!line.startsWith("R")) continue;
    const parts = line.split("\t");
    if (parts[1]) renamedFiles.add(parts[1]);
    if (parts[2]) renamedFiles.add(parts[2]);
  }
  return renamedFiles;
}

function isComparableSourceFile(file: string, renamedFiles: Set<string>): boolean {
  return TS_JS_RE.test(file) && !renamedFiles.has(file);
}

async function findRemovedExports(
  index: Pick<ReviewIndex, "symbolsInFile">,
  repoRoot: string,
  file: string,
  since: string,
): Promise<ReviewFinding[]> {
  let oldSource: string;
  try {
    oldSource = execFileSync(
      "git",
      ["show", `${since}:${file}`],
      { cwd: repoRoot, encoding: "utf-8", timeout: 10_000 },
    );
  } catch {
    // git show failed -> file didn't exist at `since` (new file), skip.
    return [];
  }

  const oldExports = extractExportNames(oldSource);
  if (oldExports.size === 0) return [];
  // Outside the try: a store fault must fail the check, not read as "the file is new".
  return removedExportFindings(file, oldExports, await currentExports(index, file));
}

function extractExportNames(source: string): Set<string> {
  const exports = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = EXPORT_NAMED_RE.exec(source)) !== null) {
    exports.add(match[1]!);
  }
  while ((match = EXPORT_DEFAULT_RE.exec(source)) !== null) {
    exports.add("default");
  }

  return exports;
}

async function currentExports(index: Pick<ReviewIndex, "symbolsInFile">, file: string): Promise<Set<string>> {
  return new Set(
    (await index.symbolsInFile(file))
      .filter((s) => !s.parent)
      .map((s) => s.name),
  );
}

function removedExportFindings(
  file: string,
  oldExports: Set<string>,
  newExports: Set<string>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const name of oldExports) {
    if (newExports.has(name)) continue;
    findings.push({
      check: "breaking",
      severity: "error",
      message: `Removed export "${name}" from ${file} — may break downstream consumers`,
      file,
      symbol: name,
    });
  }

  return findings;
}
