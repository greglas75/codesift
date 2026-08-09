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
    // The unwritable dir is a REGULAR FILE with a path hung off it, so mkdir fails
    // with ENOTDIR instantly on every platform.
    //
    // This used to be "/proc/nonexistent-codesift-dir", which is only unwritable
    // on Linux — and there `mkdirSync(..., {recursive: true})` does not fail, it
    // SPINS: measured on the test farm (Node v22.23.1, Linux) it burned 100% of a
    // core indefinitely, while the non-recursive form throws ENOENT in 0 ms. macOS
    // has no /proc at all, so the fixture passed locally and wedged the entire
    // suite on the farm — 389 of 390 files finished and the run never ended.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x", "utf-8");
    process.env["CODESIFT_DATA_DIR"] = join(blocker, "data");

    expect(resolveHostTag().length).toBeGreaterThan(0);
  });
});
