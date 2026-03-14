import { parseArgs, getFlag, getBoolFlag, getNumFlag, output, requireArg } from "../../src/cli/args.js";
import { vi, type MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("extracts positional arguments without flags", () => {
    const result = parseArgs(["search", "local/repo", "query"]);
    expect(result.positional).toEqual(["search", "local/repo", "query"]);
    expect(result.flags).toEqual({});
  });

  it("extracts boolean flags (no value after flag)", () => {
    const result = parseArgs(["--verbose", "--compact"]);
    expect(result.flags).toEqual({ verbose: true, compact: true });
    expect(result.positional).toEqual([]);
  });

  it("extracts string flags with values", () => {
    const result = parseArgs(["--kind", "function", "--path", "src/"]);
    expect(result.flags).toEqual({ kind: "function", path: "src/" });
    expect(result.positional).toEqual([]);
  });

  it("handles mixed positional and flag arguments", () => {
    const result = parseArgs(["search", "local/repo", "query", "--compact", "--kind", "function"]);
    expect(result.positional).toEqual(["search", "local/repo", "query"]);
    expect(result.flags).toEqual({ compact: true, kind: "function" });
  });

  it("treats flag followed by another flag as boolean", () => {
    const result = parseArgs(["--verbose", "--kind", "function"]);
    expect(result.flags["verbose"]).toBe(true);
    expect(result.flags["kind"]).toBe("function");
  });

  it("treats flag at end of args as boolean", () => {
    const result = parseArgs(["search", "--compact"]);
    expect(result.flags["compact"]).toBe(true);
  });

  it("returns empty arrays for empty input", () => {
    const result = parseArgs([]);
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it("does not treat single-dash arguments as flags", () => {
    const result = parseArgs(["-v", "search"]);
    expect(result.positional).toEqual(["-v", "search"]);
    expect(result.flags).toEqual({});
  });

  it("handles flag value that looks like a path", () => {
    const result = parseArgs(["--path", "/usr/local/bin"]);
    expect(result.flags["path"]).toBe("/usr/local/bin");
  });
});

// ---------------------------------------------------------------------------
// getFlag
// ---------------------------------------------------------------------------

describe("getFlag", () => {
  it("returns string value for a string flag", () => {
    expect(getFlag({ kind: "function" }, "kind")).toBe("function");
  });

  it("returns undefined for a boolean flag", () => {
    expect(getFlag({ verbose: true }, "verbose")).toBeUndefined();
  });

  it("returns undefined for a missing flag", () => {
    expect(getFlag({}, "missing")).toBeUndefined();
  });

  it("returns undefined when flag value is boolean false", () => {
    expect(getFlag({ flag: false }, "flag")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getBoolFlag
// ---------------------------------------------------------------------------

describe("getBoolFlag", () => {
  it("returns true for boolean true", () => {
    expect(getBoolFlag({ verbose: true }, "verbose")).toBe(true);
  });

  it('returns true for string "true"', () => {
    expect(getBoolFlag({ verbose: "true" }, "verbose")).toBe(true);
  });

  it('returns false for string "false"', () => {
    expect(getBoolFlag({ verbose: "false" }, "verbose")).toBe(false);
  });

  it("returns undefined for missing flag", () => {
    expect(getBoolFlag({}, "verbose")).toBeUndefined();
  });

  it("returns true for any other string value", () => {
    expect(getBoolFlag({ flag: "yes" }, "flag")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getNumFlag
// ---------------------------------------------------------------------------

describe("getNumFlag", () => {
  let exitSpy: MockInstance;
  let stderrSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed number for valid numeric string", () => {
    expect(getNumFlag({ depth: "5" }, "depth")).toBe(5);
  });

  it("returns undefined for missing flag", () => {
    expect(getNumFlag({}, "depth")).toBeUndefined();
  });

  it("returns undefined when flag is boolean (not string)", () => {
    expect(getNumFlag({ depth: true }, "depth")).toBeUndefined();
  });

  it("calls die with descriptive message for NaN value", () => {
    getNumFlag({ depth: "abc" }, "depth");
    expect(stderrSpy).toHaveBeenCalledWith("Error: Invalid number for --depth: abc\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles zero correctly", () => {
    expect(getNumFlag({ offset: "0" }, "offset")).toBe(0);
  });

  it("handles negative numbers", () => {
    expect(getNumFlag({ offset: "-3" }, "offset")).toBe(-3);
  });

  it("handles floating point numbers", () => {
    expect(getNumFlag({ weight: "2.5" }, "weight")).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

describe("output", () => {
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes pretty-printed JSON by default", () => {
    output({ a: 1 }, {});
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2) + "\n");
  });

  it("writes compact JSON when --compact flag is set", () => {
    output({ a: 1 }, { compact: true });
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }) + "\n");
  });

  it("handles null data", () => {
    output(null, {});
    expect(stdoutSpy).toHaveBeenCalledWith("null\n");
  });

  it("handles array data", () => {
    output([1, 2, 3], { compact: true });
    expect(stdoutSpy).toHaveBeenCalledWith("[1,2,3]\n");
  });
});

// ---------------------------------------------------------------------------
// requireArg
// ---------------------------------------------------------------------------

describe("requireArg", () => {
  let exitSpy: MockInstance;
  let stderrSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the argument at the given index", () => {
    expect(requireArg(["a", "b", "c"], 1, "query")).toBe("b");
  });

  it("returns the first argument at index 0", () => {
    expect(requireArg(["path/to/dir"], 0, "path")).toBe("path/to/dir");
  });

  it("calls die when index is out of bounds", () => {
    requireArg([], 0, "repo");
    expect(stderrSpy).toHaveBeenCalledWith("Error: Missing required argument: <repo>\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("calls die when array is shorter than index", () => {
    requireArg(["only-one"], 2, "file");
    expect(stderrSpy).toHaveBeenCalledWith("Error: Missing required argument: <file>\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
