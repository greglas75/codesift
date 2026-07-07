import picomatch from "picomatch";
import { changedSymbols } from "../diff-tools.js";
import { getCodeIndex } from "../index-tools.js";
import { validateGitRef } from "../../utils/git-validation.js";
import type { CodeIndex } from "../../types.js";
import {
  ALL_CHECKS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_MAX_FILES,
  HEAD_TILDE_PATTERN,
  type CheckName,
} from "./constants.js";
import { runCheck } from "./check-runner.js";
import { calculateScore, determineVerdict } from "./scoring.js";
import { withTimeout } from "./timeout.js";
import type { TimeoutSentinel } from "./timeout.js";
import type { CheckResult, ReviewDiffOptions, ReviewDiffResult, ReviewFinding, ReviewMetadata } from "./types.js";

interface DiffReviewState {
  changedFiles: string[];
  totalFilesChanged: number;
  allFindings: ReviewFinding[];
  metadata: ReviewMetadata;
}

interface ReadyReview {
  status: "ready";
  index: CodeIndex;
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

  const prepared = await prepareReview(
    repo,
    opts,
    since,
    until,
    maxFiles,
    startTime,
  );
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

  const index = await getCodeIndex(repo);
  if (!index) {
    return {
      status: "early",
      result: failReviewResult(repo, since, startTime, `Repository not found: ${repo}`),
    };
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
    index,
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
  index: CodeIndex,
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
