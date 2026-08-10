import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

/**
 * The first-run notice is the CONSENT, and it is a closed enumeration. Nothing enforced that it
 * stayed in sync with what the payload actually carries, so the retro rollup shipped (ad605bd)
 * while the notice still described only "tool names, latencies, error/empty rates, bucketed env".
 * Its negative claims stayed true — no repo names, no paths, no code — but a user who read that
 * list did not agree to skill-level or quality-gate telemetry. Incomplete disclosure, not a false
 * one, and invisible because it lives in a string no test read.
 *
 * This asserts the pairing rather than the wording: if the aggregator can emit a dimension, the
 * notice has to name that dimension. Reword freely — the test only fails when the notice stops
 * covering something the payload can send.
 */
describe("first-run notice covers what the payload can carry", () => {
  const noticeSource = () =>
    readFileSync(
      join(__dirname, "..", "..", "src", "storage", "telemetry", "config.ts"),
      "utf-8",
    );

  it("names the retro dimensions the aggregator emits", () => {
    const src = noticeSource();
    const notice = src.slice(src.indexOf("[codesift] Anonymous usage stats"));
    // One term per DIMENSION the rollup can reveal — not one per field name.
    for (const term of ["skill", "friction", "gate", "effort"]) {
      expect(notice.toLowerCase()).toContain(term);
    }
  });

  it("still promises exactly what the aggregator omits", () => {
    const src = noticeSource();
    const notice = src.slice(src.indexOf("[codesift] Anonymous usage stats"));
    // These four are omitted from the F map, so the promise is keepable. If someone starts
    // reading them, this assertion is the thing that should be revisited FIRST.
    for (const term of ["repo names", "branches", "commit", "free text"]) {
      expect(notice.toLowerCase()).toContain(term);
    }
  });
});

/**
 * `N/A` must never read as a verdict. zuvo's append-retro had no N/A in the blind-audit enum until
 * 2026-08-06, so skills with no such step filed verdict-shaped values instead — 108 of 164 recorded
 * verdicts (66%) came from skills whose SKILL.md never mentions a blind audit. Adding N/A upstream
 * fixes the source, but gateRan() counted any unrecognised token as "ran", so the corrected value
 * would have been counted as a real verdict and the fix would have produced a WORSE metric than the
 * bug it repaired.
 */
describe("N/A is neither a verdict nor a skip", () => {
  it("does not count N/A as a gate that ran, and reports it separately", async () => {
    const lines = [
      retroLine({ blind: "N/A", adversarial: "N/A" }),
      retroLine({ blind: "clean:strict", adversarial: "3findings" }),
      retroLine({ blind: "not_run", adversarial: "skipped" }),
    ].join("\n");
    await writeFile(logPath, lines + "\n", "utf-8");

    const out = await aggregateRetros(0, logPath);
    expect(out).toHaveLength(1);
    const b = out[0]!;
    expect(b.count).toBe(3);
    // one real verdict, one N/A, one genuine skip — three distinct facts
    expect(b.blind_audit_ran).toBe(1);
    expect(b.blind_audit_na).toBe(1);
    expect(b.adversarial_ran).toBe(1);
    expect(b.adversarial_na).toBe(1);
  });

  it("keeps 'not_run' distinguishable from 'N/A'", async () => {
    await writeFile(logPath, retroLine({ blind: "not_run" }) + "\n", "utf-8");
    const out = await aggregateRetros(0, logPath);
    const b = out[0]!;
    // "has the step, did not run it" must NOT be reported as "has no step"
    expect(b.blind_audit_ran).toBe(0);
    expect(b.blind_audit_na).toBe(0);
  });

  it("carries the N/A counters all the way into the payload", async () => {
    // Counting them locally and dropping them at the sanitizer would make the correction
    // unreadable at the far end: `blind_audit_ran` falls, and nothing says whether that is skills
    // skipping their gate or skills that never had one. 108 of 164 recorded verdicts came from
    // skills with no such step, so that is most of the signal, not an edge case.
    const lines = [
      retroLine({ blind: "N/A", adversarial: "N/A" }),
      retroLine({ blind: "clean:strict", adversarial: "3findings" }),
    ].join("\n");
    await writeFile(logPath, lines + "\n", "utf-8");

    const retros = await aggregateRetros(0, logPath);
    const payload = buildLevel1Payload({ anonId: "a", env: ENV, tools: [], retros, now: 1 });

    const sent = payload.retros?.[0];
    expect(sent).toBeDefined();
    expect(sent?.blind_audit_ran).toBe(1);
    expect(sent?.blind_audit_na).toBe(1);
    expect(sent?.adversarial_ran).toBe(1);
    expect(sent?.adversarial_na).toBe(1);
    // Still an allowlisted payload, not a spread of the aggregate.
    expect(() => assertSanitized(payload)).not.toThrow();
  });
});
