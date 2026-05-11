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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function writeGitOrigin(repoRoot: string, url: string): Promise<void> {
  await mkdir(join(repoRoot, ".git"), { recursive: true });
  await writeFile(
    join(repoRoot, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
}

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
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

    it("honors .codesift.json name override (bare name)", async () => {
      await writeFile(join(tmpDir, ".codesift.json"), JSON.stringify({ name: "tgm-survey-platform" }));
      expect(getRepoName(tmpDir)).toBe("local/tgm-survey-platform");
    });

    it("honors .codesift.json name override (namespaced)", async () => {
      await writeFile(join(tmpDir, ".codesift.json"), JSON.stringify({ name: "team/tgm-survey-platform" }));
      expect(getRepoName(tmpDir)).toBe("team/tgm-survey-platform");
    });

    it("falls back to basename when override is malformed JSON", async () => {
      await writeFile(join(tmpDir, ".codesift.json"), "{ not json");
      expect(getRepoName(tmpDir)).toBe(`local/${tmpDir.split("/").pop()}`);
    });

    it("falls back to basename when override has empty name", async () => {
      await writeFile(join(tmpDir, ".codesift.json"), JSON.stringify({ name: "   " }));
      expect(getRepoName(tmpDir)).toBe(`local/${tmpDir.split("/").pop()}`);
    });

    it("falls back to basename when override has no name field", async () => {
      await writeFile(join(tmpDir, ".codesift.json"), JSON.stringify({ other: "value" }));
      expect(getRepoName(tmpDir)).toBe(`local/${tmpDir.split("/").pop()}`);
    });

    describe("git remote.origin.url auto-detection", () => {
      it("derives name from SSH remote (git@host:owner/repo.git)", async () => {
        await writeGitOrigin(tmpDir, "git@github.com:greglas/tgm-survey-platform.git");
        expect(getRepoName(tmpDir)).toBe("local/tgm-survey-platform");
      });

      it("derives name from HTTPS remote with .git suffix", async () => {
        await writeGitOrigin(tmpDir, "https://github.com/greglas/tgm-survey-platform.git");
        expect(getRepoName(tmpDir)).toBe("local/tgm-survey-platform");
      });

      it("derives name from HTTPS remote without .git suffix", async () => {
        await writeGitOrigin(tmpDir, "https://github.com/greglas/tgm-survey-platform");
        expect(getRepoName(tmpDir)).toBe("local/tgm-survey-platform");
      });

      it("derives name from ssh:// URL form", async () => {
        await writeGitOrigin(tmpDir, "ssh://git@github.com/greglas/tgm-survey-platform.git");
        expect(getRepoName(tmpDir)).toBe("local/tgm-survey-platform");
      });

      it("returns trailing segment for GitLab subgroups", async () => {
        await writeGitOrigin(tmpDir, "git@gitlab.com:team/sub/tgm-survey-platform.git");
        expect(getRepoName(tmpDir)).toBe("local/tgm-survey-platform");
      });

      it("git origin overrides basename when CWD has a different name", async () => {
        // Simulates VPS: directory is ~/workspace but remote is tgm-survey-platform.
        const vpsDir = join(tmpDir, "workspace");
        await mkdir(vpsDir);
        await writeGitOrigin(vpsDir, "git@github.com:greglas/tgm-survey-platform.git");
        expect(getRepoName(vpsDir)).toBe("local/tgm-survey-platform");
      });

      it(".codesift.json takes precedence over git origin", async () => {
        await writeGitOrigin(tmpDir, "git@github.com:greglas/auto-name.git");
        await writeFile(join(tmpDir, ".codesift.json"), JSON.stringify({ name: "manual-override" }));
        expect(getRepoName(tmpDir)).toBe("local/manual-override");
      });

      it("falls back to basename when .git is a file (worktree/submodule)", async () => {
        await writeFile(join(tmpDir, ".git"), "gitdir: /some/other/path\n");
        expect(getRepoName(tmpDir)).toBe(`local/${tmpDir.split("/").pop()}`);
      });

      it("falls back to basename when origin remote is absent", async () => {
        await mkdir(join(tmpDir, ".git"), { recursive: true });
        await writeFile(
          join(tmpDir, ".git", "config"),
          `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = git@github.com:other/repo.git\n`,
        );
        expect(getRepoName(tmpDir)).toBe(`local/${tmpDir.split("/").pop()}`);
      });

      it("falls back to basename when origin url is unparseable", async () => {
        await writeGitOrigin(tmpDir, "::not a url::");
        expect(getRepoName(tmpDir)).toBe(`local/${tmpDir.split("/").pop()}`);
      });
    });
  });
});
