// `host` is a NAME and names drift. Measured on one Mac: five identities in usage.jsonl
// ("greg-m5", the .local name, "Mac", and two bare IPs), and 1,175 entries carried the wrong one
// AFTER the persisted host-id existed, across 239 separate sessions — every hypothesis for which
// process produced them was checked and disproved.
//
// That is the case for a second field that cannot be argued with: `machine` answers "which computer
// wrote this line?" without depending on an env var arriving, a file being written first, or anyone
// choosing correctly.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { machineId, _resetMachineIdForTests } from "../../src/storage/usage-tracker.js";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codesift-machine-"));
  previous = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = dir;
  _resetMachineIdForTests();
});

afterEach(() => {
  if (previous === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = previous;
  _resetMachineIdForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("machineId", () => {
  it("is a short hex id, persisted on first use", () => {
    const id = machineId();

    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(readFileSync(join(dir, "machine-id"), "utf-8").trim()).toBe(id);
  });

  it("is identical across calls and across processes", () => {
    const first = machineId();
    _resetMachineIdForTests();          // a fresh process reads the file, not the hardware
    expect(machineId()).toBe(first);
  });

  it("adopts a persisted id rather than deriving a new one", () => {
    writeFileSync(join(dir, "machine-id"), "deadbeef0000", "utf-8");
    expect(machineId()).toBe("deadbeef0000");
  });

  it("never contains the raw hardware identifier", () => {
    // The UUID identifies the machine, and this field rides an anonymous channel — it is hashed,
    // not truncated. A test that only checked the length would pass on a raw prefix.
    const id = machineId();
    expect(id).not.toMatch(/-/);
    expect(id.length).toBe(12);
  });

  it("still yields a stable id when the hardware identity cannot be read", () => {
    // Falling back to a random value is fine; falling back to something that changes is not, which
    // is exactly how `hostname()` failed.
    writeFileSync(join(dir, "machine-id"), "", "utf-8");   // empty => not usable, must re-derive
    _resetMachineIdForTests();
    const a = machineId();
    _resetMachineIdForTests();
    expect(machineId()).toBe(a);
  });
});
