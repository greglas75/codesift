import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveHostTag } from "../../src/storage/usage-tracker.js";

let dir: string;
let previousDir: string | undefined;
let previousTag: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-hostid-"));
  previousDir = process.env["CODESIFT_DATA_DIR"];
  previousTag = process.env["CODESIFT_HOST_TAG"];
  process.env["CODESIFT_DATA_DIR"] = dir;
  delete process.env["CODESIFT_HOST_TAG"];
});

afterEach(() => {
  if (previousDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = previousDir;
  if (previousTag === undefined) delete process.env["CODESIFT_HOST_TAG"];
  else process.env["CODESIFT_HOST_TAG"] = previousTag;
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveHostTag", () => {
  // One Mac produced four identities in usage.jsonl ("greg-m5", the .local
  // name, "Mac", a bare IP) because os.hostname() follows DHCP/network state,
  // splitting its own stats four ways. Freezing the id on first use stops that.
  it("seeds host-id on first use", () => {
    const first = resolveHostTag();

    const idPath = join(dir, "host-id");
    expect(existsSync(idPath)).toBe(true);
    expect(readFileSync(idPath, "utf-8").trim()).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("keeps the persisted id after the machine is renamed", () => {
    writeFileSync(join(dir, "host-id"), "frozen-machine", "utf-8");
    expect(resolveHostTag()).toBe("frozen-machine");
  });

  it("is stable across repeated resolution", () => {
    expect(resolveHostTag()).toBe(resolveHostTag());
  });

  it("an explicit CODESIFT_HOST_TAG overrides AND corrects the persisted id", () => {
    // The tag reaches some processes and not others (a GUI app launched before
    // `launchctl setenv` never sees it), so an env-less process can seed the
    // file from a volatile hostname. The first process that DOES see the tag
    // must repair it — otherwise the pin never becomes durable.
    writeFileSync(join(dir, "host-id"), "Mac", "utf-8");
    process.env["CODESIFT_HOST_TAG"] = "greg-m5";

    expect(resolveHostTag()).toBe("greg-m5");
    expect(readFileSync(join(dir, "host-id"), "utf-8").trim()).toBe("greg-m5");
  });

  it("seeds host-id from the tag when no file exists yet", () => {
    process.env["CODESIFT_HOST_TAG"] = "greg-m5";

    expect(resolveHostTag()).toBe("greg-m5");
    expect(readFileSync(join(dir, "host-id"), "utf-8").trim()).toBe("greg-m5");
  });

  it("ignores a blank CODESIFT_HOST_TAG instead of stamping an empty host", () => {
    writeFileSync(join(dir, "host-id"), "persisted-name", "utf-8");
    process.env["CODESIFT_HOST_TAG"] = "   ";

    expect(resolveHostTag()).toBe("persisted-name");
  });

  it("falls back to the live hostname when the data dir cannot be written", () => {
    process.env["CODESIFT_DATA_DIR"] = "/proc/nonexistent-codesift-dir";
    expect(resolveHostTag().length).toBeGreaterThan(0);
  });
});
