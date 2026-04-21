import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// Mock child_process BEFORE importing the module under test.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import {
  gitLog,
  GIT_LOG_FORMAT,
  GIT_TIMEOUT_MS,
} from "../../../src/tools/journal-git-client.js";

const mockExecFileSync = execFileSync as Mock;

// Two sample commits separated by newline.
const COMMIT_A =
  "abc123\x1F2026-04-20T10:00:00Z\x1FAlice\x1Ffeat: add thing\x1Fdef456 ghi789\x1Frefs/heads/main, HEAD";
const COMMIT_B =
  "def456\x1F2026-04-19T08:30:00Z\x1FBob\x1Ffix: small patch\x1F\x1F";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── (a) arg array ────────────────────────────────────────────────────────────
describe("gitLog – args passed to execFileSync", () => {
  it("passes --pretty=format:<GIT_LOG_FORMAT> and --all", () => {
    mockExecFileSync.mockReturnValue(COMMIT_A);
    gitLog();
    const args = mockExecFileSync.mock.calls[0]![1] as string[];
    expect(args).toContain(`--pretty=format:${GIT_LOG_FORMAT}`);
    expect(args).toContain("--all");
  });

  it("appends --max-count when maxCount is provided", () => {
    mockExecFileSync.mockReturnValue(COMMIT_A);
    gitLog({ maxCount: 50 });
    const args = mockExecFileSync.mock.calls[0]![1] as string[];
    expect(args).toContain("--max-count=50");
  });

  it("appends --since when since is provided", () => {
    mockExecFileSync.mockReturnValue(COMMIT_A);
    gitLog({ since: "2026-01-01T00:00:00Z" });
    const args = mockExecFileSync.mock.calls[0]![1] as string[];
    expect(args).toContain("--since=2026-01-01T00:00:00Z");
  });
});

// ─── (b) parsed shape ─────────────────────────────────────────────────────────
describe("gitLog – parsed GitCommit shape", () => {
  it("parses a commit with parentShas and refs correctly", () => {
    mockExecFileSync.mockReturnValue(COMMIT_A);
    const result = gitLog();
    expect(result).toHaveLength(1);
    expect(result[0]).toStrictEqual({
      sha: "abc123",
      date: "2026-04-20T10:00:00Z",
      authorName: "Alice",
      subject: "feat: add thing",
      parentShas: ["def456", "ghi789"],
      refs: ["refs/heads/main", "HEAD"],
    });
  });

  it("parses two commits from multi-line output", () => {
    mockExecFileSync.mockReturnValue(`${COMMIT_A}\n${COMMIT_B}`);
    const result = gitLog();
    expect(result).toHaveLength(2);
    // COMMIT_B has empty parents and empty refs
    expect(result[1]).toStrictEqual({
      sha: "def456",
      date: "2026-04-19T08:30:00Z",
      authorName: "Bob",
      subject: "fix: small patch",
      parentShas: [],
      refs: [],
    });
  });

  it("skips lines with != 6 fields (defensive — corrupted output)", () => {
    const malformed = "onlyOneField";
    mockExecFileSync.mockReturnValue(`${COMMIT_A}\n${malformed}`);
    const result = gitLog();
    expect(result).toHaveLength(1);
  });
});

// ─── (c) empty log ────────────────────────────────────────────────────────────
describe("gitLog – empty output", () => {
  it("returns [] when git outputs an empty string", () => {
    mockExecFileSync.mockReturnValue("");
    expect(gitLog()).toEqual([]);
  });
});

// ─── (d) exit 128 ─────────────────────────────────────────────────────────────
describe("gitLog – git exit 128", () => {
  it("returns [] when execFileSync throws with status 128 (not a repo)", () => {
    const err = Object.assign(new Error("not a git repo"), { status: 128 });
    mockExecFileSync.mockImplementation(() => { throw err; });
    expect(gitLog()).toEqual([]);
  });

  it("re-throws errors with status !== 128", () => {
    const err = Object.assign(new Error("permission denied"), { status: 1 });
    mockExecFileSync.mockImplementation(() => { throw err; });
    expect(() => gitLog()).toThrow();
  });
});

// ─── (e) timeout enforced ─────────────────────────────────────────────────────
describe("gitLog – timeout option", () => {
  it("passes timeout: 10000 in the options object", () => {
    mockExecFileSync.mockReturnValue(COMMIT_A);
    gitLog();
    const opts = mockExecFileSync.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts).toMatchObject({ timeout: 10000 });
  });
});

// ─── (f) GIT_LOG_FORMAT constant ─────────────────────────────────────────────
describe("GIT_LOG_FORMAT constant", () => {
  it("equals the expected pinned format string (no email)", () => {
    expect(GIT_LOG_FORMAT).toBe("%H%x1F%aI%x1F%an%x1F%s%x1F%P%x1F%D");
  });

  it("GIT_TIMEOUT_MS equals 10000", () => {
    expect(GIT_TIMEOUT_MS).toBe(10_000);
  });
});
