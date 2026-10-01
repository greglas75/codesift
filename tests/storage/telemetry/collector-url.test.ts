/**
 * Where the collector URL comes from.
 *
 * It used to be env-only, and that is how this fleet's telemetry split in half: the collector
 * moved host on 2026-09-07, an env var could not be made to reach every launch path, so every
 * install kept posting to the baked default while the reader looked at the new host. Measured
 * 2026-10-01 — the reader's namespace held nothing newer than `2026-08-31.jsonl` and its puller
 * re-reported the same 181 rollups for a month, with nothing failing anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readStoredTelemetryUrl, getConfigPath } from "../../../src/storage/telemetry/config.js";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-tel-url-"));
  process.env["CODESIFT_DATA_DIR"] = dir;
  // This environment really does set these (the farm image and this shell both opt out), and
  // either one makes the level resolver answer "off" regardless of the config file — the first
  // version of the level assertion below failed on exactly that, not on the product.
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CODESIFT_TELEMETRY"];
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(cfg: unknown): Promise<void> {
  await writeFile(getConfigPath(), JSON.stringify(cfg), "utf-8");
}

describe("readStoredTelemetryUrl", () => {
  it("reads the flat key", async () => {
    await writeConfig({ telemetry_url: "http://100.88.49.119:5599" });
    expect(readStoredTelemetryUrl()).toBe("http://100.88.49.119:5599");
  });

  it("reads the nested form, so one block can carry level and url", async () => {
    await writeConfig({ telemetry: { level: "anon", url: "https://collector.example:5599" } });
    expect(readStoredTelemetryUrl()).toBe("https://collector.example:5599");
  });

  it("strips a trailing slash — the caller appends /ingest/<ns>", async () => {
    await writeConfig({ telemetry_url: "http://h:5599/" });
    expect(readStoredTelemetryUrl()).toBe("http://h:5599");
  });

  it("returns null with no config, so the baked default still applies", () => {
    expect(readStoredTelemetryUrl()).toBeNull();
  });

  it("refuses a value that is not http(s) rather than handing it to fetch", async () => {
    // A fire-and-forget uploader must not throw on a typo in a hand-edited config file.
    for (const bad of ["", "   ", "ftp://h:5599", "100.88.49.119:5599", "not a url"]) {
      await writeConfig({ telemetry_url: bad });
      expect(readStoredTelemetryUrl()).toBeNull();
    }
  });

  it("survives a malformed config.json", async () => {
    await writeFile(getConfigPath(), "{ this is not json", "utf-8");
    expect(readStoredTelemetryUrl()).toBeNull();
  });

  it("keeps the level working when only the url is set", async () => {
    await writeConfig({ telemetry_url: "http://h:5599" });
    // The level resolver reads the same file; a url-only config must not read as level "off".
    const { resolveTelemetryLevel } = await import("../../../src/storage/telemetry/config.js");
    expect(resolveTelemetryLevel()).toBe("anon");
  });
});
