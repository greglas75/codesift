/**
 * Direct unit tests for resolvePhpService.
 *
 * resolvePhpService reads config/*.php from disk (not just the symbol
 * index), so we use a real fixture via indexFolder rather than vi.mock.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resolvePhpService } from "../../src/tools/php-tools.js";

const FIXTURE_ROOT = resolve(join(__dirname, "..", "fixtures", "php-services"));
const REPO = "local/php-services";

describe("resolvePhpService", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("parses 'componentName' => ['class' => 'FQCN'] from config/web.php", async () => {
    const r = await resolvePhpService(REPO);
    expect(r.total).toBeGreaterThanOrEqual(3);
    const names = r.services.map((s) => s.name).sort();
    expect(names).toEqual(expect.arrayContaining(["db", "mailer", "user"]));
  });

  it("resolves FQCN to file path via PSR-4 when the file exists in the index", async () => {
    const r = await resolvePhpService(REPO);
    const mailer = r.services.find((s) => s.name === "mailer");
    expect(mailer).toBeDefined();
    expect(mailer!.class).toBe("app\\components\\Mailer");
    // PSR-4 map "app\\" → "./" means the FQCN resolves to components/Mailer.php
    expect(mailer!.file).toContain("components/Mailer.php");
  });

  it("parses component classes written as ClassName::class", async () => {
    const r = await resolvePhpService(REPO);
    const formatter = r.services.find((s) => s.name === "formatter");
    expect(formatter).toBeDefined();
    expect(formatter!.class).toBe("\\app\\components\\Formatter");
    expect(formatter!.file).toContain("components/Formatter.php");
  });

  it("returns null file for services whose class file is not in the index", async () => {
    const r = await resolvePhpService(REPO);
    // `db` points at yii\db\Connection which is NOT in the fixture index
    const db = r.services.find((s) => s.name === "db");
    expect(db).toBeDefined();
    expect(db!.class).toBe("yii\\db\\Connection");
    expect(db!.file).toBeNull();
  });

  it("reports the source config_file for each service", async () => {
    const r = await resolvePhpService(REPO);
    for (const s of r.services) {
      expect(s.config_file).toContain("config/web.php");
    }
  });

  it("filters by service_name option", async () => {
    const r = await resolvePhpService(REPO, { service_name: "user" });
    expect(r.total).toBe(1);
    expect(r.services[0]?.name).toBe("user");
    expect(r.services[0]?.class).toBe("app\\components\\UserComponent");
  });
});

describe("resolvePhpService — Sprint 3 (modules + container + factories)", () => {
  it("resolves module-scoped component with source label module:<id>", async () => {
    const r = await resolvePhpService(REPO);
    const notifier = r.services.find((s) => s.name === "notifier");
    expect(notifier).toBeDefined();
    expect(notifier!.class).toBe("app\\modules\\review\\components\\Notifier");
    expect(notifier!.source).toBe("module:review");
  });

  it("resolves container singletons", async () => {
    const r = await resolvePhpService(REPO);
    const logger = r.services.find(
      (s) => s.name === "app\\interfaces\\LoggerInterface" || s.class === "app\\components\\FileLogger",
    );
    expect(logger).toBeDefined();
    expect(logger!.source).toMatch(/container/);
  });

  it("surfaces factory closures with is_factory=true and class=null", async () => {
    const r = await resolvePhpService(REPO);
    const cb = r.services.find((s) => s.name === "cacheBuilder");
    expect(cb).toBeDefined();
    expect(cb!.is_factory).toBe(true);
    expect(cb!.class).toBeNull();
  });

  it("non-module components still tagged source=components", async () => {
    const r = await resolvePhpService(REPO);
    const db = r.services.find((s) => s.name === "db");
    expect(db).toBeDefined();
    expect(db!.source).toBe("components");
  });
});
