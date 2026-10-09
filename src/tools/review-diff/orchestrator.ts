import picomatch from "picomatch";
import { changedSymbols } from "../diff-tools.js";
import { getCodeIndex, getIndexSummary } from "../index-tools.js";
import { validateGitRef } from "../../utils/git-validation.js";
import { reviewIndexFromSummary, type ReviewIndex } from "./review-index.js";
import {
  ALL_CHECKS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_PREPARE_TIMEOUT_MS,
  DEFAULT_MAX_FILES,
  HEAD_TILDE_PATTERN,
  type CheckName,
} from "./constants.js";
import { runCheck } from "./check-runner.js";
import { calculateScore, determineVerdict } from "./scoring.js";
import { withTimeout } from "./timeout.js";
import type { TimeoutSentinel } from "./timeout.js";
import type { CheckResult, ReviewDiffOptions, ReviewDiffResult, ReviewFinding, ReviewMetadata } from "./types.js";
import { assertGitTreeMatches } from "../git-tree-guard.js";

/** Up to this many symbols, review_diff loads the index once for all its checks (see prepareReview). */
const REVIEW_RESIDENT_MAX_SYMBOLS = 150_000;

interface DiffReviewState {
  changedFiles: string[];
  totalFilesChanged: number;
  allFindings: ReviewFinding[];
  metadata: ReviewMetadata;
}

interface ReadyReview {
  status: "ready";
  index: ReviewIndex;
  reviewState: DiffReviewState;
}

interface EarlyReview {
  status: "early";
  result: ReviewDiffResult;
}

export async function reviewDiff(
  repo: string,
  opts: ReviewDiffOptions,
): Promise<ReviewDiffResult> {
  const startTime = Date.now();
  const since = opts.since ?? "HEAD~1";
  const until = opts.until;
  const maxFiles = opts.max_files ?? DEFAULT_MAX_FILES;
  const checkTimeoutMs = opts.check_timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS;
  const prepareTimeoutMs = opts.prepare_timeout_ms ?? DEFAULT_PREPARE_TIMEOUT_MS;

  // Asymmetry, not a measurement: the checks are individually bounded
  // (DEFAULT_CHECK_TIMEOUT_MS, run in parallel) while the preparation before them — resolving the
  // git range, filtering changed files, computing changed symbols — had no ceiling at all. Worst
  // case was therefore "unbounded + 30s" inside a tool whose client-facing timeout is 90s.
  //
  // That ceiling is not a safe backstop: it answers `timed_out` and leaves the work running, which
  // is the pathology behind RequestContext.abortSignal (scan_secrets measured at 5.1 hours against
  // a 90-second budget). An unbounded phase under it is exactly how a call becomes an orphan.
  //
  // No hang is claimed here. review_diff on this repo at `since: HEAD~5` completes in ~2.5s; what
  // telemetry shows is a p90 of 47.8s across 824 real calls, i.e. a long tail that this phase can
  // extend without limit on a larger range. A bounded prep turns that tail into a reported partial:
  // the agent learns the range is too large and can narrow it, rather than waiting out the ceiling.
  const preparedOrTimeout = await withTimeout(
    prepareReview(repo, opts, since, until, maxFiles, startTime),
    prepareTimeoutMs,
  );
  if (preparedOrTimeout.status === "timeout") {
    return failReviewResult(
      repo,
      since,
      startTime,
      `preparation exceeded ${prepareTimeoutMs}ms (resolving the diff and its changed symbols) — ` +
        "narrow the range (a smaller `since`), scope it with `file_pattern`, or raise " +
        "`prepare_timeout_ms`. No checks ran.",
    );
  }
  const prepared = preparedOrTimeout;
  if (prepared.status === "early") return prepared.result;

  const enabledChecks = resolveEnabledChecks(opts.checks);
  const checkResults = await runEnabledChecks(
    enabledChecks,
    repo,
    prepared.reviewState.changedFiles,
    prepared.index,
    since,
    until ?? "HEAD",
    checkTimeoutMs,
  );

  for (const cr of checkResults) {
    prepared.reviewState.allFindings.push(...cr.findings);
  }

  return reviewResult(repo, since, startTime, prepared.reviewState, checkResults);
}

async function prepareReview(
  repo: string,
  opts: ReviewDiffOptions,
  since: string,
  until: string | undefined,
  maxFiles: number,
  startTime: number,
): Promise<ReadyReview | EarlyReview> {
  const refError = validateDiffRefs(since, until);
  if (refError) {
    return {
      status: "early",
      result: failReviewResult(repo, since, startTime, `invalid_ref: ${refError}`),
    };
  }

  const summary = await getIndexSummary(repo);
  if (!summary) {
    return {
      status: "early",
      result: failReviewResult(repo, since, startTime, `Repository not found: ${repo}`),
    };
  }

  // Same guard as the other git-range tools, but reported in this one's own shape: review_diff
  // answers with a result object rather than throwing, and turning a wrong-tree answer into an
  // exception here would change its contract for every caller.
  try {
    assertGitTreeMatches(repo, summary.root);
  } catch (err) {
    return {
      status: "early",
      result: failReviewResult(repo, since, startTime, err instanceof Error ? err.message : String(err)),
    };
  }

  // Ten checks run at once and several scan the repo. On a small index one load is cheaper than their
  // separate store reads, which queue on the same four libuv threads as the file reads: measured on
  // codesift (35k symbols), 9.2 s with narrow reads against 1.5 s with the index resident — every
  // narrow read is served from it. On a large one the load is the cost (13 s and +2.4 GB on 1.4M
  // symbols; two checks timed out and one overflowed the stack), so the checks read narrowly.
  if (summary.symbol_count <= REVIEW_RESIDENT_MAX_SYMBOLS) {
    await getCodeIndex(repo, { skipFreshness: true });
  }

  const changedFiles = await getFilteredChangedFiles(repo, since, until, opts);
  if (changedFiles.length === 0) {
    return {
      status: "early",
      result: emptyDiffResult(repo, since, startTime),
    };
  }

  return {
    status: "ready",
    index: reviewIndexFromSummary(summary),
    reviewState: prepareDiffReviewState(changedFiles, maxFiles, since),
  };
}

async function getFilteredChangedFiles(
  repo: string,
  since: string,
  until: string | undefined,
  opts: ReviewDiffOptions,
): Promise<string[]> {
  const diffResult = await changedSymbols(
    repo,
    since,
    until ?? "HEAD",
    undefined,
  );

  return applyExcludePatterns(
    diffResult.map((f) => f.file),
    opts.exclude_patterns,
  );
}

function validateDiffRefs(since: string, until: string | undefined): string | null {
  try {
    validateGitRef(since);
    if (until && until !== "WORKING" && until !== "STAGED") {
      validateGitRef(until);
    }
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

function failReviewResult(
  repo: string,
  since: string,
  startTime: number,
  error: string,
): ReviewDiffResult {
  return earlyReviewResult(repo, since, startTime, 0, "fail", error);
}

function emptyDiffResult(
  repo: string,
  since: string,
  startTime: number,
): ReviewDiffResult {
  return earlyReviewResult(repo, since, startTime, 100, "pass");
}

function earlyReviewResult(
  repo: string,
  since: string,
  startTime: number,
  score: number,
  verdict: "pass" | "warn" | "fail",
  error?: string,
): ReviewDiffResult {
  const result: ReviewDiffResult = {
    repo,
    since,
    checks: [],
    findings: [],
    score,
    verdict,
    duration_ms: Date.now() - startTime,
    diff_stats: { files_changed: 0, files_reviewed: 0 },
    metadata: {},
  };
  if (error !== undefined) result.error = error;
  return result;
}

function applyExcludePatterns(
  changedFiles: string[],
  excludePatterns: string[] | undefined,
): string[] {
  if (!excludePatterns || excludePatterns.length === 0) return changedFiles;
  const isExcluded = picomatch(excludePatterns);
  return changedFiles.filter((f) => !isExcluded(f));
}

function prepareDiffReviewState(
  changedFiles: string[],
  maxFiles: number,
  since: string,
): DiffReviewState {
  const allFindings: ReviewFinding[] = [];
  const metadata: ReviewMetadata = {};
  const totalFilesChanged = changedFiles.length;
  let filesToReview = changedFiles;

  if (filesToReview.length > maxFiles) {
    metadata.files_capped = true;
    allFindings.push({
      check: "large-diff",
      severity: "info",
      message: `Large diff: ${filesToReview.length} files changed, reviewing first ${maxFiles}. Consider smaller commits.`,
    });
    filesToReview = filesToReview.slice(0, maxFiles);
  }

  if (!HEAD_TILDE_PATTERN.test(since)) {
    metadata.index_warning =
      `Ref "${since}" is not a HEAD~N pattern. Index may not reflect this commit range.`;
  }

  return {
    changedFiles: filesToReview,
    totalFilesChanged,
    allFindings,
    metadata,
  };
}

function reviewResult(
  repo: string,
  since: string,
  startTime: number,
  reviewState: DiffReviewState,
  checkResults: CheckResult[],
): ReviewDiffResult {
  return {
    repo,
    since,
    checks: checkResults,
    findings: reviewState.allFindings,
    score: calculateScore(reviewState.allFindings, checkResults),
    verdict: determineVerdict(checkResults),
    duration_ms: Date.now() - startTime,
    diff_stats: {
      files_changed: reviewState.totalFilesChanged,
      files_reviewed: reviewState.changedFiles.length,
    },
    metadata: reviewState.metadata,
  };
}

function resolveEnabledChecks(checks: string | undefined): CheckName[] {
  const requestedChecks = checks
    ? checks.split(",").map((c) => c.trim())
    : [...ALL_CHECKS];

  return requestedChecks.filter((c): c is CheckName =>
    ALL_CHECKS.includes(c as CheckName),
  );
}

async function runEnabledChecks(
  enabledChecks: CheckName[],
  repo: string,
  changedFiles: string[],
  index: ReviewIndex,
  since: string,
  until: string,
  checkTimeoutMs: number,
): Promise<CheckResult[]> {
  const checkPromises = enabledChecks.map((checkName) =>
    withTimeout(
      runCheck(checkName, repo, changedFiles, index, since, until),
      checkTimeoutMs,
    ),
  );

  const settled = await Promise.allSettled(checkPromises);
  return settled.map((outcome, i) =>
    checkResultFromSettled(outcome, enabledChecks[i] ?? `check_${i}`, checkTimeoutMs),
  );
}

function checkResultFromSettled(
  outcome: PromiseSettledResult<CheckResult | TimeoutSentinel> | undefined,
  checkName: string,
  checkTimeoutMs: number,
): CheckResult {
  if (!outcome || outcome.status === "rejected") {
    return {
      check: checkName,
      status: "error",
      findings: [],
      duration_ms: 0,
      summary: `Error: ${outcome && outcome.status === "rejected" && outcome.reason instanceof Error ? outcome.reason.message : String(outcome?.status === "rejected" ? outcome.reason : "unknown")}`,
    };
  }

  if (isTimeoutSentinel(outcome.value)) {
    return {
      check: checkName,
      status: "timeout",
      findings: [],
      duration_ms: checkTimeoutMs,
      summary: `Timed out after ${checkTimeoutMs}ms`,
    };
  }

  return outcome.value;
}

function isTimeoutSentinel(value: CheckResult | TimeoutSentinel): value is TimeoutSentinel {
  return value.status === "timeout" && !("findings" in value);
}
