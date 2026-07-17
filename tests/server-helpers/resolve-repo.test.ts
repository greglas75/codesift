import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  resolveRepoFromCwd,
  isAncestorOrEqual,
  loadRegistrySync,
  _resetRegistryCacheForTests,
} from "../../src/server-helpers.js";

let tmpDir: string;
let registryPath: string;

interface RegistryRepoFixture {
  name: string;
  root: string;
  symbol_count: number;
  file_count: number;
}

async function writeRegistry(repos: RegistryRepoFixture[]): Promise<void> {
  const obj = {
    repos: Object.fromEntries(repos.map((r) => [r.name, r])),
    updated_at: Date.now(),
  };
  await writeFile(registryPath, JSON.stringify(obj));
  _resetRegistryCacheForTests();
}

describe("isAncestorOrEqual", () => {
  it("matches identical paths", () => {
    expect(isAncestorOrEqual("/a/b", "/a/b")).toBe(true);
  });

  it("matches descendant on segment boundary", () => {
    expect(isAncestorOrEqual("/a/b", "/a/b/c")).toBe(true);
    expect(isAncestorOrEqual("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("rejects path with shared prefix but no segment boundary", () => {
    expect(isAncestorOrEqual("/a/b", "/a/bc")).toBe(false);
    expect(isAncestorOrEqual("/foo/repo", "/foo/repo-clone")).toBe(false);
  });

  it("rejects unrelated paths", () => {
    expect(isAncestorOrEqual("/a/b", "/c/d")).toBe(false);
  });
});

describe("resolveRepoFromCwd", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-resolve-"));
    registryPath = join(tmpDir, "registry.json");
    _resetRegistryCacheForTests();
  });

  afterEach(async () => {
    _resetRegistryCacheForTests();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns matching repo when cwd equals registered root", async () => {
    await writeRegistry([
      { name: "local/zuvo-plugin", root: "/Users/g/DEV/zuvo-plugin", symbol_count: 1900, file_count: 270 },
    ]);
    expect(resolveRepoFromCwd("/Users/g/DEV/zuvo-plugin", registryPath)).toBe("local/zuvo-plugin");
  });

  it("walks up monorepo subdirectories to find the registered root", async () => {
    await writeRegistry([
      { name: "local/tgm-survey-platform", root: "/Users/g/DEV/tgm-survey-platform", symbol_count: 77598, file_count: 5027 },
    ]);
    expect(
      resolveRepoFromCwd("/Users/g/DEV/tgm-survey-platform/apps/api", registryPath),
    ).toBe("local/tgm-survey-platform");
  });

  it("walks up worktree subdirectories", async () => {
    await writeRegistry([
      { name: "local/translation-qa", root: "/Users/g/DEV/translation-qa", symbol_count: 106184, file_count: 6801 },
    ]);
    expect(
      resolveRepoFromCwd("/Users/g/DEV/translation-qa/.worktrees/word-document-type", registryPath),
    ).toBe("local/translation-qa");
  });

  it("ignores ~/.claude/projects/ chat-history indexes when resolving", async () => {
    const claudeProjects = join(homedir(), ".claude", "projects");
    await writeRegistry([
      {
        name: "conversations/-Users-g-DEV-tgm-survey-platform-apps-api-src",
        root: join(claudeProjects, "-Users-g-DEV-tgm-survey-platform-apps-api-src"),
        symbol_count: 0,
        file_count: 0,
      },
      { name: "local/tgm-survey-platform", root: "/Users/g/DEV/tgm-survey-platform", symbol_count: 77598, file_count: 5027 },
    ]);
    expect(
      resolveRepoFromCwd("/Users/g/DEV/tgm-survey-platform/apps/api", registryPath),
    ).toBe("local/tgm-survey-platform");
  });

  it("ignores 0-symbol stub entries even outside ~/.claude/projects/", async () => {
    await writeRegistry([
      { name: "local/empty-stub", root: "/Users/g/DEV/foo", symbol_count: 0, file_count: 0 },
      { name: "local/foo-real", root: "/Users/g/DEV/foo", symbol_count: 1234, file_count: 50 },
    ]);
    expect(resolveRepoFromCwd("/Users/g/DEV/foo/sub", registryPath)).toBe("local/foo-real");
  });

  it("picks the longest matching root when nested repos are both registered", async () => {
    await writeRegistry([
      { name: "local/outer", root: "/Users/g/DEV/outer", symbol_count: 100, file_count: 10 },
      { name: "local/inner", root: "/Users/g/DEV/outer/packages/inner", symbol_count: 50, file_count: 5 },
    ]);
    expect(
      resolveRepoFromCwd("/Users/g/DEV/outer/packages/inner/src", registryPath),
    ).toBe("local/inner");
    expect(
      resolveRepoFromCwd("/Users/g/DEV/outer/elsewhere", registryPath),
    ).toBe("local/outer");
  });

  it("falls back to local/<basename(cwd)> when nothing in registry matches", async () => {
    await writeRegistry([
      { name: "local/some-other-repo", root: "/elsewhere", symbol_count: 10, file_count: 1 },
    ]);
    expect(resolveRepoFromCwd("/Users/g/DEV/never-indexed", registryPath)).toBe("local/never-indexed");
  });

  it("falls back when registry is missing/unreadable", () => {
    expect(resolveRepoFromCwd("/Users/g/DEV/foo", "/no/such/registry.json")).toBe("local/foo");
  });

  it("does not match a sibling whose path shares a string prefix", async () => {
    await writeRegistry([
      { name: "local/repo", root: "/Users/g/DEV/repo", symbol_count: 100, file_count: 10 },
    ]);
    expect(resolveRepoFromCwd("/Users/g/DEV/repo-clone", registryPath)).toBe("local/repo-clone");
  });
});

describe("loadRegistrySync", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-resolve-cache-"));
    registryPath = join(tmpDir, "registry.json");
    _resetRegistryCacheForTests();
  });

  afterEach(async () => {
    _resetRegistryCacheForTests();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns [] for missing file", () => {
    expect(loadRegistrySync(join(tmpDir, "absent.json"))).toEqual([]);
  });

  it("returns [] for malformed JSON without throwing", async () => {
    await writeFile(registryPath, "{not json");
    expect(loadRegistrySync(registryPath)).toEqual([]);
  });

  it("returns [] when repos key is missing", async () => {
    await writeFile(registryPath, JSON.stringify({ updated_at: 1 }));
    expect(loadRegistrySync(registryPath)).toEqual([]);
  });

  it("keeps caches isolated for registry files with the same mtime", async () => {
    const secondPath = join(tmpDir, "registry-second.json");
    await writeFile(registryPath, JSON.stringify({ repos: { first: { name: "first", root: "/first", symbol_count: 1, file_count: 1 } } }));
    await writeFile(secondPath, JSON.stringify({ repos: { second: { name: "second", root: "/second", symbol_count: 1, file_count: 1 } } }));
    const sameTime = new Date(1_700_000_000_000);
    await Promise.all([utimes(registryPath, sameTime, sameTime), utimes(secondPath, sameTime, sameTime)]);

    expect(loadRegistrySync(registryPath).map((repo) => repo.name)).toEqual(["first"]);
    expect(loadRegistrySync(secondPath).map((repo) => repo.name)).toEqual(["second"]);
  });

  // The isolation above only proves the cache separates two *absolute* paths.
  // The cache key is whatever string the caller passed, so the same relative
  // name resolved from two directories is the case that can still collide —
  // and it is the one no test covered. Give the two files the same mtime so
  // nothing but the key can tell them apart.
  it("keeps caches isolated for identical relative paths resolved from different directories", async () => {
    const dirA = join(tmpDir, "a");
    const dirB = join(tmpDir, "b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "registry.json"), JSON.stringify({ repos: { fromA: { name: "fromA", root: "/a", symbol_count: 1, file_count: 1 } } }));
    await writeFile(join(dirB, "registry.json"), JSON.stringify({ repos: { fromB: { name: "fromB", root: "/b", symbol_count: 1, file_count: 1 } } }));
    const sameTime = new Date(1_700_000_000_000);
    await Promise.all([
      utimes(join(dirA, "registry.json"), sameTime, sameTime),
      utimes(join(dirB, "registry.json"), sameTime, sameTime),
    ]);

    const originalCwd = process.cwd();
    try {
      process.chdir(dirA);
      expect(loadRegistrySync("registry.json").map((repo) => repo.name)).toEqual(["fromA"]);
      process.chdir(dirB);
      expect(loadRegistrySync("registry.json").map((repo) => repo.name)).toEqual(["fromB"]);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
