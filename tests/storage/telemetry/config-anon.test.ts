import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, hostname, userInfo } from "node:os";
import {
  resolveTelemetryLevel,
  writeStoredTelemetryLevel,
  getConfigPath,
} from "../../../src/storage/telemetry/config.js";
import { getAnonId, _resetAnonIdCacheForTests } from "../../../src/storage/telemetry/anon-id.js";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codesift-tel-"));
  process.env["CODESIFT_DATA_DIR"] = dir;
  delete process.env["DO_NOT_TRACK"];
  delete process.env["CODESIFT_TELEMETRY"];
  _resetAnonIdCacheForTests();
});

afterEach(async () => {
  process.env = { ...savedEnv };
  _resetAnonIdCacheForTests();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("resolveTelemetryLevel precedence (spec §4)", () => {
  it("DO_NOT_TRACK wins over everything → off", () => {
    process.env["DO_NOT_TRACK"] = "1";
    process.env["CODESIFT_TELEMETRY"] = "full";
    expect(resolveTelemetryLevel()).toBe("off");
  });

  it("CODESIFT_TELEMETRY beats config.json and default", async () => {
    await writeFile(getConfigPath(), JSON.stringify({ telemetry: { level: "full" } }));
    process.env["CODESIFT_TELEMETRY"] = "off";
    expect(resolveTelemetryLevel()).toBe("off");
  });

  it("config.json honoured when no env override", async () => {
    await writeFile(getConfigPath(), JSON.stringify({ telemetry: "full" }));
    expect(resolveTelemetryLevel()).toBe("full");
  });

  it("defaults to anon (opt-out model) with nothing set", () => {
    expect(resolveTelemetryLevel()).toBe("anon");
  });

  it("writeStoredTelemetryLevel round-trips via config.json", () => {
    writeStoredTelemetryLevel("off");
    expect(resolveTelemetryLevel()).toBe("off");
    writeStoredTelemetryLevel("full");
    expect(resolveTelemetryLevel()).toBe("full");
  });
});

describe("getAnonId", () => {
  it("is a random UUID, stable across reads, and NOT derived from identity", () => {
    const a = getAnonId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    _resetAnonIdCacheForTests(); // force re-read from disk
    expect(getAnonId()).toBe(a);

    expect(a).not.toContain(hostname());
    expect(a).not.toContain(userInfo().username);
  });

  it("generates distinct ids for distinct data dirs", async () => {
    const first = getAnonId();
    const dir2 = await mkdtemp(join(tmpdir(), "codesift-tel2-"));
    process.env["CODESIFT_DATA_DIR"] = dir2;
    _resetAnonIdCacheForTests();
    expect(getAnonId()).not.toBe(first);
    await rm(dir2, { recursive: true, force: true }).catch(() => {});
  });
});
