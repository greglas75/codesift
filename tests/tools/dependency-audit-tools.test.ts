import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MUST be before imports so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

// Callback-style mock: promisify(execFile) will pick up the (err, result) callback
// and resolve with the result argument.
interface ExecFileCallback {
  (err: Error | null, result: { stdout: string; stderr: string }): void;
}

type ExecFileHandler = (
  cmd: string,
  args: readonly string[],
  opts: unknown,
) => { stdout: string; stderr: string } | Error;

// Per-test handler — defaults to empty stdout
let execFileHandler: ExecFileHandler = () => ({ stdout: "", stderr: "" });

vi.mock("node:child_process", () => ({
  execFile: vi.fn((cmd: string, args: readonly string[], opts: unknown, cb: ExecFileCallback) => {
    try {
      const result = execFileHandler(cmd, args, opts);
      if (result instanceof Error) {
        // Pass the error; some errors carry a stdout property (npm audit non-zero exit)
        cb(result as Error & { stdout?: string }, { stdout: "", stderr: "" });
        return;
      }
      cb(null, result);
    } catch (err) {
      cb(err as Error, { stdout: "", stderr: "" });
    }
  }),
}));

// Mock fs/promises for readFile + stat
const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();
const mockStat = vi.fn<(path: string) => Promise<unknown>>();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(args[0] as string, args[1] as string),
  stat: (...args: unknown[]) => mockStat(args[0] as string),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock)
// ---------------------------------------------------------------------------

import { dependencyAudit } from "../../src/tools/dependency-audit-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import type { CodeIndex, FileEntry } from "../../src/types.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFile(path: string): FileEntry {
  return {
    path,
    language: "typescript",
    symbol_count: 0,
    last_modified: Date.now(),
  };
}

function makeFakeIndex(overrides: Partial<CodeIndex> = {}): CodeIndex {
  return {
    repo: "test",
    root: "/test/repo",
    symbols: [],
    files: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 0,
    ...overrides,
  };
}

/** Install a set of virtual files — stat succeeds if the path is listed. */
function installFs(files: Record<string, string | null>): void {
  mockStat.mockImplementation(async (path: string) => {
    if (path in files && files[path] !== null) {
      return { size: 0, mtimeMs: Date.now() };
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  mockReadFile.mockImplementation(async (path: string) => {
    if (path in files && files[path] !== null) return files[path] as string;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dependencyAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileHandler = () => ({ stdout: "", stderr: "" });
    mockedGetCodeIndex.mockResolvedValue(makeFakeIndex());
    installFs({});
  });

  it("throws when repo index is not found", async () => {
    mockedGetCodeIndex.mockResolvedValue(null);
    await expect(dependencyAudit("missing")).rejects.toThrow(/not found/i);
  });

  it("detects npm from package-lock.json", async () => {
    installFs({
      "/test/repo/package-lock.json": "{}",
    });

    const result = await dependencyAudit("test");
    expect(result.package_manager).toBe("npm");
    expect(result.workspace).toBe("/test/repo");
  });

  it("detects pnpm from pnpm-lock.yaml", async () => {
    installFs({
      "/test/repo/pnpm-lock.yaml": "lockfileVersion: 6",
    });

    const result = await dependencyAudit("test");
    expect(result.package_manager).toBe("pnpm");
  });

  it("returns unknown package_manager when no lockfile found", async () => {
    installFs({});
    const result = await dependencyAudit("test");
    expect(result.package_manager).toBe("unknown");
    expect(result.errors.some((e) => e.includes("package_manager"))).toBe(true);
    // Lockfile sub-check reports missing
    expect(result.lockfile.issues.some((i) => i.type === "missing")).toBe(true);
  });

  it("parses npm audit JSON output → vulnerabilities aggregated", async () => {
    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
    });

    const auditJson = JSON.stringify({
      vulnerabilities: {
        "lodash": {
          severity: "high",
          via: ["CVE-2021-23337"],
          fixAvailable: true,
          url: "https://github.com/advisories/GHSA-xxx",
        },
        "minimist": {
          severity: "critical",
          via: [{ name: "CVE-2021-44906" }],
          fixAvailable: false,
        },
        "chalk": {
          severity: "low",
          via: ["advisory-1"],
          fixAvailable: true,
        },
      },
    });

    execFileHandler = (cmd, args) => {
      if (cmd === "npm" && args[0] === "audit") return { stdout: auditJson, stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const result = await dependencyAudit("test");

    expect(result.vulnerabilities.total).toBe(3);
    expect(result.vulnerabilities.by_severity.critical).toBe(1);
    expect(result.vulnerabilities.by_severity.high).toBe(1);
    expect(result.vulnerabilities.by_severity.low).toBe(1);
    expect(result.vulnerabilities.findings).toHaveLength(3);

    // Critical sorted first
    expect(result.vulnerabilities.findings[0]?.package).toBe("minimist");
    expect(result.vulnerabilities.findings[0]?.severity).toBe("critical");
    expect(result.vulnerabilities.findings[0]?.via).toEqual(["CVE-2021-44906"]);
    expect(result.vulnerabilities.findings[0]?.fix_available).toBe(false);

    // advisory_url preserved
    const lodash = result.vulnerabilities.findings.find((f) => f.package === "lodash");
    expect(lodash?.advisory_url).toContain("github.com");
  });

  it("respects min_severity filter", async () => {
    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
    });

    const auditJson = JSON.stringify({
      vulnerabilities: {
        "a": { severity: "low", via: ["x"], fixAvailable: true },
        "b": { severity: "critical", via: ["y"], fixAvailable: true },
      },
    });

    execFileHandler = (cmd, args) => {
      if (cmd === "npm" && args[0] === "audit") return { stdout: auditJson, stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const result = await dependencyAudit("test", { min_severity: "high" });

    expect(result.vulnerabilities.total).toBe(1);
    expect(result.vulnerabilities.findings[0]?.package).toBe("b");
  });

  it("parses npm outdated JSON → outdated_count + major_gaps", async () => {
    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
    });

    const outdatedJson = JSON.stringify({
      "react": { current: "17.0.2", wanted: "17.0.2", latest: "19.0.0" },
      "lodash": { current: "4.17.20", wanted: "4.17.21", latest: "4.17.21" },
      "vitest": { current: "1.2.0", wanted: "1.2.0", latest: "3.0.0" },
    });

    execFileHandler = (cmd, args) => {
      if (cmd === "npm" && args[0] === "outdated") return { stdout: outdatedJson, stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const result = await dependencyAudit("test");

    expect(result.freshness.outdated_count).toBe(3);
    // Sorted by gap descending
    expect(result.freshness.major_gaps[0]?.package).toBe("react");
    expect(result.freshness.major_gaps[0]?.major_gap).toBe(2);
    expect(result.freshness.major_gaps[1]?.package).toBe("vitest");
    expect(result.freshness.major_gaps[1]?.major_gap).toBe(2);
    expect(result.freshness.major_gaps[2]?.major_gap).toBe(0);
  });

  it("detects problematic licenses (GPL-3.0 in node_modules)", async () => {
    mockedGetCodeIndex.mockResolvedValue(
      makeFakeIndex({
        files: [
          makeFile("node_modules/gpl-pkg/package.json"),
          makeFile("node_modules/mit-pkg/package.json"),
          makeFile("node_modules/@scope/agpl-pkg/package.json"),
          makeFile("node_modules/nested/deeply/package.json"), // not depth 2 or 3 — skipped
          makeFile("src/index.ts"), // not a package manifest
        ],
      }),
    );

    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
      "/test/repo/node_modules/gpl-pkg/package.json": JSON.stringify({
        name: "gpl-pkg",
        license: "GPL-3.0",
      }),
      "/test/repo/node_modules/mit-pkg/package.json": JSON.stringify({
        name: "mit-pkg",
        license: "MIT",
      }),
      "/test/repo/node_modules/@scope/agpl-pkg/package.json": JSON.stringify({
        name: "@scope/agpl-pkg",
        license: { type: "AGPL-3.0" },
      }),
    });

    const result = await dependencyAudit("test");

    expect(result.licenses.total).toBe(3);
    expect(result.licenses.distribution["MIT"]).toBe(1);
    expect(result.licenses.distribution["GPL-3.0"]).toBe(1);
    expect(result.licenses.distribution["AGPL-3.0"]).toBe(1);

    const problematicNames = result.licenses.problematic.map((p) => p.package).sort();
    expect(problematicNames).toEqual(["@scope/agpl-pkg", "gpl-pkg"]);
  });

  it("lockfile missing → issue reported", async () => {
    // No lockfile present, but package.json exists
    installFs({
      "/test/repo/package.json": JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
    });

    const result = await dependencyAudit("test");

    expect(result.lockfile.present).toBe(false);
    expect(result.lockfile.issues.some((i) => i.type === "missing")).toBe(true);
  });

  it("sub-check failure doesn't crash the whole audit (errors[] populated)", async () => {
    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
    });

    // npm audit fails with a non-recoverable error (no stdout payload)
    execFileHandler = (cmd, args) => {
      if (cmd === "npm" && args[0] === "audit") {
        return new Error("network unreachable");
      }
      if (cmd === "npm" && args[0] === "outdated") {
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const result = await dependencyAudit("test");

    // Audit is still returned — just with empty vulns + error entry
    expect(result.vulnerabilities.total).toBe(0);
    expect(result.errors.some((e) => e.startsWith("vulnerabilities:"))).toBe(true);
    // Other checks still succeeded
    expect(result.package_manager).toBe("npm");
    expect(result.lockfile.present).toBe(true);
  });

  it("recovers from npm audit non-zero exit when stdout carries JSON", async () => {
    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
    });

    const auditJson = JSON.stringify({
      vulnerabilities: {
        "axios": { severity: "moderate", via: ["x"], fixAvailable: true },
      },
    });

    // Simulate npm audit returning exit code 1 but still having stdout
    execFileHandler = (cmd, args) => {
      if (cmd === "npm" && args[0] === "audit") {
        const err = new Error("Command failed: npm audit");
        (err as Error & { stdout?: string }).stdout = auditJson;
        return err;
      }
      return { stdout: "", stderr: "" };
    };

    const result = await dependencyAudit("test");

    expect(result.vulnerabilities.total).toBe(1);
    expect(result.vulnerabilities.findings[0]?.package).toBe("axios");
  });

  it("skip_licenses=true skips license sub-check entirely", async () => {
    mockedGetCodeIndex.mockResolvedValue(
      makeFakeIndex({
        files: [makeFile("node_modules/gpl-pkg/package.json")],
      }),
    );

    installFs({
      "/test/repo/package-lock.json": "{}",
      "/test/repo/package.json": JSON.stringify({ dependencies: {} }),
      "/test/repo/node_modules/gpl-pkg/package.json": JSON.stringify({
        name: "gpl-pkg",
        license: "GPL-3.0",
      }),
    });

    const result = await dependencyAudit("test", { skip_licenses: true });

    expect(result.licenses.total).toBe(0);
    expect(result.licenses.problematic).toEqual([]);
    // The node_modules package.json should NOT have been read
    const readPaths = mockReadFile.mock.calls.map((c) => c[0]);
    expect(readPaths.some((p) => p.includes("node_modules/gpl-pkg"))).toBe(false);
  });

  it("uses custom workspace_path when provided", async () => {
    installFs({
      "/custom/workspace/package-lock.json": "{}",
      "/custom/workspace/package.json": JSON.stringify({ dependencies: {} }),
    });

    const result = await dependencyAudit("test", { workspace_path: "/custom/workspace" });
    expect(result.workspace).toBe("/custom/workspace");
    expect(result.package_manager).toBe("npm");
  });

  it("parses package-lock.json and detects duplicate versions in tree", async () => {
    installFs({
      "/test/repo/package-lock.json": JSON.stringify({
        packages: {
          "": { name: "root" },
          "node_modules/react": { version: "17.0.2" },
          "node_modules/some-dep/node_modules/react": { version: "18.2.0" },
        },
      }),
      "/test/repo/package.json": JSON.stringify({
        dependencies: { react: "^17.0.0" },
      }),
    });

    const result = await dependencyAudit("test");

    expect(result.lockfile.present).toBe(true);
    const dup = result.lockfile.issues.find((i) => i.type === "duplicate");
    expect(dup).toBeDefined();
    expect(dup?.package).toBe("react");
    expect(dup?.message).toContain("17.0.2");
    expect(dup?.message).toContain("18.2.0");
  });

  it("detects version drift between manifest and lockfile", async () => {
    installFs({
      "/test/repo/package-lock.json": JSON.stringify({
        packages: {
          "": { name: "root" },
          "node_modules/lodash": { version: "3.10.0" },
        },
      }),
      "/test/repo/package.json": JSON.stringify({
        dependencies: { lodash: "^4.17.0" },
      }),
    });

    const result = await dependencyAudit("test");

    const drift = result.lockfile.issues.find((i) => i.type === "drift");
    expect(drift).toBeDefined();
    expect(drift?.package).toBe("lodash");
  });
});
