// Test level: medium (local temp filesystem and mocked parser; no network or sleeps).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIndex } from "../../src/types.js";
import { getParser } from "../../src/parser/parser-manager.js";
import { loadPythonFileContext } from "../../src/tools/python-constants/file-context.js";

vi.mock("../../src/parser/parser-manager.js", () => ({
  getParser: vi.fn(),
}));

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  ));
});

function makeIndex(root: string): CodeIndex {
  return {
    repo: "local/python-context-test",
    root,
    symbols: [],
    files: [{
      path: "broken.py",
      language: "python",
      symbol_count: 0,
      last_modified: 0,
    }],
    created_at: 0,
    updated_at: 0,
    symbol_count: 0,
    file_count: 1,
  };
}

describe("loadPythonFileContext", () => {
  it("negative-caches parser failures across repeated resolution attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesift-python-context-"));
    tempDirectories.push(root);
    await writeFile(join(root, "broken.py"), "BROKEN = (");
    const parse = vi.fn(() => null);
    vi.mocked(getParser).mockResolvedValue({ parse } as unknown as NonNullable<Awaited<ReturnType<typeof getParser>>>);
    const cache = new Map();

    expect(await loadPythonFileContext(makeIndex(root), "broken.py", cache)).toBeNull();
    expect(await loadPythonFileContext(makeIndex(root), "broken.py", cache)).toBeNull();

    expect(getParser).toHaveBeenCalledTimes(1);
    expect(getParser).toHaveBeenCalledWith("python");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(cache.get("broken.py")).toBeNull();
  });
});
