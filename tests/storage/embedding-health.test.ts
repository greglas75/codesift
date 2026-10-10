// Bug it catches: a provider that stops answering stays invisible — embedding is fire-and-forget,
// and /health said "ok" through nine days of failed runs on the Mac.
import { beforeEach, describe, expect, it } from "vitest";
import {
  embeddingHealthReason,
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
    recordEmbeddingRun("local/a", false, "ECONNREFUSED");

    const h = embeddingHealthSnapshot();
    expect(h).toMatchObject({
      runs: 4,
      failures: 3,
      failures_since_success: 1,
      last_success_repo: "local/b",
      last_failure_repo: "local/a",
      last_error: "ECONNREFUSED",
    });
  });

  it.each([
    ["no runs", [] as boolean[], null],
    ["two failures", [false, false], null],
    ["three failures in a row", [false, false, false], "embeddings: 3 consecutive failed runs (last: down)"],
    ["three failures broken by a success", [false, false, true, false], null],
  ])("names a reason only for an outage: %s", (_case, outcomes, expected) => {
    for (const ok of outcomes) recordEmbeddingRun("local/a", ok, ok ? undefined : "down");
    expect(embeddingHealthReason(embeddingHealthSnapshot())).toBe(expected);
  });
});
