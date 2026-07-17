import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getUsageStats } from "../../src/storage/usage-stats.js";
import { getLocalHostTag } from "../../src/storage/usage-tracker.js";

function entry(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    ts: 1781300000000,
    tool: "search_text",
    repo: "local/demo",
    args_summary: {},
    elapsed_ms: 10,
    result_tokens: 100,
    result_chunks: 1,
    session_id: "s-local",
    ...overrides,
  }) + "\n";
}

describe("usage stats multi-host merge (usage-remote/)", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "usage-multihost-"));
    vi.stubEnv("CODESIFT_DATA_DIR", dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("merges local + remote logs and aggregates per host", async () => {
    await writeFile(join(dataDir, "usage.jsonl"), entry({ host: "macbook" }) + entry({ host: "macbook", result_tokens: 50 }));
    await mkdir(join(dataDir, "usage-remote"));
    await writeFile(join(dataDir, "usage-remote", "vps.jsonl"), entry({ host: "vps", session_id: "s-vps" }));

    const stats = await getUsageStats();
    expect(stats.total_calls).toBe(3);
    expect(stats.hosts).toEqual([
      { host: "macbook", call_count: 2, total_tokens: 150 },
      { host: "vps", call_count: 1, total_tokens: 100 },
    ]);
  });

  it("falls back to the remote filename stem for pre-multi-host entries without a host field", async () => {
    await mkdir(join(dataDir, "usage-remote"));
    await writeFile(join(dataDir, "usage-remote", "vps-prod.jsonl"), entry({ session_id: "s-vps" }));

    const stats = await getUsageStats();
    expect(stats.hosts).toEqual([{ host: "vps-prod", call_count: 1, total_tokens: 100 }]);
  });

  it("tags host-less local entries with the local host tag", async () => {
    await writeFile(join(dataDir, "usage.jsonl"), entry({}));

    const stats = await getUsageStats();
    expect(stats.hosts).toEqual([
      { host: getLocalHostTag(), call_count: 1, total_tokens: 100 },
    ]);
  });

  it("host filter narrows to one machine", async () => {
    await writeFile(join(dataDir, "usage.jsonl"), entry({ host: "macbook" }));
    await mkdir(join(dataDir, "usage-remote"));
    await writeFile(join(dataDir, "usage-remote", "vps.jsonl"), entry({ host: "vps", session_id: "s-vps", tool: "get_symbol" }));

    const stats = await getUsageStats({ host: "vps" });
    expect(stats.total_calls).toBe(1);
    expect(stats.tools[0]?.tool).toBe("get_symbol");
  });

  it("works with no usage-remote directory (single-machine setup)", async () => {
    await writeFile(join(dataDir, "usage.jsonl"), entry({ host: "macbook" }));

    const stats = await getUsageStats();
    expect(stats.total_calls).toBe(1);
  });

  it("ignores non-jsonl files in usage-remote", async () => {
    await writeFile(join(dataDir, "usage.jsonl"), entry({ host: "macbook" }));
    await mkdir(join(dataDir, "usage-remote"));
    await writeFile(join(dataDir, "usage-remote", "README.md"), "not a log\n");

    const stats = await getUsageStats();
    expect(stats.total_calls).toBe(1);
  });
});
