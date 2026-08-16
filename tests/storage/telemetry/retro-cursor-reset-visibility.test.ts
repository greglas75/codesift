import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flushTelemetry } from "../../../src/storage/telemetry/uploader.js";

/**
 * A retro cursor reset must be VISIBLE.
 *
 * `flushTelemetry` already handles retros.log being rewritten underneath it: the byte offset is
 * validated against a stored identity, and a mismatch rescans the whole file from 0. That logic is
 * correct and is not what this file tests. What it tests is that the event leaves a trace.
 *
 * Until this change, `retroCursorReset` only selected between two write functions — it was never
 * logged and never reported. On 2026-08-15 a machine's ~/.zuvo/retros.log went 143486 -> 70167
 * bytes and lost ten days of history; the uploader did exactly the right thing with what remained
 * and said nothing, so the loss went unnoticed for four days and was found only by chance while
 * looking at collector volume. Detection without a signal is not detection.
 *
 * The two cases must not read the same. Any rewrite (rotation, restore) is worth one line. A file
 * now SHORTER than the offset already consumed is positive evidence that local history is gone and
 * that the collector holds the only remaining copy — that one has to say so.
 */

let home: string;
let dataDir: string;
let zuvoDir: string;
let realFetch: typeof globalThis.fetch;
const ENV_KEYS = [
  "CODESIFT_DATA_DIR",
  "HOME",
  "CODESIFT_TELEMETRY",
  "CODESIFT_TELEMETRY_URL",
  "DO_NOT_TRACK",
] as const;
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function retroLine(ts: string, skill = "refactor"): string {
  return [
    `RETRO: ${ts}`, skill, "proj", "DATA_SERVICE", "unclear-instruction", "-", "none",
    "4", "20", "5", "2", "main", "abc1234", "clean:strict", "3findings", "indexed", "ok",
  ].join("\t");
}

beforeEach(async () => {
  previousEnv = Object.fromEntries(
    ENV_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  home = await mkdtemp(join(tmpdir(), "cs-cursor-"));
  dataDir = join(home, ".codesift");
  zuvoDir = join(home, ".zuvo");
  await mkdir(dataDir, { recursive: true });
  await mkdir(zuvoDir, { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  process.env["HOME"] = home;
  process.env["CODESIFT_TELEMETRY"] = "anon";
  process.env["CODESIFT_TELEMETRY_URL"] = "https://collector.invalid";
  delete process.env["DO_NOT_TRACK"];

  await writeFile(join(dataDir, "usage.jsonl"), "", "utf-8");
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true } as Response)) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const previous = previousEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  await rm(home, { recursive: true, force: true });
});

/** Ten rows, then a flush, so a cursor and its identity exist to be invalidated. */
async function seedAndFlush(): Promise<void> {
  const rows = Array.from({ length: 10 }, (_v, i) =>
    retroLine(`2026-08-0${(i % 9) + 1}T10:00:00Z`)).join("\n") + "\n";
  await writeFile(join(zuvoDir, "retros.log"), rows, "utf-8");
  await flushTelemetry(Date.now());
}

describe("retro cursor reset is reported", () => {
  it("says nothing on a normal append-only flush", async () => {
    await seedAndFlush();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(join(zuvoDir, "retros.log"),
        Array.from({ length: 10 }, (_v, i) => retroLine(`2026-08-0${(i % 9) + 1}T10:00:00Z`)).join("\n")
        + "\n" + retroLine("2026-08-09T11:00:00Z") + "\n", "utf-8");
      await flushTelemetry(Date.now());
      const said = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).not.toMatch(/cursor reset|SHRANK/);
    } finally { spy.mockRestore(); }
  });

  it("reports a SHRANK log when the file is now shorter than what was already consumed", async () => {
    await seedAndFlush();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The 2026-08-15 shape: the file is replaced by a much smaller one.
      await writeFile(join(zuvoDir, "retros.log"), retroLine("2026-08-09T12:00:00Z") + "\n", "utf-8");
      await flushTelemetry(Date.now());
      const said = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toMatch(/retros\.log SHRANK/);
      // It must name the loss, not merely the mechanics — this line is what an operator reads.
      expect(said).toMatch(/history was lost/);
      expect(said).toMatch(/only on the collector/);
    } finally { spy.mockRestore(); }
  });

  it("reports a plain reset — not a shrink — when the log is rewritten at the same or greater size", async () => {
    await seedAndFlush();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Same row count, different content: identity breaks, but nothing was lost.
      await writeFile(join(zuvoDir, "retros.log"),
        Array.from({ length: 14 }, (_v, i) =>
          retroLine(`2026-08-0${(i % 9) + 1}T13:00:00Z`, "review")).join("\n") + "\n", "utf-8");
      await flushTelemetry(Date.now());
      const said = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toMatch(/retro cursor reset/);
      expect(said).not.toMatch(/SHRANK/);
    } finally { spy.mockRestore(); }
  });
});
