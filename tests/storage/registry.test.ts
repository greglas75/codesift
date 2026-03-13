import {
  loadRegistry,
  saveRegistry,
  registerRepo,
  getRepo,
  listRepos,
  removeRepo,
  getRepoName,
} from "../../src/storage/registry.js";
import type { RepoMeta } from "../../src/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeMeta(name: string): RepoMeta {
  return {
    name,
    root: `/tmp/${name}`,
    index_path: `/tmp/.codesift/${name}.index.json`,
    symbol_count: 100,
    file_count: 10,
    updated_at: Date.now(),
  };
}

describe("registry", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-registry-test-"));
    registryPath = join(tmpDir, "registry.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("loadRegistry", () => {
    it("returns an empty registry for a non-existent file", async () => {
      const registry = await loadRegistry(registryPath);

      expect(registry.repos).toEqual({});
      expect(registry.updated_at).toBeTypeOf("number");
    });
  });

  describe("registerRepo + getRepo", () => {
    it("registers a repo and retrieves it by name", async () => {
      const meta = makeMeta("local/myapp");
      await registerRepo(registryPath, meta);

      const retrieved = await getRepo(registryPath, "local/myapp");

      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("local/myapp");
      expect(retrieved!.root).toBe(meta.root);
      expect(retrieved!.index_path).toBe(meta.index_path);
      expect(retrieved!.symbol_count).toBe(100);
      expect(retrieved!.file_count).toBe(10);
    });

    it("returns null for an unregistered repo", async () => {
      const result = await getRepo(registryPath, "local/nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("registerRepo overwrites", () => {
    it("second registration with same name replaces the first", async () => {
      const first = makeMeta("local/myapp");
      await registerRepo(registryPath, first);

      const second = makeMeta("local/myapp");
      second.symbol_count = 999;
      second.root = "/tmp/updated-root";
      await registerRepo(registryPath, second);

      const retrieved = await getRepo(registryPath, "local/myapp");

      expect(retrieved).not.toBeNull();
      expect(retrieved!.symbol_count).toBe(999);
      expect(retrieved!.root).toBe("/tmp/updated-root");
    });
  });

  describe("listRepos", () => {
    it("returns all registered repos", async () => {
      await registerRepo(registryPath, makeMeta("local/app-a"));
      await registerRepo(registryPath, makeMeta("local/app-b"));
      await registerRepo(registryPath, makeMeta("local/app-c"));

      const repos = await listRepos(registryPath);

      expect(repos).toHaveLength(3);
      const names = repos.map((r) => r.name).sort();
      expect(names).toEqual(["local/app-a", "local/app-b", "local/app-c"]);
    });

    it("returns empty array when no repos registered", async () => {
      const repos = await listRepos(registryPath);
      expect(repos).toEqual([]);
    });
  });

  describe("removeRepo", () => {
    it("removes an existing repo and returns true", async () => {
      await registerRepo(registryPath, makeMeta("local/target"));

      const removed = await removeRepo(registryPath, "local/target");
      expect(removed).toBe(true);

      const retrieved = await getRepo(registryPath, "local/target");
      expect(retrieved).toBeNull();
    });

    it("returns false when removing a non-existent repo", async () => {
      const removed = await removeRepo(registryPath, "local/ghost");
      expect(removed).toBe(false);
    });

    it("returns false on second removal of same repo", async () => {
      await registerRepo(registryPath, makeMeta("local/once"));

      const first = await removeRepo(registryPath, "local/once");
      expect(first).toBe(true);

      const second = await removeRepo(registryPath, "local/once");
      expect(second).toBe(false);
    });
  });

  describe("getRepoName", () => {
    it("derives local/<folder> from an absolute path", () => {
      const result = getRepoName("/Users/foo/projects/myapp");
      expect(result).toBe("local/myapp");
    });

    it("handles paths with trailing slash", () => {
      // basename("/Users/foo/myapp/") returns "myapp" in Node
      const result = getRepoName("/Users/foo/myapp");
      expect(result).toBe("local/myapp");
    });

    it("handles deeply nested paths", () => {
      const result = getRepoName("/a/b/c/d/e/deep-project");
      expect(result).toBe("local/deep-project");
    });
  });
});
