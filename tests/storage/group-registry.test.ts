import {
  loadGroupRegistry,
  saveGroupRegistry,
  registerGroup,
  getGroup,
  listGroups,
  removeGroup,
  getGroupRegistryPath,
} from "../../src/storage/group-registry.js";
import type { RepoGroup } from "../../src/types.js";
import { mkdtemp, rm, writeFile, chmod, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

describe("group-registry", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codesift-group-registry-test-"));
    registryPath = join(tmpDir, "groups.json");
  });

  afterEach(async () => {
    // Best-effort restore permissions before cleanup (for EACCES tests)
    try { await chmod(registryPath, 0o644); } catch { /* ignore */ }
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe("getGroupRegistryPath", () => {
    it("returns groups.json inside the data dir", () => {
      const result = getGroupRegistryPath("/some/data/dir");
      expect(result).toBe("/some/data/dir/groups.json");
    });
  });

  describe("loadGroupRegistry", () => {
    it("returns an empty registry for a non-existent file", async () => {
      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});
      expect(reg.updated_at).toBeTypeOf("number");
    });

    it("returns an empty registry for corrupted JSON (no throw)", async () => {
      await writeFile(registryPath, "{ not valid json !!!");
      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});
    });

    it("returns empty registry when groups is not an object", async () => {
      await writeFile(registryPath, JSON.stringify({ groups: ["wrong"], updated_at: Date.now() }));
      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});
    });

    it("returns empty registry when a group entry is missing name", async () => {
      const bad = {
        groups: { mygroup: { repos: ["a"], created_at: 1, updated_at: 1 } },
        updated_at: Date.now(),
      };
      await writeFile(registryPath, JSON.stringify(bad));
      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});
    });

    it("returns empty registry when repos is not a string array", async () => {
      const bad = {
        groups: { mygroup: { name: "mygroup", repos: [1, 2], created_at: 1, updated_at: 1 } },
        updated_at: Date.now(),
      };
      await writeFile(registryPath, JSON.stringify(bad));
      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});
    });

    // -----------------------------------------------------------------------
    // CRITICAL-1: corrupt file quarantine
    // -----------------------------------------------------------------------
    it("[C1] corrupt JSON → quarantined sibling exists and empty registry returned", async () => {
      await writeFile(registryPath, "{ not valid json !!!");
      const reg = await loadGroupRegistry(registryPath);

      // Still returns empty
      expect(reg.groups).toEqual({});

      // Sibling .corrupt-<ts> file must exist
      const dir = tmpDir;
      const entries = await import("node:fs/promises").then((m) =>
        m.readdir(dir)
      );
      const quarantined = entries.filter((e) => e.startsWith("groups.json.corrupt-"));
      expect(quarantined).toHaveLength(1);

      // Original file must NOT exist (was renamed)
      expect(existsSync(registryPath)).toBe(false);
    });

    it("[C1] structurally invalid JSON object → quarantined sibling exists and empty returned", async () => {
      // Valid JSON but fails isValidGroupRegistry (missing updated_at)
      await writeFile(registryPath, JSON.stringify({ groups: {} }));
      const reg = await loadGroupRegistry(registryPath);

      expect(reg.groups).toEqual({});

      const entries = await import("node:fs/promises").then((m) =>
        m.readdir(tmpDir)
      );
      const quarantined = entries.filter((e) => e.startsWith("groups.json.corrupt-"));
      expect(quarantined).toHaveLength(1);
      expect(existsSync(registryPath)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // CRITICAL-1: EACCES → throw (not silent wipe)
    // -----------------------------------------------------------------------
    it.skipIf(process.getuid?.() === 0)(
      "[C1] EACCES on read → loadGroupRegistry throws",
      async () => {
        // Create a valid file, then lock it
        await writeFile(registryPath, JSON.stringify({ groups: {}, updated_at: Date.now() }));
        await chmod(registryPath, 0o000);

        await expect(loadGroupRegistry(registryPath)).rejects.toThrow();

        // Restore before afterEach cleanup
        await chmod(registryPath, 0o644);
      }
    );

    it.skipIf(process.getuid?.() === 0)(
      "[C1] EACCES → registerGroup rejects, original file intact after chmod restore",
      async () => {
        // Seed a valid registry
        await registerGroup(registryPath, { name: "seed", repos: ["r1"] });
        const before = await loadGroupRegistry(registryPath);
        expect(Object.keys(before.groups)).toHaveLength(1);

        // Lock the file
        await chmod(registryPath, 0o000);

        // Mutation must reject (not silently overwrite with empty)
        await expect(
          registerGroup(registryPath, { name: "new-group", repos: ["r2"] })
        ).rejects.toThrow();

        // Restore and verify original data is intact
        await chmod(registryPath, 0o644);
        const after = await loadGroupRegistry(registryPath);
        expect(Object.keys(after.groups)).toHaveLength(1);
        expect(after.groups["seed"]).toBeDefined();
        expect(after.groups["new-group"]).toBeUndefined();
      }
    );
  });

  describe("registerGroup + getGroup", () => {
    it("registers a group and retrieves it by name", async () => {
      await registerGroup(registryPath, { name: "mygroup", repos: ["repo-a", "repo-b"] });
      const group = await getGroup(registryPath, "mygroup");
      expect(group).not.toBeNull();
      expect(group!.name).toBe("mygroup");
      expect(group!.repos).toEqual(["repo-a", "repo-b"]);
      expect(group!.created_at).toBeTypeOf("number");
      expect(group!.updated_at).toBeTypeOf("number");
    });

    it("returns null for an unregistered group", async () => {
      const result = await getGroup(registryPath, "nonexistent");
      expect(result).toBeNull();
    });

    it("accepts a group with 0 repos", async () => {
      await registerGroup(registryPath, { name: "empty-group", repos: [] });
      const group = await getGroup(registryPath, "empty-group");
      expect(group).not.toBeNull();
      expect(group!.repos).toEqual([]);
    });

    it("deduplicates repos on save", async () => {
      await registerGroup(registryPath, { name: "dedup-group", repos: ["a", "b", "a"] });
      const group = await getGroup(registryPath, "dedup-group");
      expect(group).not.toBeNull();
      expect(group!.repos).toEqual(["a", "b"]);
    });

    it("stores optional description when provided", async () => {
      await registerGroup(registryPath, { name: "described", repos: ["r1"], description: "My description" });
      const group = await getGroup(registryPath, "described");
      expect(group).not.toBeNull();
      expect(group!.description).toBe("My description");
    });

    it("omits description field when not provided", async () => {
      await registerGroup(registryPath, { name: "nodesc", repos: ["r1"] });
      const group = await getGroup(registryPath, "nodesc");
      expect(group).not.toBeNull();
      expect("description" in group!).toBe(false);
    });

    // -----------------------------------------------------------------------
    // CRITICAL-2: prototype pollution guard
    // -----------------------------------------------------------------------
    it("[C2] registerGroup('__proto__') → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "__proto__", repos: [] })
      ).rejects.toThrow(/reserved|invalid|prototype/i);
    });

    it("[C2] registerGroup('constructor') → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "constructor", repos: [] })
      ).rejects.toThrow(/reserved|invalid|prototype/i);
    });

    it("[C2] registerGroup('prototype') → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "prototype", repos: [] })
      ).rejects.toThrow(/reserved|invalid|prototype/i);
    });

    it("[C2] registerGroup('') → rejects (empty name)", async () => {
      await expect(
        registerGroup(registryPath, { name: "", repos: [] })
      ).rejects.toThrow(/empty|invalid|name/i);
    });

    it("[C2] registerGroup('   ') → rejects (whitespace-only name)", async () => {
      await expect(
        registerGroup(registryPath, { name: "   ", repos: [] })
      ).rejects.toThrow(/empty|invalid|name/i);
    });

    it("[C2] getGroup('constructor') on empty registry → null (not Function)", async () => {
      const result = await getGroup(registryPath, "constructor");
      expect(result).toBeNull();
    });

    it("[C2] getGroup('__proto__') → null (not Object prototype)", async () => {
      const result = await getGroup(registryPath, "__proto__");
      expect(result).toBeNull();
    });

    it("[C2] listGroups does not expose prototype chain entries", async () => {
      await registerGroup(registryPath, { name: "legit", repos: ["x"] });
      const groups = await listGroups(registryPath);
      const names = groups.map((g) => g.name);
      expect(names).not.toContain("__proto__");
      expect(names).not.toContain("constructor");
      expect(names).not.toContain("prototype");
      // Should still include the legitimate group
      expect(names).toContain("legit");
    });
  });

  describe("overwrite preserves created_at and updates updated_at", () => {
    it("second registration updates updated_at AND preserves created_at", async () => {
      await registerGroup(registryPath, { name: "g1", repos: ["a"] });
      const first = await getGroup(registryPath, "g1");
      const originalCreatedAt = first!.created_at;
      const originalUpdatedAt = first!.updated_at;

      // Ensure enough time passes for timestamps to differ
      await new Promise((r) => setTimeout(r, 5));

      await registerGroup(registryPath, { name: "g1", repos: ["b", "c"] });
      const second = await getGroup(registryPath, "g1");

      expect(second!.created_at).toBe(originalCreatedAt);
      expect(second!.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
      expect(second!.repos).toEqual(["b", "c"]);
    });
  });

  describe("listGroups", () => {
    it("returns all registered groups", async () => {
      await registerGroup(registryPath, { name: "alpha", repos: ["r1"] });
      await registerGroup(registryPath, { name: "beta", repos: ["r2"] });
      await registerGroup(registryPath, { name: "gamma", repos: ["r3"] });

      const groups = await listGroups(registryPath);
      expect(groups).toHaveLength(3);
      const names = groups.map((g) => g.name).sort();
      expect(names).toEqual(["alpha", "beta", "gamma"]);
    });

    it("returns empty array when no groups registered", async () => {
      const groups = await listGroups(registryPath);
      expect(groups).toEqual([]);
    });
  });

  describe("removeGroup", () => {
    it("removes an existing group and returns true", async () => {
      await registerGroup(registryPath, { name: "target", repos: ["r1"] });
      const removed = await removeGroup(registryPath, "target");
      expect(removed).toBe(true);

      const retrieved = await getGroup(registryPath, "target");
      expect(retrieved).toBeNull();
    });

    it("is idempotent — returns false when group does not exist", async () => {
      const removed = await removeGroup(registryPath, "ghost");
      expect(removed).toBe(false);
    });

    it("returns false on second removal of same group", async () => {
      await registerGroup(registryPath, { name: "once", repos: [] });
      const first = await removeGroup(registryPath, "once");
      expect(first).toBe(true);
      const second = await removeGroup(registryPath, "once");
      expect(second).toBe(false);
    });
  });

  describe("round-trip persistence", () => {
    it("persists data across load/save cycles", async () => {
      await registerGroup(registryPath, { name: "persist-me", repos: ["x", "y"], description: "kept" });

      // Load fresh from disk
      const reg = await loadGroupRegistry(registryPath);
      const group = reg.groups["persist-me"];
      expect(group).toBeDefined();
      expect(group!.repos).toEqual(["x", "y"]);
      expect(group!.description).toBe("kept");
    });
  });

  // -------------------------------------------------------------------------
  // CRITICAL-3: R-M-W race condition — concurrent registerGroup
  // -------------------------------------------------------------------------
  describe("[C3] concurrent registerGroup serialization", () => {
    it("5 concurrent registerGroup calls with different names → all 5 present in final file", async () => {
      const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
      await Promise.all(
        names.map((name) => registerGroup(registryPath, { name, repos: [`repo-${name}`] }))
      );

      const reg = await loadGroupRegistry(registryPath);
      const saved = Object.keys(reg.groups).sort();
      expect(saved).toEqual(names.sort());
    });

    it("10 concurrent registerGroup calls → all 10 present with correct repos", async () => {
      const names = Array.from({ length: 10 }, (_, i) => `group-${i}`);
      await Promise.all(
        names.map((name) => registerGroup(registryPath, { name, repos: [`r-${name}`] }))
      );

      const reg = await loadGroupRegistry(registryPath);
      const saved = Object.keys(reg.groups).sort();
      expect(saved).toEqual(names.sort());

      // Verify each group has the correct repo (not cross-contaminated)
      for (const name of names) {
        expect(reg.groups[name]?.repos).toEqual([`r-${name}`]);
      }
    });

    it("concurrent overwrite of same group → last write wins (no silent data loss)", async () => {
      // Seed an initial value
      await registerGroup(registryPath, { name: "shared", repos: ["initial"] });

      // Fire 5 concurrent updates to the same group — any one value is valid,
      // but the registry must remain readable and consistent (no corruption)
      const updates = ["v1", "v2", "v3", "v4", "v5"];
      await Promise.all(
        updates.map((v) => registerGroup(registryPath, { name: "shared", repos: [v] }))
      );

      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups["shared"]).toBeDefined();
      expect(reg.groups["shared"]!.repos).toHaveLength(1);
      expect(updates).toContain(reg.groups["shared"]!.repos[0]);
    });

    // -----------------------------------------------------------------------
    // FIX-A: lock key normalization — "./path" and "path" must share a lock
    // -----------------------------------------------------------------------
    it("[FIX-A] two concurrent registerGroup calls via differently-spelled paths share the same lock", async () => {
      // "./groups.json" and "groups.json" (both resolve to the same file)
      const relPath = join(tmpDir, "groups.json");
      const altPath = join(tmpDir, ".", "groups.json"); // different string, same resolved path
      // Sanity check: they really resolve identically
      expect(resolve(relPath)).toBe(resolve(altPath));

      await Promise.all([
        registerGroup(relPath, { name: "group-a", repos: ["repo-a"] }),
        registerGroup(altPath, { name: "group-b", repos: ["repo-b"] }),
      ]);

      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups["group-a"]).toBeDefined();
      expect(reg.groups["group-b"]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // FIX-B: runtime input validation for repos and description
  // -------------------------------------------------------------------------
  describe("[FIX-B] registerGroup runtime input validation", () => {
    it("repos is not an array → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "g1", repos: "not-array" as unknown as string[] })
      ).rejects.toThrow(/array/i);
    });

    it("repos contains non-string elements → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "g2", repos: [1, 2] as unknown as string[] })
      ).rejects.toThrow(/string/i);
    });

    it("repos contains empty-string element → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "g3", repos: ["valid", ""] })
      ).rejects.toThrow(/non-empty string/i);
    });

    it("description is a non-string (number) → rejects with descriptive error", async () => {
      await expect(
        registerGroup(registryPath, { name: "g4", repos: ["r1"], description: 42 as unknown as string })
      ).rejects.toThrow(/description/i);
    });

    it("valid input (empty repos array, no description) → succeeds", async () => {
      await expect(
        registerGroup(registryPath, { name: "g5", repos: [] })
      ).resolves.toBeUndefined();
    });

    it("valid input with description string → succeeds", async () => {
      await expect(
        registerGroup(registryPath, { name: "g6", repos: ["r1"], description: "ok" })
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // FIX-C: isValidGroupRegistry — key/name mismatch and reserved key rejection
  // -------------------------------------------------------------------------
  describe("[FIX-C] isValidGroupRegistry — key/name mismatch and reserved keys", () => {
    it("disk file with key 'a' but group name 'b' → load returns empty + quarantined", async () => {
      const bad = {
        groups: {
          a: { name: "b", repos: ["r1"], created_at: 1, updated_at: 1 },
        },
        updated_at: Date.now(),
      };
      await writeFile(registryPath, JSON.stringify(bad));

      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});

      // File should be quarantined
      expect(existsSync(registryPath)).toBe(false);
      const entries = await import("node:fs/promises").then((m) => m.readdir(tmpDir));
      const quarantined = entries.filter((e) => e.startsWith("groups.json.corrupt-"));
      expect(quarantined).toHaveLength(1);
    });

    it("disk file with key '__proto__' → load returns empty + quarantined", async () => {
      // Craft JSON with __proto__ as key via string serialization
      const raw = `{"groups":{"__proto__":{"name":"__proto__","repos":[],"created_at":1,"updated_at":1}},"updated_at":${Date.now()}}`;
      await writeFile(registryPath, raw);

      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});

      expect(existsSync(registryPath)).toBe(false);
      const entries = await import("node:fs/promises").then((m) => m.readdir(tmpDir));
      const quarantined = entries.filter((e) => e.startsWith("groups.json.corrupt-"));
      expect(quarantined).toHaveLength(1);
    });

    it("disk file with key 'constructor' → load returns empty + quarantined", async () => {
      const raw = `{"groups":{"constructor":{"name":"constructor","repos":[],"created_at":1,"updated_at":1}},"updated_at":${Date.now()}}`;
      await writeFile(registryPath, raw);

      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups).toEqual({});

      expect(existsSync(registryPath)).toBe(false);
    });

    it("well-formed file where key === group.name → loads successfully", async () => {
      const good = {
        groups: {
          mygroup: { name: "mygroup", repos: ["r1"], created_at: 1, updated_at: 1 },
        },
        updated_at: Date.now(),
      };
      await writeFile(registryPath, JSON.stringify(good));

      const reg = await loadGroupRegistry(registryPath);
      expect(reg.groups["mygroup"]).toBeDefined();
      expect(reg.groups["mygroup"]!.name).toBe("mygroup");
    });
  });
});
