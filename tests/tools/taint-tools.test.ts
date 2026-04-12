import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { taintTrace } from "../../src/tools/taint-tools.js";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-taint-tools-"));
  fixtureDir = join(tmpDir, "python-taint-project");
  await mkdir(fixtureDir, { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function writeFixture(files: Record<string, string>): Promise<string> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = join(fixtureDir, relativePath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content);
  }
  return (await indexFolder(fixtureDir, { watch: false })).repo;
}

describe("taintTrace", () => {
  it("finds direct Django request-to-mark_safe flows", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/views.py": `from django.utils.safestring import mark_safe

def render_html(request):
    value = request.GET["html"]
    return mark_safe(value)
`,
    });

    const result = await taintTrace(repo, {
      file_pattern: "app/views.py",
      sink_patterns: ["mark_safe"],
    });

    expect(result.framework).toBe("python-django");
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({
      entry_symbol: "render_html",
      source: {
        kind: "request.GET",
        file: "app/views.py",
      },
      sink: {
        kind: "mark_safe",
        file: "app/views.py",
      },
      confidence: "high",
      heuristic: false,
    });
  });

  it("follows tainted arguments through imported helper functions", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/helpers.py": `from django.utils.safestring import mark_safe

def wrap_html(value):
    return mark_safe(value)
`,
      "app/views.py": `from .helpers import wrap_html

def render_html(request):
    html = request.POST.get("html")
    return wrap_html(html)
`,
    });

    const result = await taintTrace(repo, {
      file_pattern: "app/",
      sink_patterns: ["mark_safe"],
    });

    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({
      entry_symbol: "render_html",
      entry_file: "app/views.py",
      source: {
        kind: "request.POST",
        file: "app/views.py",
      },
      sink: {
        kind: "mark_safe",
        file: "app/helpers.py",
        symbol_name: "wrap_html",
      },
      heuristic: false,
    });
    expect(result.traces[0]!.hops.some((hop) => hop.kind === "call" && hop.detail.includes("wrap_html"))).toBe(true);
  });

  it("detects session writes fed by request input", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/oauth.py": `def authorize(request):
    next_url = request.GET["next"]
    request.session["oauth-state"] = next_url
    return next_url
`,
    });

    const result = await taintTrace(repo, {
      file_pattern: "app/oauth.py",
      sink_patterns: ["session-write"],
    });

    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({
      sink: {
        kind: "session-write",
        file: "app/oauth.py",
      },
      source: {
        kind: "request.GET",
      },
    });
  });

  it("supports sink filtering without emitting unrelated traces", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/views.py": `from django.utils.safestring import mark_safe

def render_html(request):
    html = request.GET["html"]
    request.session["html"] = html
    return mark_safe(html)
`,
    });

    const sessionOnly = await taintTrace(repo, {
      file_pattern: "app/views.py",
      sink_patterns: ["session-write"],
    });

    expect(sessionOnly.traces).toHaveLength(1);
    expect(sessionOnly.traces[0]!.sink.kind).toBe("session-write");
  });

  it("returns no traces when sink input is not user-controlled", async () => {
    const repo = await writeFixture({
      "app/__init__.py": "",
      "app/views.py": `from django.utils.safestring import mark_safe

SAFE = "<b>hello</b>"

def render_html():
    return mark_safe(SAFE)
`,
    });

    const result = await taintTrace(repo, {
      file_pattern: "app/views.py",
      sink_patterns: ["mark_safe"],
    });

    expect(result.traces).toEqual([]);
  });
});
