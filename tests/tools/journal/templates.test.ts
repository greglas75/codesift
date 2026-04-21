import { describe, it, expect } from "vitest";
import type { PhasePlan } from "../../../src/tools/journal-phase-detector.js";
import type { GitCommit } from "../../../src/tools/journal-git-client.js";
import {
  renderPhaseSummaryPrompt,
  renderEntryPrompt,
  validateLlmResponse,
  buildScaffoldResponse,
} from "../../../src/tools/journal-templates.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const makeCommit = (sha: string, subject: string, date = "2026-04-15T10:00:00Z"): GitCommit => ({
  sha,
  date,
  authorName: "Dev",
  subject,
  parentShas: [],
  refs: [],
});

const phase: PhasePlan = {
  slug: "auth-refactor",
  title: "Auth Refactor",
  startDate: "2026-04-10",
  endDate: "2026-04-15",
  commits: [
    makeCommit("abc1234abc1234", "feat(auth): add JWT validation"),
    makeCommit("def5678def5678", "fix(auth): handle token expiry"),
  ],
  source: "auto",
};

const VALID_FOUR_BEAT = `## Intent
We wanted to refactor auth.

## Reality
We added JWT and fixed expiry.

## Significance
Auth is now more secure.

## Lessons
Always test edge cases.`;

// ── (a) renderPhaseSummaryPrompt ──────────────────────────────────────────────

describe("renderPhaseSummaryPrompt", () => {
  it("(a) contains short SHAs, subjects, date range, and 4-beat instruction block", () => {
    const prompt = renderPhaseSummaryPrompt(phase);

    // short SHAs (7 chars)
    expect(prompt).toContain("abc1234");
    expect(prompt).not.toContain("abc1234abc1234"); // must be truncated
    expect(prompt).toContain("def5678");

    // commit subjects
    expect(prompt).toContain("feat(auth): add JWT validation");
    expect(prompt).toContain("fix(auth): handle token expiry");

    // date range
    expect(prompt).toContain("2026-04-10 → 2026-04-15");

    // 4-beat instruction block mentions all 4 anchors
    expect(prompt).toContain("## Intent");
    expect(prompt).toContain("## Reality");
    expect(prompt).toContain("## Significance");
    expect(prompt).toContain("## Lessons");
  });
});

// ── (b) renderEntryPrompt ─────────────────────────────────────────────────────

describe("renderEntryPrompt", () => {
  it("(b) contains date, each commit short SHA + subject, and 4-beat instructions", () => {
    const commits = [
      makeCommit("aaa1111aaa1111", "refactor(ui): split component"),
      makeCommit("bbb2222bbb2222", "test(ui): add snapshot tests"),
    ];
    const prompt = renderEntryPrompt("2026-04-15", commits);

    expect(prompt).toContain("2026-04-15");

    expect(prompt).toContain("aaa1111");
    expect(prompt).not.toContain("aaa1111aaa1111"); // truncated
    expect(prompt).toContain("bbb2222");

    expect(prompt).toContain("refactor(ui): split component");
    expect(prompt).toContain("test(ui): add snapshot tests");

    expect(prompt).toContain("## Intent");
    expect(prompt).toContain("## Reality");
    expect(prompt).toContain("## Significance");
    expect(prompt).toContain("## Lessons");
  });
});

// ── (c) validateLlmResponse — accepts valid ───────────────────────────────────

describe("validateLlmResponse", () => {
  it("(c) accepts well-formed 4-beat response in correct order", () => {
    const result = validateLlmResponse(VALID_FOUR_BEAT);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ── (d) rejects missing anchors (4 sub-cases) ──────────────────────────────

  it("(d1) rejects response missing ## Intent", () => {
    const text = VALID_FOUR_BEAT.replace("## Intent", "## Intro");
    const result = validateLlmResponse(text);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Intent/);
  });

  it("(d2) rejects response missing ## Reality", () => {
    const text = VALID_FOUR_BEAT.replace("## Reality", "## Facts");
    const result = validateLlmResponse(text);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Reality/);
  });

  it("(d3) rejects response missing ## Significance", () => {
    const text = VALID_FOUR_BEAT.replace("## Significance", "## Impact");
    const result = validateLlmResponse(text);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Significance/);
  });

  it("(d4) rejects response missing ## Lessons", () => {
    const text = VALID_FOUR_BEAT.replace("## Lessons", "## Takeaways");
    const result = validateLlmResponse(text);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Lessons/);
  });

  // ── (e) rejects out-of-order anchors ───────────────────────────────────────

  it("(e) rejects response with anchors out of order (Reality before Intent)", () => {
    const outOfOrder = `## Reality
We added JWT.

## Intent
We wanted to refactor auth.

## Significance
Auth is now more secure.

## Lessons
Always test edge cases.`;
    const result = validateLlmResponse(outOfOrder);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/order/i);
  });
});

// ── (f) buildScaffoldResponse ─────────────────────────────────────────────────

describe("buildScaffoldResponse", () => {
  it("(f) produces 4-beat markdown with TODO placeholders under each H2", () => {
    const scaffold = buildScaffoldResponse(phase);

    const placeholder = "<!-- TODO: journal provider not configured -->";

    expect(scaffold).toContain("## Intent");
    expect(scaffold).toContain("## Reality");
    expect(scaffold).toContain("## Significance");
    expect(scaffold).toContain("## Lessons");

    // Each H2 section has its own placeholder
    const sections = ["Intent", "Reality", "Significance", "Lessons"];
    for (const section of sections) {
      const sectionStart = scaffold.indexOf(`## ${section}`);
      expect(sectionStart).toBeGreaterThan(-1);
      const afterSection = scaffold.slice(sectionStart);
      expect(afterSection).toContain(placeholder);
    }

    // source_commits footer line with short SHAs
    expect(scaffold).toContain("<!-- source_commits: abc1234, def5678 -->");
  });
});

// ── (g) prompts include source_commits guidance ───────────────────────────────

describe("source_commits guidance in prompts", () => {
  it("(g) renderPhaseSummaryPrompt contains source_commits instruction", () => {
    const prompt = renderPhaseSummaryPrompt(phase);
    expect(prompt).toContain("source_commits");
  });

  it("(g2) renderEntryPrompt contains source_commits instruction", () => {
    const commits = [makeCommit("ccc3333ccc3333", "chore: update deps")];
    const prompt = renderEntryPrompt("2026-04-16", commits);
    expect(prompt).toContain("source_commits");
  });
});
