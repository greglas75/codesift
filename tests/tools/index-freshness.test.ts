import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CodeIndex } from "../../src/types.js";

// safeReadGitHead shells out to git; stub the module it reads from so each state is reachable.
vi.mock("../../src/utils/git-head.js", () => ({
  getCurrentGitCommit: vi.fn(),
}));

import { getCurrentGitCommit } from "../../src/utils/git-head.js";
import { assessIndexFreshness, isStaleIndex } from "../../src/tools/plan-turn/stale-index.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function makeIndex(updatedAt: number): CodeIndex {
  return {
    repo: "test/repo",
    root: "/tmp/repo",
    symbols: [],
    files: [],
    created_at: updatedAt,
    updated_at: updatedAt,
    symbol_count: 0,
    file_count: 0,
  };
}

const mockedHead = vi.mocked(getCurrentGitCommit);

beforeEach(() => mockedHead.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("assessIndexFreshness", () => {
  it("reports current, and says the verdict rests on a HEAD match", () => {
    mockedHead.mockReturnValue(SHA_A);
    const result = assessIndexFreshness(makeIndex(Date.now()), SHA_A);
    expect(result).toEqual({ status: "current", basis: "git_head_match" });
  });

  it("reports stale with both commits when HEAD moved", () => {
    mockedHead.mockReturnValue(SHA_B);
    const result = assessIndexFreshness(makeIndex(Date.now()), SHA_A);
    expect(result.status).toBe("stale");
    if (result.status === "stale") {
      expect(result.basis).toBe("git_head_moved");
      expect(result.indexedCommit).toBe(SHA_A);
      expect(result.headCommit).toBe(SHA_B);
    }
  });

  it("reports UNKNOWN — not current — when there is no git HEAD to compare", () => {
    // The whole point: a recent index nobody could verify must not be reported the same way as
    // one verified against HEAD. Previously both came back `false` from isStaleIndex.
    mockedHead.mockReturnValue(null);
    const result = assessIndexFreshness(makeIndex(Date.now()), SHA_A);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.basis).toBe("no_git_head");
      expect(result.likelyStale).toBe(false);
    }
  });

  it("reports UNKNOWN when git works but the index recorded no commit", () => {
    mockedHead.mockReturnValue(SHA_A);
    const result = assessIndexFreshness(makeIndex(Date.now()), undefined);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.basis).toBe("no_indexed_commit");
  });

  it("marks an unverifiable OLD index likelyStale, still without claiming to know", () => {
    mockedHead.mockReturnValue(null);
    const twoDaysAgo = Date.now() - 48 * 3600 * 1000;
    const result = assessIndexFreshness(makeIndex(twoDaysAgo), SHA_A);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.likelyStale).toBe(true);
      expect(result.ageMs).toBeGreaterThan(24 * 3600 * 1000);
    }
  });

  it("distinguishes the two states a boolean collapsed", () => {
    // Same returned boolean, genuinely different epistemic situations.
    mockedHead.mockReturnValue(SHA_A);
    const verified = assessIndexFreshness(makeIndex(Date.now()), SHA_A);
    mockedHead.mockReturnValue(null);
    const unverifiable = assessIndexFreshness(makeIndex(Date.now()), SHA_A);

    expect(isStaleIndex(makeIndex(Date.now()), SHA_A)).toBe(false); // both look the same here
    expect(verified.status).not.toBe(unverifiable.status); // but they are not the same
  });
});

describe("isStaleIndex (boolean view) keeps its original semantics", () => {
  it("false when HEAD matches", () => {
    mockedHead.mockReturnValue(SHA_A);
    expect(isStaleIndex(makeIndex(Date.now()), SHA_A)).toBe(false);
  });

  it("true when HEAD moved", () => {
    mockedHead.mockReturnValue(SHA_B);
    expect(isStaleIndex(makeIndex(Date.now()), SHA_A)).toBe(true);
  });

  it("false for a recent index with no git", () => {
    mockedHead.mockReturnValue(null);
    expect(isStaleIndex(makeIndex(Date.now()), undefined)).toBe(false);
  });

  it("true for an old index with no git", () => {
    mockedHead.mockReturnValue(null);
    expect(isStaleIndex(makeIndex(Date.now() - 48 * 3600 * 1000), undefined)).toBe(true);
  });
});
