import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { checkBoundaries } from "../../src/tools/boundary-tools.js";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

let repo: string;
let testDir: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "codesift-boundary-data-"));
  process.env["CODESIFT_DATA_DIR"] = path.join(dataDir, ".codesift");
  resetConfigCache();

  testDir = mkdtempSync(path.join(tmpdir(), "boundary-test-"));
  execSync("git init", { cwd: testDir, stdio: "ignore" });
  execSync("git config user.email test@test.com && git config user.name Test", { cwd: testDir, stdio: "ignore" });

  // Create layered architecture:
  // domain/ — pure business logic, should not import infrastructure/
  // application/ — use cases, can import domain/
  // infrastructure/ — DB, HTTP, can import domain/ and application/
  mkdirSync(path.join(testDir, "src/domain"), { recursive: true });
  mkdirSync(path.join(testDir, "src/application"), { recursive: true });
  mkdirSync(path.join(testDir, "src/infrastructure"), { recursive: true });

  writeFileSync(path.join(testDir, "src/domain/user.ts"),
    `export interface User { id: string; name: string; }\n`);

  writeFileSync(path.join(testDir, "src/domain/order.ts"),
    `import type { User } from "./user.js";\nexport interface Order { user: User; total: number; }\n`);

  writeFileSync(path.join(testDir, "src/application/create-order.ts"),
    `import type { Order } from "../domain/order.js";\nexport function createOrder(): Order { return {} as Order; }\n`);

  // Violation: domain imports infrastructure
  writeFileSync(path.join(testDir, "src/domain/bad-dependency.ts"),
    `import { saveToDb } from "../infrastructure/db.js";\nexport function persist() { saveToDb(); }\n`);

  writeFileSync(path.join(testDir, "src/infrastructure/db.ts"),
    `export function saveToDb() {}\n`);

  writeFileSync(path.join(testDir, "src/infrastructure/api.ts"),
    `import { createOrder } from "../application/create-order.js";\nexport function handleRequest() { createOrder(); }\n`);

  execSync("git add -A && git commit -m init", { cwd: testDir, stdio: "ignore" });
  const result = await indexFolder(testDir, { watch: false });
  repo = result.repo;
}, 30_000);

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("checkBoundaries", () => {
  it("detects cannot_import violation", async () => {
    const result = await checkBoundaries(repo, [
      { from: "src/domain", cannot_import: ["src/infrastructure"] },
    ]);

    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0]!.file).toContain("domain/bad-dependency");
    expect(result.violations[0]!.imports).toContain("infrastructure/db");
  });

  it("passes when no violations exist", async () => {
    const result = await checkBoundaries(repo, [
      { from: "src/application", cannot_import: ["src/infrastructure"] },
    ]);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("checks can_only_import allowlist", async () => {
    const result = await checkBoundaries(repo, [
      { from: "src/domain", can_only_import: ["src/domain"] },
    ]);

    expect(result.passed).toBe(false);
    // domain/bad-dependency imports infrastructure — not in allowlist
    const infraViolation = result.violations.find((v) => v.imports.includes("infrastructure"));
    expect(infraViolation).toBeDefined();
  });

  it("allows imports within same layer with can_only_import", async () => {
    const result = await checkBoundaries(repo, [
      { from: "src/application", can_only_import: ["src/domain", "src/application"] },
    ]);

    expect(result.passed).toBe(true);
  });

  it("returns empty result for empty rules", async () => {
    const result = await checkBoundaries(repo, []);
    expect(result.passed).toBe(true);
    expect(result.edges_checked).toBe(0);
  });

  it("reports edges_checked and rules_applied counts", async () => {
    const result = await checkBoundaries(repo, [
      { from: "src/domain", cannot_import: ["src/infrastructure"] },
      { from: "src/application", cannot_import: ["src/infrastructure"] },
    ]);

    expect(result.edges_checked).toBeGreaterThan(0);
    expect(result.rules_applied).toBe(2);
  });

  it("throws on missing repo", async () => {
    await expect(
      checkBoundaries("local/nonexistent", [{ from: "x", cannot_import: ["y"] }]),
    ).rejects.toThrow("Repository not found");
  });
});
