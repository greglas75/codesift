import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_ABI,
  NativeCoreUnavailableError,
  getNativeCore,
  loadFromCandidates,
  nativeMode,
  nativeStatus,
  platformTag,
  resetNativeForTesting,
  type NativeCandidate,
} from "../../src/native/index.js";
import { platformTag as buildScriptPlatformTag } from "../../scripts/build-native.mjs";

function fakeCore(abi: number, version = "9.9.9") {
  return { version: () => version, abiVersion: () => abi };
}

function notFound(): never {
  const err = new Error("Cannot find module") as NodeJS.ErrnoException;
  err.code = "MODULE_NOT_FOUND";
  throw err;
}

describe("nativeMode", () => {
  it("defaults to auto", () => {
    expect(nativeMode(undefined, {})).toBe("auto");
  });

  it("maps 0/1 and their spellings", () => {
    for (const v of ["0", "false", "off", "OFF"]) expect(nativeMode(undefined, { CODESIFT_NATIVE: v })).toBe("off");
    for (const v of ["1", "true", "on"]) expect(nativeMode(undefined, { CODESIFT_NATIVE: v })).toBe("required");
  });

  it("lets a component switch override the global one in both directions", () => {
    const env = { CODESIFT_NATIVE: "0", CODESIFT_NATIVE_STORE: "1" };
    expect(nativeMode("store", env)).toBe("required");
    expect(nativeMode("bm25", env)).toBe("off");
    expect(nativeMode("store", { CODESIFT_NATIVE: "1", CODESIFT_NATIVE_STORE: "0" })).toBe("off");
  });

  // Bug it catches: the store left opt-in after stage 5, or `CODESIFT_NATIVE_STORE=0` no longer
  // turning it off — the one switch back to node:sqlite for a whole process.
  it("treats the store like every other component, with its own switch winning", () => {
    expect(nativeMode("store", {})).toBe("auto");
    expect(nativeMode("store", { CODESIFT_NATIVE_STORE: "1" })).toBe("required");
    expect(nativeMode("store", { CODESIFT_NATIVE: "1" })).toBe("required");
    expect(nativeMode("store", { CODESIFT_NATIVE: "1", CODESIFT_NATIVE_STORE: "0" })).toBe("off");
    expect(nativeMode("store", { CODESIFT_NATIVE: "0" })).toBe("off");
  });

  it("treats a typo as auto, never as required", () => {
    expect(nativeMode(undefined, { CODESIFT_NATIVE: "yes please" })).toBe("auto");
  });
});

describe("platformTag", () => {
  const cases: Array<[NodeJS.Platform, string, boolean, string | null]> = [
    ["darwin", "arm64", false, "darwin-arm64"],
    ["darwin", "x64", false, "darwin-x64"],
    ["linux", "x64", false, "linux-x64-gnu"],
    ["linux", "x64", true, "linux-x64-musl"],
    ["linux", "arm64", false, "linux-arm64-gnu"],
    ["win32", "x64", false, "win32-x64-msvc"],
    ["linux", "ia32", false, null],
    ["freebsd", "x64", false, null],
  ];

  it.each(cases)("%s/%s musl=%s -> %s", (platform, arch, musl, want) => {
    expect(platformTag(platform, arch, () => musl)).toBe(want);
  });

  it("agrees with the build script's copy, which names the file the loader looks for", () => {
    for (const [platform, arch, musl] of cases) {
      expect(buildScriptPlatformTag(platform, arch, () => musl)).toBe(platformTag(platform, arch, () => musl));
    }
  });
});

describe("loadFromCandidates", () => {
  it("takes the first candidate that loads with our ABI", () => {
    const candidates: NativeCandidate[] = [
      { source: "missing", load: notFound },
      { source: "absent-file", load: () => undefined },
      { source: "good", load: () => fakeCore(NATIVE_ABI) },
      { source: "later", load: () => fakeCore(NATIVE_ABI, "0.0.0") },
    ];
    const r = loadFromCandidates(candidates);
    expect(r.core?.version()).toBe("9.9.9");
    expect("source" in r && r.source).toBe("good");
  });

  it("refuses a stale binary by ABI and says how to fix it", () => {
    const r = loadFromCandidates([{ source: "native/old.node", load: () => fakeCore(NATIVE_ABI + 1) }]);
    expect(r.core).toBeNull();
    expect("reason" in r && r.reason).toMatch(/native\/old\.node: ABI \d+, this build needs \d+ .*build:native/);
  });

  it("names a binary that exists but fails to load, and stays quiet about absent ones", () => {
    const r = loadFromCandidates([
      { source: "pkg", load: notFound },
      {
        source: "native/broken.node",
        load: () => {
          throw new Error("dlopen failed: wrong architecture\nstack...");
        },
      },
    ]);
    expect("reason" in r && r.reason).toBe("native/broken.node: dlopen failed: wrong architecture");
  });

  it("rejects a module that is not the core", () => {
    const r = loadFromCandidates([{ source: "x", load: () => ({ version: "1" }) }]);
    expect("reason" in r && r.reason).toBe("x: not a codesift core module");
  });

  it("reports plain absence when nothing is there", () => {
    const r = loadFromCandidates([{ source: "pkg", load: notFound }]);
    expect("reason" in r && r.reason).toBe("no binary for this platform");
  });
});

describe("getNativeCore / nativeStatus (this process)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetNativeForTesting();
  });

  it("returns null and loads nothing when switched off", () => {
    process.env["CODESIFT_NATIVE"] = "0";
    resetNativeForTesting();
    expect(getNativeCore()).toBeNull();
    expect(nativeStatus()).toEqual({ mode: "off", loaded: false });
  });

  // Which branch runs depends on whether `npm run build:native` has produced a binary here —
  // both are asserted, so the test is meaningful on a machine with Rust and on one without.
  it("in auto mode either loads a core with our ABI or explains why not, without throwing", () => {
    delete process.env["CODESIFT_NATIVE"];
    resetNativeForTesting();
    const core = getNativeCore();
    const status = nativeStatus();
    if (core) {
      expect(core.abiVersion()).toBe(NATIVE_ABI);
      expect(status).toMatchObject({ mode: "auto", loaded: true, version: core.version() });
    } else {
      expect(status.loaded).toBe(false);
      expect(status.reason).toBeTruthy();
    }
  });

  // The CI `native` job and the parity suites run with CODESIFT_NATIVE=1 after building the addon.
  // There, "not loaded" is the failure — the branchy cases above would accept it.
  it.runIf(saved["CODESIFT_NATIVE"] === "1")("loads the built addon when the run requires it", () => {
    resetNativeForTesting();
    const status = nativeStatus();
    expect(status.reason).toBeUndefined();
    expect(status).toMatchObject({ mode: "required", loaded: true });
    expect(getNativeCore()?.abiVersion()).toBe(NATIVE_ABI);
  });

  it("in required mode throws instead of falling back when the core is missing", () => {
    process.env["CODESIFT_NATIVE"] = "1";
    resetNativeForTesting();
    if (nativeStatus().loaded) {
      expect(getNativeCore()?.abiVersion()).toBe(NATIVE_ABI);
    } else {
      expect(() => getNativeCore()).toThrow(NativeCoreUnavailableError);
    }
  });
});
