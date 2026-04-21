import { execFileSync } from "node:child_process";

export const GIT_LOG_FORMAT = "%H%x1F%aI%x1F%an%x1F%s%x1F%P%x1F%D";
export const GIT_TIMEOUT_MS = 10_000;

export interface GitLogOptions {
  /** ISO date or git-relative string like "2 weeks ago" */
  since?: string;
  maxCount?: number;
  cwd?: string;
}

export interface GitCommit {
  sha: string;
  /** ISO8601 author date */
  date: string;
  /** Author name only — no email (CQ5 privacy) */
  authorName: string;
  subject: string;
  parentShas: string[];
  refs: string[];
}

export function gitLog(opts: GitLogOptions = {}): GitCommit[] {
  const { since, maxCount, cwd } = opts;

  const args: string[] = [
    "log",
    `--pretty=format:${GIT_LOG_FORMAT}`,
    "--all",
  ];

  if (maxCount !== undefined) {
    args.push(`--max-count=${maxCount}`);
  }
  if (since !== undefined) {
    args.push(`--since=${since}`);
  }

  let raw: string;
  try {
    raw = execFileSync("git", args, {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      cwd,
    });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status === 128) {
      // Not a git repo or no commits yet — treat as empty history.
      return [];
    }
    throw new Error(
      `gitLog failed: ${e.message ?? String(err)}`,
    );
  }

  if (!raw.trim()) return [];

  const commits: GitCommit[] = [];
  let skipped = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const fields = line.split("\x1F");
    if (fields.length !== 6) { skipped++; continue; }

    const [sha, date, authorName, subject, parentsRaw, refsRaw] =
      fields as [string, string, string, string, string, string];

    commits.push({
      sha, date, authorName, subject,
      parentShas: parentsRaw.split(" ").filter((s) => s.length > 0),
      refs: refsRaw.split(", ").filter((s) => s.length > 0),
    });
  }

  if (skipped > 0) {
    console.warn(`[journal-git-client] skipped ${skipped} malformed log line(s)`);
  }

  return commits;
}
