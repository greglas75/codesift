import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// In-memory fs mock — supports only the subset used by the migrator.
interface FsState {
  files: Map<string, string>;
  invocationOrder: string[];
}

const fsState: FsState = {
  files: new Map(),
  invocationOrder: [],
};

// Real fixture is loaded lazily via the unmocked `readFileSync`.
const FIXTURE_PATH = "/fixture/prototype-history.md";
const FIXTURE_CONTENT = readFileSync(
  join(process.cwd(), "tests/fixtures/journal/prototype-history.md"),
  "utf-8",
);

vi.mock("node:fs/promises", () => {
  const readFile = vi.fn(async (path: string, _enc?: string) => {
    fsState.invocationOrder.push(`readFile:${path}`);
    const v = fsState.files.get(path);
    if (v === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return v;
  });

  const writeFile = vi.fn(async (path: string, data: string) => {
    fsState.invocationOrder.push(`writeFile:${path}`);
    fsState.files.set(path, data);
  });

  const copyFile = vi.fn(async (src: string, dest: string) => {
    fsState.invocationOrder.push(`copyFile:${src}->${dest}`);
    const v = fsState.files.get(src);
    if (v === undefined) throw new Error(`ENOENT: ${src}`);
    fsState.files.set(dest, v);
  });

  const mkdir = vi.fn(async (path: string, _opts?: unknown) => {
    fsState.invocationOrder.push(`mkdir:${path}`);
    return undefined;
  });

  return { readFile, writeFile, copyFile, mkdir, default: { readFile, writeFile, copyFile, mkdir } };
});

// Import after mocks so the module picks up the mocked fs.
import { runMigrate } from "../../../src/tools/journal-migrator.js";
import * as fsPromises from "node:fs/promises";

const mockWriteFile = fsPromises.writeFile as unknown as Mock;
const mockCopyFile = fsPromises.copyFile as unknown as Mock;
const mockReadFile = fsPromises.readFile as unknown as Mock;

const REPO_ROOT = "/repo";
const OUTPUT_DIR = "/repo/.codesift/wiki";
const SOURCE = "/repo/history.md";
const STATE_PATH = "/repo/.codesift/wiki/journal/.migrate-state.json";
const GITIGNORE_PATH = "/repo/.gitignore";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function seedFixture(): void {
  fsState.files.set(SOURCE, FIXTURE_CONTENT);
}

beforeEach(() => {
  fsState.files.clear();
  fsState.invocationOrder = [];
  vi.clearAllMocks();
});

// ─── (a) dry-run: state file, mkdir, gitignore append ─────────────────────────
describe("runMigrate — dry-run", () => {
  it("computes SHA, writes .migrate-state.json, mkdirs output, appends .gitignore", async () => {
    seedFixture();
    const result = await runMigrate({
      source: SOURCE,
      repoRoot: REPO_ROOT,
      outputDir: OUTPUT_DIR,
      dryRun: true,
    });

    expect(result.status).toBe("planned");
    expect(result.phaseCount).toBe(7);

    const stateRaw = fsState.files.get(STATE_PATH);
    expect(stateRaw).toBeDefined();
    const state = JSON.parse(stateRaw!);
    expect(state.source_sha256).toBe(sha256(FIXTURE_CONTENT));
    expect(state.schema_version).toBe("1");
    expect(Array.isArray(state.planned_phase_slugs)).toBe(true);
    expect(state.planned_phase_slugs).toHaveLength(7);

    // mkdir called on the journal subfolder
    const mkdirCalls = (fsPromises.mkdir as unknown as Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(mkdirCalls.some((p) => p.includes("journal"))).toBe(true);

    // gitignore was written with the state path
    const gi = fsState.files.get(GITIGNORE_PATH);
    expect(gi).toBeDefined();
    expect(gi!.includes(".codesift/wiki/journal/.migrate-state.json")).toBe(true);
  });
});

// ─── (b) live run without state → exact message ───────────────────────────────
describe("runMigrate — live run without plan", () => {
  it("aborts with the exact no-plan message", async () => {
    seedFixture();
    await expect(
      runMigrate({
        source: SOURCE,
        repoRoot: REPO_ROOT,
        outputDir: OUTPUT_DIR,
        dryRun: false,
      }),
    ).rejects.toThrow(
      "No migration plan found. Run 'codesift journal migrate --dry-run' first to generate a migration plan, then run without --dry-run to execute.",
    );
  });
});

// ─── (c) live run with SHA mismatch ───────────────────────────────────────────
describe("runMigrate — SHA drift", () => {
  it("aborts when source changed since dry-run with hex values in message", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });

    const originalSha = sha256(FIXTURE_CONTENT);
    const mutated = FIXTURE_CONTENT + "\n<!-- drift -->\n";
    fsState.files.set(SOURCE, mutated);
    const newSha = sha256(mutated);

    await expect(
      runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false }),
    ).rejects.toThrow(
      `source file changed since dry-run (sha ${newSha} ≠ ${originalSha}), aborting`,
    );
  });
});

// ─── (d) happy path: 7 phase files with slug pattern ──────────────────────────
describe("runMigrate — happy path", () => {
  it("produces exactly 7 phase files with YYYY-MM-<slug> pattern", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    const result = await runMigrate({
      source: SOURCE,
      repoRoot: REPO_ROOT,
      outputDir: OUTPUT_DIR,
      dryRun: false,
    });

    expect(result.status).toBe("ok");
    expect(result.phaseCount).toBe(7);

    const phaseFiles = [...fsState.files.keys()].filter((p) =>
      p.startsWith("/repo/.codesift/wiki/journal/phases/") && p.endsWith(".md"),
    );
    expect(phaseFiles).toHaveLength(7);

    const slugRe = /\/phases\/(\d{4}-\d{2}-[a-z0-9-]+)\.md$/;
    for (const path of phaseFiles) {
      expect(path).toMatch(slugRe);
    }
  });
});

// ─── (e) week heading preserved verbatim as first line of My notes block ──────
describe("runMigrate — preserves week heading", () => {
  it("keeps `### Week N — Title` as first line of My notes block in each phase file", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false });

    const phaseFiles = [...fsState.files.entries()].filter(([p]) =>
      p.startsWith("/repo/.codesift/wiki/journal/phases/"),
    );

    for (const [, content] of phaseFiles) {
      const idx = content.indexOf("## My notes");
      expect(idx).toBeGreaterThan(-1);
      const after = content.slice(idx);
      const lines = after.split("\n");
      // lines[0] = "## My notes", lines[1] = blank OR header, scan for first non-blank
      const firstReal = lines.slice(1).find((l) => l.trim() !== "");
      expect(firstReal).toMatch(/^### Week \d+ — /);
    }
  });
});

// ─── (f) multi-day entry: range preserved in title line, start-date keying ────
describe("runMigrate — multi-day entry", () => {
  it("preserves `#### 2026-03-21 – 2026-03-23 — ...` range as the entry title line", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false });

    const week2Entry = [...fsState.files.values()].find((v) =>
      v.includes("2026-03-21 – 2026-03-23"),
    );
    expect(week2Entry).toBeDefined();
    // Title line must retain full range
    expect(week2Entry).toMatch(/^#### 2026-03-21 – 2026-03-23 — /m);
  });
});

// ─── (g) non-Week ## sections → migrated-overview block ───────────────────────
describe("runMigrate — overview block", () => {
  it("collects non-Week ## sections into migrated-overview manual block", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false });

    const overview = fsState.files.get("/repo/.codesift/wiki/journal/overview.md");
    expect(overview).toBeDefined();
    expect(overview!).toContain("<!-- manual:begin migrated-overview -->");
    expect(overview!).toContain("<!-- manual:end migrated-overview -->");
    expect(overview!).toContain("## At a glance");
    expect(overview!).toContain("## Themes across the project");
    expect(overview!).toContain("## Competitive context");
    expect(overview!).toContain("## Sources");
  });
});

// ─── (h) ## Timeline consumed, not migrated ───────────────────────────────────
describe("runMigrate — timeline container", () => {
  it("drops the `## Timeline` heading from all outputs", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false });

    const outputs = [...fsState.files.entries()]
      .filter(([p]) => p.startsWith("/repo/.codesift/wiki/journal/"))
      .map(([, v]) => v)
      .join("\n");
    expect(outputs).not.toMatch(/^## Timeline$/m);
  });
});

// ─── (i) .bak written BEFORE any phase file (call-order tracking) ─────────────
describe("runMigrate — .bak ordering", () => {
  it("calls copyFile(source, source.bak) before any phases/*.md writeFile", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    fsState.invocationOrder = [];
    vi.clearAllMocks();
    // Re-seed since state file was written in dry-run; keep it.
    // Note: we only cleared invocation mocks; fsState.files still holds state + source.
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false });

    const copyCall = mockCopyFile.mock.invocationCallOrder[0];
    expect(copyCall).toBeDefined();

    const phaseWriteOrders = mockWriteFile.mock.calls
      .map((call, idx) => ({ path: call[0] as string, order: mockWriteFile.mock.invocationCallOrder[idx]! }))
      .filter((c) => c.path.includes("/journal/phases/"));

    expect(phaseWriteOrders.length).toBeGreaterThan(0);
    for (const p of phaseWriteOrders) {
      expect(copyCall).toBeLessThan(p.order);
    }

    // .bak content exists
    expect(fsState.files.get(SOURCE + ".bak")).toBe(FIXTURE_CONTENT);
  });
});

// ─── (j) snapshot: normalized concatenation ≡ source minus ## Timeline ────────
describe("runMigrate — content preservation snapshot", () => {
  it("normalized My notes blocks + migrated-overview ≡ prototype minus ## Timeline line", async () => {
    seedFixture();
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: false });

    const normalize = (s: string): string =>
      s
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // Gather My notes bodies from phase files (content after "## My notes" line).
    const phaseFiles = [...fsState.files.entries()]
      .filter(([p]) => p.startsWith("/repo/.codesift/wiki/journal/phases/"))
      .sort(([a], [b]) => a.localeCompare(b));

    const myNotesBodies = phaseFiles.map(([, content]) => {
      const idx = content.indexOf("## My notes\n");
      return content.slice(idx + "## My notes\n".length);
    });

    const overview = fsState.files.get("/repo/.codesift/wiki/journal/overview.md")!;
    const ovStart = overview.indexOf("<!-- manual:begin migrated-overview -->");
    const ovEnd = overview.indexOf("<!-- manual:end migrated-overview -->");
    const overviewBody = overview.slice(
      ovStart + "<!-- manual:begin migrated-overview -->".length,
      ovEnd,
    );

    // Source minus ## Timeline single-line heading and minus the top-level "# Project History"
    // preface — the migrated output is phase+overview content only.
    const sourceNoTimeline = FIXTURE_CONTENT.split("\n")
      .filter((l) => l !== "## Timeline")
      .join("\n");

    const actual = normalize(myNotesBodies.join("\n") + "\n" + overviewBody);
    const expectedCore = normalize(sourceNoTimeline);

    // Every non-blank content line from the source (except the dropped H1 preface + blockquote)
    // should appear in the migrated output.
    const sourceLines = expectedCore
      .split("\n")
      .filter((l) => l.trim() !== "")
      .filter((l) => !l.startsWith("# Project History"))
      .filter((l) => !l.startsWith("> "));

    for (const line of sourceLines) {
      expect(actual).toContain(line);
    }
  });
});

// ─── (k) zero-Week source → abort ─────────────────────────────────────────────
describe("runMigrate — zero phases", () => {
  it("aborts when no `### Week` headings are present", async () => {
    fsState.files.set(SOURCE, "# Stub\n\n## At a glance\n\nnothing here\n");
    await expect(
      runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true }),
    ).rejects.toThrow(/no `### Week` headings|zero phases|NoPhasesError/i);
  });
});

// ─── (l) slug collision → abort ───────────────────────────────────────────────
describe("runMigrate — slug collision", () => {
  it("aborts with actionable message when two weeks produce the same slug", async () => {
    // Same title + same earliest-entry month → same slug.
    const collidingSource = [
      "# Project",
      "",
      "## Timeline",
      "",
      "### Week 1 — Foundation",
      "",
      "#### 2026-03-13 — day one",
      "body A",
      "",
      "### Week 2 — Foundation",
      "",
      "#### 2026-03-20 — day two",
      "body B",
      "",
    ].join("\n");
    fsState.files.set(SOURCE, collidingSource);
    await expect(
      runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true }),
    ).rejects.toThrow(/slug collision|SlugCollisionError/i);
  });
});

// ─── (m) .gitignore behaviors: create/idempotent/warn-on-error ────────────────
describe("runMigrate — .gitignore append behavior", () => {
  it("creates .gitignore if missing", async () => {
    seedFixture();
    // no gitignore seeded
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    const gi = fsState.files.get(GITIGNORE_PATH);
    expect(gi).toBeDefined();
    expect(gi!.trim().split("\n")).toContain(".codesift/wiki/journal/.migrate-state.json");
  });

  it("is idempotent when the line already exists", async () => {
    seedFixture();
    const existing = "node_modules\n.codesift/wiki/journal/.migrate-state.json\ndist\n";
    fsState.files.set(GITIGNORE_PATH, existing);
    await runMigrate({ source: SOURCE, repoRoot: REPO_ROOT, outputDir: OUTPUT_DIR, dryRun: true });
    expect(fsState.files.get(GITIGNORE_PATH)).toBe(existing);
  });

  it("emits WARN but still succeeds when .gitignore write fails", async () => {
    seedFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Make writeFile throw ONLY for gitignore.
    const originalWrite = mockWriteFile.getMockImplementation();
    mockWriteFile.mockImplementation(async (path: string, data: string) => {
      if (path === GITIGNORE_PATH) {
        throw new Error("EACCES: permission denied");
      }
      fsState.invocationOrder.push(`writeFile:${path}`);
      fsState.files.set(path, data);
    });

    const result = await runMigrate({
      source: SOURCE,
      repoRoot: REPO_ROOT,
      outputDir: OUTPUT_DIR,
      dryRun: true,
    });

    expect(result.status).toBe("planned");
    expect(warn).toHaveBeenCalled();
    const warnArgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnArgs).toContain("WARN journal: could not update .gitignore");

    warn.mockRestore();
    if (originalWrite) mockWriteFile.mockImplementation(originalWrite);
  });
});
