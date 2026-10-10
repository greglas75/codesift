// Bug it catches: a provider that stops answering stays invisible — embedding is fire-and-forget,
// and /health said "ok" through nine days of failed runs on the Mac.
import { beforeEach, describe, expect, it } from "vitest";
import {
  embeddingHealthAlert,
  embeddingHealthSnapshot,
  recordEmbeddingRun,
  resetEmbeddingHealthForTesting,
} from "../../src/storage/embedding-health.js";

beforeEach(() => resetEmbeddingHealthForTesting());

describe("embedding health", () => {
  it("counts consecutive failures and resets them on a success", () => {
    recordEmbeddingRun("local/a", false, "fetch failed");
    recordEmbeddingRun("local/a", false, "fetch failed");
    recordEmbeddingRun("local/b", true);
    recordEmbeddingRun("local/a", false, "ECONNREFUSED\n    at Socket.connect");

    expect(embeddingHealthSnapshot()).toMatchObject({
      runs: 4,
      failures: 3,
      failures_since_success: 1,
      last_success_repo: "local/b",
      last_failure_repo: "local/a",
      last_error: "ECONNREFUSED at Socket.connect",
      failing_repos: { "local/a": { consecutive: 3 } },
    });
  });

  // Bug it catches: a failure reported without a message erased the repo's last known reason.
  it("keeps a repo's last error across a failure that carries none", () => {
    recordEmbeddingRun("local/a", false, "ECONNREFUSED");
    recordEmbeddingRun("local/a", false);
    expect(embeddingHealthSnapshot().failing_repos["local/a"]).toEqual({ consecutive: 2, last_error: "ECONNREFUSED" });
  });

  type Run = [repo: string, ok: boolean];
  it.each<[string, Run[], string | null]>([
    ["no runs", [], null],
    ["two failures", [["local/a", false], ["local/a", false]], null],
    ["three failures in a row", [["local/a", false], ["local/b", false], ["local/a", false]], "3 consecutive failed runs (last: down)"],
    // A success elsewhere resets the global streak; the repo that keeps failing must still show.
    [
      "one repo failing while another succeeds",
      [["local/a", false], ["local/b", true], ["local/a", false], ["local/b", true], ["local/a", false]],
      "failing repeatedly: local/a ×3",
    ],
    ["a repo that recovered", [["local/a", false], ["local/a", false], ["local/a", true], ["local/a", false]], null],
  ])("alerts only on an outage: %s", (_case, runs, expected) => {
    for (const [repo, ok] of runs) recordEmbeddingRun(repo, ok, ok ? undefined : "down");
    expect(embeddingHealthAlert(embeddingHealthSnapshot())).toBe(expected);
  });
});
