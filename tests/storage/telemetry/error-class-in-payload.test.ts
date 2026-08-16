// `error_rate` says a tool failed and nothing else, which is not actionable from another machine:
// an external Windows install sat at 8/8 failures on `scratchpad_list` for five days and the cause
// could only be GUESSED by reading the source, because the log discards the message.
//
// The payload now carries the coarse CLASS. That is a widening of what leaves a user's machine, so
// what these tests pin is the boundary, not the feature: a closed enumeration, never the message,
// and absent rather than empty when nothing failed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateToolMetrics } from "../../../src/storage/telemetry/aggregator.js";
import { buildLevel1Payload } from "../../../src/storage/telemetry/sanitizer.js";
import type { UsageEntry } from "../../../src/storage/usage-tracker.js";

const SRC = fileURLToPath(new URL("../../../src", import.meta.url));

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    ts: Date.parse("2026-08-16T10:00:00Z"),
    tool: "scratchpad_list",
    repo: "local/secret-project",
    args_summary: {},
    elapsed_ms: 5,
    result_tokens: 10,
    result_chunks: 1,
    session_id: "s1",
    ...over,
  } as UsageEntry;
}

const rowFor = (entries: UsageEntry[], tool = "scratchpad_list") =>
  aggregateToolMetrics(entries).find((r) => r.tool === tool);

describe("error classes in the payload", () => {
  it("reports counts per class, which is the thing error_rate could not say", () => {
    const row = rowFor([
      entry({ error: true, error_class: "plan_not_found" }),
      entry({ error: true, error_class: "plan_not_found" }),
      entry({ error: true, error_class: "timeout" }),
    ]);
    expect(row?.error_classes).toEqual({ plan_not_found: 2, timeout: 1 });
    expect(row?.error_rate).toBe(1);
  });

  it("is ABSENT, not empty, when nothing failed", () => {
    // Absent means "nothing failed". `{}` would mean "things failed and we could not say what".
    // Those are different claims and a reader must be able to tell them apart.
    const row = rowFor([entry(), entry()]);
    expect(row).toBeDefined();
    expect("error_classes" in (row as object)).toBe(false);
  });

  it("collapses anything outside the closed set to `other`", () => {
    // usage.jsonl is a plain file anything can append to, and another version may write a class
    // this build does not know. Passing an unrecognised value through verbatim is how a fixed
    // enumeration quietly becomes free text.
    const row = rowFor([
      entry({ error: true, error_class: "totally-made-up" as never }),
      entry({ error: true, error_class: undefined }),
      entry({ error: true, error_class: "/Users/someone/private/thing.ts" as never }),
    ]);
    expect(row?.error_classes).toEqual({ other: 3 });
  });

  it("cannot carry a path, a repo name or a message", () => {
    const row = rowFor([
      entry({ error: true, error_class: "file_missing", repo: "local/private-client-work" }),
    ]);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("private-client-work");
    expect(serialised).not.toMatch(/\/Users\/|ENOENT|no such file/);
    expect(row?.error_classes).toEqual({ file_missing: 1 });
  });

  it("keeps every emitted class inside the enumeration the notice describes", () => {
    const row = rowFor([
      entry({ error: true, error_class: "repo_not_indexed" }),
      entry({ error: true, error_class: "git_failed" }),
    ]);
    const allowed = new Set([
      "repo_not_indexed", "path_outside_repos", "file_missing", "parse_failed",
      "symbol_not_found", "ambiguous_symbol_id", "git_failed", "plan_not_found",
      "timeout", "invalid_args", "other",
    ]);
    for (const key of Object.keys(row?.error_classes ?? {})) {
      expect(allowed.has(key), `unexpected class "${key}" would ship undisclosed`).toBe(true);
    }
  });

  it("is named in the first-run notice, because that notice IS the consent", () => {
    // The pairing that makes the widening legitimate: a user who read the old notice agreed to
    // "error/empty rates", not to a per-failure breakdown. If the payload can emit it, the notice
    // has to say so — and it has to say that the message itself is not included.
    const notice = readFileSync(join(SRC, "storage/telemetry/config.ts"), "utf-8");
    const text = notice.slice(notice.indexOf("[codesift] Anonymous usage stats"));
    expect(text.toLowerCase()).toContain("failure category");
    expect(text.toLowerCase()).toContain("never the error message");
  });
});

// The sanitizer is a SECOND, deliberate allowlist that re-picks every field by name. Patching only
// the aggregator left the payload UNCHANGED — caught by running `codesift telemetry show`, not by a
// unit test. That layer needs its own guard, or the next person "simplifies" it into a spread and
// removes the boundary without noticing.
describe("the sanitizer re-picks classes rather than passing them through", () => {
  const env = {
    platform: "darwin", arch: "arm64", ram_bucket: ">=64gb", cores: 18,
    node_ver: "24", codesift_ver: "0.15.2",
  } as never;

  const payloadFor = (error_classes: unknown) =>
    buildLevel1Payload({
      anonId: "anon", env, now: 1, tools: [{
        tool: "scratchpad_list", day: "2026-08-16", count: 2, p50_ms: 3, p95_ms: 4, max_ms: 4,
        error_rate: 1, empty_result_rate: 1, cache_hit_rate: 0, error_classes,
      } as never],
    }).tools[0] as { error_classes?: Record<string, number> };

  it("emits the classes it recognises", () => {
    expect(payloadFor({ plan_not_found: 2 }).error_classes).toEqual({ plan_not_found: 2 });
  });

  it("drops a class the aggregate invented, instead of forwarding it", () => {
    // The aggregate is in-process, but this boundary is the last one before the wire. If a future
    // code path builds an aggregate by hand, an unknown key must not become a new dimension the
    // first-run notice never described.
    const out = payloadFor({ plan_not_found: 1, "/Users/me/secret.ts": 3, weird_new_thing: 2 });
    expect(out.error_classes).toEqual({ plan_not_found: 1 });
  });

  it("drops counts that are not positive integers", () => {
    const out = payloadFor({ timeout: 0, git_failed: -2, parse_failed: 1.5, file_missing: 4 });
    expect(out.error_classes).toEqual({ file_missing: 4 });
  });

  it("omits the key entirely when nothing survives, rather than sending an empty object", () => {
    expect("error_classes" in payloadFor({ nonsense: 9 })).toBe(false);
    expect("error_classes" in payloadFor(undefined)).toBe(false);
  });
});
