import type { PhasePlan } from "./journal-phase-detector.js";
import type { GitCommit } from "./journal-git-client.js";

// ── CQ14: 4-beat anchor list — single source of truth ────────────────────────

const FOUR_BEAT_ANCHORS = ["Intent", "Reality", "Significance", "Lessons"] as const;
type Beat = (typeof FOUR_BEAT_ANCHORS)[number];

const FOUR_BEAT_INSTRUCTION = `Produce exactly these four H2 sections in order:
## Intent
## Reality
## Significance
## Lessons

End your response with this footer line (no trailing space):
<!-- source_commits: <comma-separated list of short 7-char SHAs> -->`;

// ── CQ25: short-SHA helper — one place ───────────────────────────────────────

const shortSha = (sha: string): string => sha.slice(0, 7);

// ── Public API ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Build a prompt asking an LLM to write a phase-level journal entry.
 * Pure: no I/O, no env reads.
 */
export function renderPhaseSummaryPrompt(phase: PhasePlan): string {
  const commitLines = phase.commits
    .map((c) => `  - ${shortSha(c.sha)}: ${c.subject}`)
    .join("\n");

  return `You are writing a developer journal entry for a phase of work.

Phase: ${phase.title}
Date range: ${phase.startDate} → ${phase.endDate}

Commits in this phase:
${commitLines}

${FOUR_BEAT_INSTRUCTION}

The source_commits footer must list these short SHAs: ${phase.commits.map((c) => shortSha(c.sha)).join(", ")}`;
}

/**
 * Build a prompt asking an LLM to write a day-level journal entry.
 * Pure: no I/O, no env reads.
 */
export function renderEntryPrompt(date: string, commits: GitCommit[]): string {
  const commitLines = commits
    .map((c) => `  - ${shortSha(c.sha)}: ${c.subject}`)
    .join("\n");

  return `You are writing a developer journal entry for a single day.

Date: ${date}

Commits on this day:
${commitLines}

${FOUR_BEAT_INSTRUCTION}

The source_commits footer must list these short SHAs: ${commits.map((c) => shortSha(c.sha)).join(", ")}`;
}

/**
 * Validate that an LLM response contains all 4 H2 anchors in the required order.
 * Returns { ok: true } on success, or { ok: false, reason } on failure.
 */
export function validateLlmResponse(text: string): ValidationResult {
  const normalized = text.replace(/\r\n/g, "\n");
  // (d) Check each anchor is present before checking order
  for (const beat of FOUR_BEAT_ANCHORS) {
    const anchorRe = new RegExp(`^## ${beat}\\s*$`, "m");
    if (!anchorRe.test(normalized)) {
      return { ok: false, reason: `Missing anchor: ## ${beat}` };
    }
  }

  // (e) Check anchors appear in the required order
  const positions = FOUR_BEAT_ANCHORS.map((beat): [Beat, number] => {
    const idx = normalized.search(new RegExp(`^## ${beat}\\s*$`, "m"));
    return [beat, idx];
  });

  for (let i = 1; i < positions.length; i++) {
    const [prevBeat, prevIdx] = positions[i - 1]!;
    const [curBeat, curIdx] = positions[i]!;
    if (curIdx <= prevIdx) {
      return {
        ok: false,
        reason: `Anchors out of order: ## ${prevBeat} must appear before ## ${curBeat}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Build a scaffold (placeholder) response for when no LLM provider is configured.
 * Emits the exact 4-beat structure with TODO comments.
 * Pure: no I/O.
 */
export function buildScaffoldResponse(phase: PhasePlan): string {
  const placeholder = "<!-- TODO: journal provider not configured -->";
  const sourceCommits = phase.commits.map((c) => shortSha(c.sha)).join(", ");

  const sections = FOUR_BEAT_ANCHORS.map(
    (beat) => `## ${beat}\n${placeholder}`,
  ).join("\n\n");

  return `${sections}\n\n<!-- source_commits: ${sourceCommits} -->`;
}
