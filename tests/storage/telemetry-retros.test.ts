import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateRetros } from "../../src/storage/telemetry/retro-aggregator.js";
import { buildLevel1Payload, assertSanitized } from "../../src/storage/telemetry/sanitizer.js";
import type { EnvProfile } from "../../src/storage/telemetry/env-profile.js";

/**
 * Retros ride the ANONYMOUS codesift endpoint, so the anonymity has to be a property of the code
 * rather than a claim in a comment.
 *
 * The collector gates `/ingest/zuvo` behind a secret precisely because raw retros "carry repo names
 * and debt text" — so the moment a project name, branch, commit sha or a line of prose reaches this
 * aggregate, riding the open endpoint stops being legitimate. The first test below is the one that
 * matters: it feeds a retro whose identifying fields are distinctive strings and asserts none of
 * them survives anywhere in the output.
 */

let dir: string;
let logPath: string;

// A canonical 17-field line. The identifying fields carry unmistakable markers.
function retroLine(over: Partial<Record<string, string>> = {}): string {
  const f = [
    `RETRO: ${over["ts"] ?? "2026-08-05T23:46:44Z"}`,
    over["skill"] ?? "refactor",
    over["project"] ?? "SECRET-CUSTOMER-PROJECT",
    over["code_type"] ?? "DATA_SERVICE",
    over["friction"] ?? "framework-gotcha",
    over["missing"] ?? "a whole sentence of prose naming AcmeCorp internals",
    over["context_gap"] ?? "none",
    over["turns"] ?? "6",
    over["tool_calls"] ?? "120",
    over["files_read"] ?? "25",
    over["files_modified"] ?? "6",
    over["branch"] ?? "feature/SECRET-TICKET-1234",
    over["sha"] ?? "deadbeef",
    over["blind"] ?? "clean:strict",
    over["adversarial"] ?? "13findings",
    over["codesift"] ?? "indexed",
    over["routing"] ?? "ok",
  ];
  return f.join("\t");
}

const ENV: EnvProfile = {
  platform: "darwin",
  arch: "arm64",
  ram_bucket: ">=64gb",
  cores: 18,
  node_ver: "24",
  codesift_ver: "0.13.1",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-retro-tel-"));
  logPath = join(dir, "retros.log");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("retro aggregate carries nothing that identifies the work", () => {
  it("drops project, branch, commit sha and the free-text note", async () => {
    await writeFile(logPath, retroLine() + "\n", "utf-8");
    const out = await aggregateRetros(0, logPath);
    expect(out).toHaveLength(1);

    const serialised = JSON.stringify(out);
    for (const secret of [
      "SECRET-CUSTOMER-PROJECT",
      "feature/SECRET-TICKET-1234",
      "deadbeef",
      "AcmeCorp",
      "prose",
    ]) {
      expect(serialised).not.toContain(secret);
    }
    // And the useful part survived.
    expect(out[0]).toMatchObject({
      day: "2026-08-05",
      skill: "refactor",
      code_type: "DATA_SERVICE",
      friction: "framework-gotcha",
      codesift: "indexed",
      count: 1,
    });
  });

  it("collapses a value that is not enum-shaped, instead of forwarding it", async () => {
    // Defence against format drift and hand-edited lines: `append-retro` validates these columns,
    // but retros.log is a plain text file that anything can append to.
    await writeFile(
      logPath,
      retroLine({ friction: "the build broke on /Users/someone/DEV/AcmeCorp/secret.ts" }) + "\n",
      "utf-8",
    );
    const out = await aggregateRetros(0, logPath);
    expect(out[0]?.friction).toBe("other");
    expect(JSON.stringify(out)).not.toContain("AcmeCorp");
  });

  it("keeps the clock out of the day field", async () => {
    // Time-of-day plus an event count correlates an install against a public commit history.
    const out = await aggregateRetros(0, logPath.replace("retros.log", "x.log")).catch(() => []);
    expect(out).toEqual([]);

    await writeFile(logPath, retroLine({ ts: "2026-08-05T23:46:44Z" }) + "\n", "utf-8");
    const got = await aggregateRetros(0, logPath);
    expect(got[0]?.day).toBe("2026-08-05");
    expect(JSON.stringify(got)).not.toContain("23:46");
  });
});

describe("retro aggregate is an aggregate", () => {
  it("reports medians rather than sums, so total workload does not leak", async () => {
    const lines = [
      retroLine({ turns: "2", tool_calls: "10" }),
      retroLine({ turns: "6", tool_calls: "20" }),
      retroLine({ turns: "100", tool_calls: "3000" }),
    ].join("\n");
    await writeFile(logPath, lines + "\n", "utf-8");

    const out = await aggregateRetros(0, logPath);
    expect(out).toHaveLength(1); // same dimensions -> one bucket
    expect(out[0]?.count).toBe(3);
    expect(out[0]?.median_turns).toBe(6);
    expect(out[0]?.median_tool_calls).toBe(20); // a sum would be 3030
  });

  it("counts gates that produced a verdict separately from skipped ones", async () => {
    const lines = [
      retroLine({ blind: "clean:strict", adversarial: "13findings" }),
      retroLine({ blind: "skipped", adversarial: "not_run" }),
      retroLine({ blind: "blocked_infra", adversarial: "skipped" }),
    ].join("\n");
    await writeFile(logPath, lines + "\n", "utf-8");

    const out = await aggregateRetros(0, logPath);
    expect(out[0]?.count).toBe(3);
    expect(out[0]?.blind_audit_ran).toBe(1);
    expect(out[0]?.adversarial_ran).toBe(1);
  });

  it("skips a line whose column count has drifted, rather than reading by position", async () => {
    // Reading position 13 of a 9-field line would report whatever sits there as an audit verdict.
    await writeFile(logPath, "RETRO: 2026-08-05T10:00:00Z\trefactor\tproj\tshort\n", "utf-8");
    expect(await aggregateRetros(0, logPath)).toEqual([]);
  });

  it("returns nothing when zuvo is not installed", async () => {
    expect(await aggregateRetros(0, join(dir, "does-not-exist.log"))).toEqual([]);
  });
});

describe("the payload builder treats retros as allowlisted, not spread", () => {
  it("passes the sanitizer guard with retros attached", async () => {
    await writeFile(logPath, retroLine() + "\n", "utf-8");
    const retros = await aggregateRetros(0, logPath);

    const payload = buildLevel1Payload({ anonId: "a", env: ENV, tools: [], retros, now: 1 });
    expect(() => assertSanitized(payload)).not.toThrow();
    expect(payload.retros).toHaveLength(1);
  });

  it("omits the key entirely when there are no retros", () => {
    // An absent key says "no zuvo here"; an empty array says "zuvo ran and produced nothing".
    // A reader cannot tell those apart after the fact, so they must not share a representation.
    const payload = buildLevel1Payload({ anonId: "a", env: ENV, tools: [], retros: [], now: 1 });
    expect("retros" in payload).toBe(false);
  });
});
