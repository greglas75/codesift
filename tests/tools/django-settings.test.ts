import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { analyzeDjangoSettings } from "../../src/tools/django-settings.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function setupFixture(content: string, filename = "settings.py"): string {
  const dir = mkdtempSync(join(tmpdir(), "django-settings-test-"));
  const subdir = join(dir, "myapp");
  mkdirSync(subdir, { recursive: true });
  const filePath = join(subdir, filename);
  writeFileSync(filePath, content);
  return dir;
}

function makeIndex(root: string, relPath: string): CodeIndex {
  return {
    repo: "test",
    root,
    symbols: [],
    files: [{
      path: relPath,
      language: "python",
      symbol_count: 0,
      last_modified: Date.now(),
    }],
    created_at: Date.now(),
    updated_at: Date.now(),
    symbol_count: 0,
    file_count: 1,
  };
}

describe("analyzeDjangoSettings", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("detects DEBUG = True", async () => {
    const root = setupFixture(`
DEBUG = True
ALLOWED_HOSTS = ['example.com']
SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    const finding = result.findings.find((f) => f.rule === "debug-enabled");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
  });

  it("detects empty ALLOWED_HOSTS", async () => {
    const root = setupFixture(`
DEBUG = False
ALLOWED_HOSTS = []
SECRET_KEY = os.environ.get('KEY')
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    expect(result.findings.find((f) => f.rule === "empty-allowed-hosts")).toBeDefined();
  });

  it("detects hardcoded SECRET_KEY", async () => {
    const root = setupFixture(`
DEBUG = False
ALLOWED_HOSTS = ['example.com']
SECRET_KEY = 'django-insecure-abc123'
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    const finding = result.findings.find((f) => f.rule === "hardcoded-secret-key");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
  });

  it("detects weak SECRET_KEY values", async () => {
    const root = setupFixture(`
SECRET_KEY = 'django-insecure-default-value'
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    expect(result.findings.find((f) => f.rule === "weak-secret-key")).toBeDefined();
  });

  it("detects missing CSRF middleware", async () => {
    const root = setupFixture(`
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.middleware.common.CommonMiddleware',
]
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    expect(result.findings.find((f) => f.rule === "missing-csrf-middleware")).toBeDefined();
  });

  it("detects wildcard ALLOWED_HOSTS", async () => {
    const root = setupFixture(`ALLOWED_HOSTS = ['*']`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    expect(result.findings.find((f) => f.rule === "wildcard-allowed-hosts")).toBeDefined();
  });

  it("detects CORS_ALLOW_ALL_ORIGINS = True", async () => {
    const root = setupFixture(`CORS_ALLOW_ALL_ORIGINS = True`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    expect(result.findings.find((f) => f.rule === "cors-wildcard")).toBeDefined();
  });

  it("clean settings produces no critical findings", async () => {
    const root = setupFixture(`
import os
DEBUG = False
ALLOWED_HOSTS = ['example.com']
SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
]
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000
X_FRAME_OPTIONS = 'DENY'
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    const critical = result.findings.filter((f) => f.severity === "critical");
    expect(critical).toHaveLength(0);
  });

  it("groups findings by severity", async () => {
    const root = setupFixture(`
DEBUG = True
ALLOWED_HOSTS = ['*']
SECRET_KEY = 'hardcoded'
`);
    mockedGetCodeIndex.mockResolvedValue(makeIndex(root, "myapp/settings.py"));

    const result = await analyzeDjangoSettings("test");
    expect(result.by_severity.critical).toBeGreaterThanOrEqual(2);
    expect(result.by_severity.high).toBeGreaterThanOrEqual(1);
  });
});
