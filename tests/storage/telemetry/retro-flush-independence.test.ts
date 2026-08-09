import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanRetros } from "../../../src/storage/telemetry/retro-aggregator.js";
import { flushTelemetry } from "../../../src/storage/telemetry/uploader.js";

/**
 * Retros are an INDEPENDENT stream from CodeSift tool usage, and two bugs in `flushTelemetry`
 * meant a machine that ran zuvo reported as if zuvo were not installed at all. Measured
 * 2026-08-08 on the live collector: 28 anonymous installs, of which exactly ONE ever sent a
 * `retros` field — the machine with by far the heaviest CodeSift usage — while the team it was
 * built for runs zuvo daily.
 *
 *   Bug A — `if (entries.length === 0) return "empty"` ran BEFORE retros were read. A session
 *           that used zuvo but made no CodeSift tool call sent nothing. Not a corner case: in the
 *           same period CodeSift was unavailable / not-indexed / transport-closed in ~40% of zuvo
 *           runs, which is exactly the population of zero-tool-entry sessions.
 *
 *   Bug B — ONE watermark served both streams. It advances to the newest TOOL-CALL timestamp of
 *           each flush, then filters retros with `at < since`. Because CodeSift use normally
 *           continues after a skill finishes, the watermark routinely jumped past retros that
 *           were about to be sent — and since it only moves forward, they were never
 *           reconsidered. Silent, permanent loss.
 *
 * Both are asserted behaviourally through `flushTelemetry` against a fake collector, because both
 * were invisible to unit tests of the aggregator alone: `aggregateRetros` was always correct.
 */

let home: string;
let dataDir: string;
let zuvoDir: string;
let posted: unknown[];
let realFetch: typeof globalThis.fetch;

const TS_OLD = "2026-08-01T10:00:00Z";
const TS_MID = "2026-08-02T10:00:00Z";

function retroLine(ts: string, skill = "refactor"): string {
  return [
    `RETRO: ${ts}`, skill, "proj", "DATA_SERVICE", "unclear-instruction", "-", "none",
    "4", "20", "5", "2", "main", "abc1234", "clean:strict", "3findings", "indexed", "ok",
  ].join("\t");
}

async function writeUsage(entries: { ts: number; tool: string }[]): Promise<void> {
  const lines = entries.map((e) =>
    JSON.stringify({ ts: e.ts, tool: e.tool, ms: 5, ok: true, empty: false }));
  await writeFile(join(dataDir, "usage.jsonl"), lines.join("\n") + "\n", "utf-8");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cs-flush-"));
  dataDir = join(home, ".codesift");
  zuvoDir = join(home, ".zuvo");
  await mkdir(dataDir, { recursive: true });
  await mkdir(zuvoDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  process.env["HOME"] = home;
  process.env["CODESIFT_TELEMETRY"] = "anon";
  process.env["CODESIFT_TELEMETRY_URL"] = "https://collector.invalid";
  delete process.env["DO_NOT_TRACK"];

  posted = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: Buffer }) => {
    const { gunzipSync } = await import("node:zlib");
    posted.push(JSON.parse(gunzipSync(init.body).toString("utf-8")));
    return { ok: true } as Response;
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(home, { recursive: true, force: true });
});

describe("retros flush independently of CodeSift tool usage", () => {
  it("(A) sends retros when there is NO tool usage at all", async () => {
    // The exact shape that reported nothing: zuvo ran, CodeSift did not.
    await writeFile(join(zuvoDir, "retros.log"), retroLine(TS_OLD) + "\n", "utf-8");
    await writeUsage([]);

    const result = await flushTelemetry(Date.now());

    expect(result).toBe("sent");
    expect(posted).toHaveLength(1);
    const payload = posted[0] as { retros?: unknown[] };
    expect(payload.retros).toBeDefined();
    expect(payload.retros).toHaveLength(1);
  });

  it("(B) a retro OLDER than an ALREADY-RECORDED tool watermark is still sent", async () => {
    // Bug B in one line: the skill finished, then CodeSift kept being used. Under the shared
    // watermark the tool timestamp won and this retro was dropped forever.
    //
    // The first flush is load-bearing and was missing in the first draft of this test: with no
    // watermark file yet, `since` is 0 and the retro filter never runs, so a single-flush version
    // of this test passed against the BUGGY code and proved nothing. The bug needs an established
    // watermark to bite.
    await writeUsage([{ ts: Date.parse(TS_MID), tool: "search_text" }]);
    expect(await flushTelemetry(Date.now())).toBe("sent");
    expect(Number(readFileSync(join(dataDir, "telemetry-watermark"), "utf-8")))
      .toBe(Date.parse(TS_MID));

    // Now a retro appears whose timestamp predates that tool call.
    await writeFile(join(zuvoDir, "retros.log"), retroLine(TS_OLD) + "\n", "utf-8");
    await writeUsage([{ ts: Date.parse(TS_MID) + 60_000, tool: "search_text" }]);
    expect(await flushTelemetry(Date.now())).toBe("sent");

    const payload = posted[1] as { retros?: unknown[] };
    expect(payload.retros).toHaveLength(1);
  });

  it("(B2) the two watermarks advance separately, and the retro one is not moved by tool usage",
    async () => {
      await writeFile(join(zuvoDir, "retros.log"), retroLine(TS_OLD) + "\n", "utf-8");
      await writeUsage([{ ts: Date.parse(TS_MID), tool: "search_text" }]);
      await flushTelemetry(Date.now());

      const toolWm = Number(readFileSync(join(dataDir, "telemetry-watermark"), "utf-8"));
      const retroWm = Number(readFileSync(join(dataDir, "telemetry-watermark-retros"), "utf-8"));
      expect(toolWm).toBe(Date.parse(TS_MID));
      expect(retroWm).toBe(Date.parse(TS_OLD));
      // The whole point: they are different numbers, from different clocks.
      expect(retroWm).not.toBe(toolWm);
    });

  it("(C) an already-sent retro is not re-sent on the next flush", async () => {
    // The watermark still has to do its job — the fix must not turn into a duplicate firehose.
    await writeFile(join(zuvoDir, "retros.log"), retroLine(TS_OLD) + "\n", "utf-8");
    await writeUsage([]);
    await flushTelemetry(Date.now());
    expect(posted).toHaveLength(1);

    const second = await flushTelemetry(Date.now());
    expect(second).toBe("empty");
    expect(posted).toHaveLength(1);
  });

  it("(D) a NEW retro after a previous flush is sent", async () => {
    await writeFile(join(zuvoDir, "retros.log"), retroLine(TS_OLD) + "\n", "utf-8");
    await writeUsage([]);
    await flushTelemetry(Date.now());

    await writeFile(join(zuvoDir, "retros.log"),
      retroLine(TS_OLD) + "\n" + retroLine(TS_MID, "review") + "\n", "utf-8");
    const result = await flushTelemetry(Date.now());

    expect(result).toBe("sent");
    expect(posted).toHaveLength(2);
    const payload = posted[1] as { retros?: { skill: string }[] };
    expect(payload.retros).toHaveLength(1);
    expect(payload.retros?.[0]?.skill).toBe("review");
  });

  it("(E) no zuvo and no tool usage still means nothing is sent", async () => {
    await writeUsage([]);
    const result = await flushTelemetry(Date.now());
    expect(result).toBe("empty");
    expect(posted).toHaveLength(0);
    expect(existsSync(join(dataDir, "telemetry-watermark-retros"))).toBe(false);
  });

  it("(F) scanRetros reports the newest timestamp it saw, including filtered-out lines",
    async () => {
      const p = join(zuvoDir, "retros.log");
      await writeFile(p, retroLine(TS_OLD) + "\n" + retroLine(TS_MID) + "\n", "utf-8");
      // Everything is below the cutoff, so no rows — but the watermark must still advance past
      // them, or every future flush rescans the whole file.
      const scan = await scanRetros(Date.parse(TS_MID), p);
      expect(scan.rows).toHaveLength(0);
      expect(scan.maxTs).toBe(Date.parse(TS_MID));
    });
});
